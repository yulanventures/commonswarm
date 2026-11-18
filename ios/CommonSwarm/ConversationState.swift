import Combine
import Foundation

@MainActor
final class Composer: ObservableObject {
    @Published var text = ""
    @Published private(set) var sending = false
    enum Failure { case refused, unconfirmed }
    @Published private(set) var failure: Failure?
    private(set) var submission: Post?

    func begin(workspace: UUID, destination: Conversation.Destination) -> Post? {
        guard !sending else { return nil }
        if submission == nil {
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf16.count <= 8_000 else { return nil }
            submission = Post(id: UUID(), workspace: workspace, destination: destination, body: text)
        }
        sending = true
        return submission
    }

    func accepted() {
        if text == submission?.body { text = "" }
        submission = nil
        sending = false
        failure = nil
    }

    func failed(with error: Error) {
        sending = false
        // A refusal on a retry can precede receipt lookup. It cannot settle an earlier attempt.
        if failure != .unconfirmed, case APIError.refused(let status) = error,
           (400..<500).contains(status), status != 408 {
            submission = nil
            failure = .refused
        } else {
            failure = .unconfirmed
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
              destination: Conversation.Destination) async -> Bool {
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
