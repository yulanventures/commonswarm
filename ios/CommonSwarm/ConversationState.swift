import Combine
import Foundation

@MainActor
final class Composer: ObservableObject {
    @Published var text = ""
    enum Delivery { case sending, retrying, unconfirmed, refused, accepted(UUID) }

    struct Outgoing: Identifiable {
        let post: Post
        let createdAt = Date()
        var delivery: Delivery = .sending
        var id: UUID { post.command_id }
    }
    @Published private(set) var outgoing: [Outgoing] = []

    func begin(workspace: UUID, destination: Conversation.Destination) -> Post? {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf16.count <= 8_000 else { return nil }
        let post = Post(id: UUID(), workspace: workspace, destination: destination, body: text)
        outgoing.append(Outgoing(post: post))
        text = ""
        return post
    }

    func retry(_ id: UUID) -> Post? {
        guard let i = outgoing.firstIndex(where: { $0.id == id }), case .unconfirmed = outgoing[i].delivery else { return nil }
        outgoing[i].delivery = .retrying
        return outgoing[i].post
    }

    func editRefused(_ id: UUID) {
        guard text.isEmpty, let i = outgoing.firstIndex(where: { $0.id == id }),
              case .refused = outgoing[i].delivery else { return }
        text = outgoing.remove(at: i).post.body ?? ""
    }

    func accepted(_ id: UUID, signalID: UUID) {
        guard let i = outgoing.firstIndex(where: { $0.id == id }) else { return }
        outgoing[i].delivery = .accepted(signalID)
    }

    func reconcile(_ messages: [Message]) {
        let ids = Set(messages.map(\.id))
        outgoing.removeAll { row in
            if case .accepted(let id) = row.delivery { return ids.contains(id) }
            return false
        }
    }

    func failed(_ id: UUID, with error: Error) {
        guard let i = outgoing.firstIndex(where: { $0.id == id }) else { return }
        // A refusal before receipt lookup cannot settle a previous uncertain attempt.
        if case .sending = outgoing[i].delivery, case APIError.refused(let status) = error,
           (400..<500).contains(status), status != 408 {
            outgoing[i].delivery = .refused
        } else {
            outgoing[i].delivery = .unconfirmed
        }
    }
}

// Requests keep their cursor so Retry repeats the operation the reader selected.
@MainActor
final class MessageHistory: ObservableObject {
    enum Page { case latest, older(before: Message) }
    @Published private(set) var messages: [Message]?
    @Published private(set) var hasOlder = false
    @Published private(set) var retry: Page?
    @Published private(set) var loadingOlder = false
    private var requestID = UUID()

    @discardableResult
    func load(_ request: Page, api: ConversationAPI, workspace: UUID,
              destination: Conversation.Destination, beforePrepend: () -> Void = {}) async -> Bool {
        let id = UUID()
        requestID = id
        let current = messages ?? []
        let known = Set(current.map(\.id))
        defer { if requestID == id { loadingOlder = false } }
        do {
            switch request {
            case .latest:
                loadingOlder = false
                var page = try await api.history(workspace, destination)
                let firstPageCount = page.count
                var newest = page
                // A long absence can put an entire page between the two windows.
                // Read back to their intersection before attaching the new messages.
                while !known.isEmpty && page.count == ConversationAPI.pageSize &&
                        !page.contains(where: { known.contains($0.id) }), let before = page.first {
                    guard id == requestID else { return false }
                    try Task.checkCancellation()
                    page = try await api.history(workspace, destination, before: before)
                    newest.insert(contentsOf: page, at: 0)
                }
                try Task.checkCancellation()
                guard id == requestID, api.session.isActive else { return false }
                if current.isEmpty { hasOlder = firstPageCount == ConversationAPI.pageSize }
                messages = current + newest.filter { !known.contains($0.id) }
                if case .latest = retry { retry = nil }
            case .older(let before):
                loadingOlder = true
                let page = try await api.history(workspace, destination, before: before)
                try Task.checkCancellation()
                guard id == requestID, api.session.isActive else { return false }
                beforePrepend()
                messages = page.filter { !known.contains($0.id) } + current
                hasOlder = page.count == ConversationAPI.pageSize
                retry = nil
            }
            return true
        } catch {
            if id == requestID && !Task.isCancelled && api.session.isActive { retry = request }
            return false
        }
    }
}
