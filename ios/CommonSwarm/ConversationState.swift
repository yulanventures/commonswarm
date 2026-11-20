import Combine
import Foundation

@MainActor
final class Composer: ObservableObject {
    enum Access { case checking, joined, preview, unavailable }
    @Published private(set) var access: Access
    private var lastRead = 0
    init(access: Access = .joined) { self.access = access }

    @discardableResult
    func apply(_ newAccess: Access, read: Int) -> Bool {
        guard read >= lastRead else { return false }
        lastRead = read
        if newAccess == .preview || newAccess == .unavailable {
            replyTarget = nil
            text = ""
            attachments = []
            outgoing = []
        }
        access = newAccess
        return true
    }

    struct ReplyTarget {
        let id: UUID
        let excerpt: String
    }
    @Published var replyTarget: ReplyTarget?

    func reply(to message: Message) {
        guard access == .joined, message.thread_root_id == nil else { return }
        replyTarget = ReplyTarget(id: message.id, excerpt: String(message.body.prefix(100)))
    }

    @Published var text = ""
    @Published var attachments: [UploadIntent] = []
    var canSend: Bool {
        access == .joined && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty) && text.utf16.count <= 8_000
    }

    func stage(_ file: StagedFile) throws {
        guard attachments.count < 8 else { throw AttachmentError.count }
        attachments.append(UploadIntent(file: file))
    }

    enum Delivery { case sending, retrying, uploadFailed, unconfirmed, refused, accepted(UUID) }

    struct Outgoing: Identifiable {
        let post: Post
        let replyTarget: ReplyTarget?
        let files: [UploadIntent]
        let createdAt = Date()
        var delivery: Delivery = .sending
        var id: UUID { post.command_id }
    }
    @Published private(set) var outgoing: [Outgoing] = []

    func canDispatch(_ commandID: UUID) -> Bool {
        guard access == .joined, let row = outgoing.first(where: { $0.id == commandID }) else { return false }
        switch row.delivery {
        case .sending, .retrying: return true
        default: return false
        }
    }

    func begin(workspace: UUID, destination: Conversation.Destination) -> Post? {
        guard canSend else { return nil }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? attachments.map { $0.file.name }.joined(separator: ", ") : text
        let post = Post(id: UUID(), workspace: workspace, destination: destination, body: body, threadRootID: replyTarget?.id)
        outgoing.append(Outgoing(post: post, replyTarget: replyTarget, files: attachments))
        replyTarget = nil
        attachments = []
        text = ""
        return post
    }

    func retry(_ id: UUID) -> Post? {
        guard access == .joined, let i = outgoing.firstIndex(where: { $0.id == id }) else { return nil }
        switch outgoing[i].delivery {
        case .unconfirmed, .uploadFailed: break
        default: return nil
        }
        outgoing[i].delivery = .retrying
        return outgoing[i].post
    }

    func editRefused(_ id: UUID) {
        guard text.isEmpty, attachments.isEmpty, replyTarget == nil, let i = outgoing.firstIndex(where: { $0.id == id }) else { return }
        switch outgoing[i].delivery {
        case .refused, .uploadFailed: break
        default: return
        }
        let row = outgoing.remove(at: i)
        replyTarget = row.replyTarget
        attachments = row.files
        text = row.post.body ?? ""
    }

    func uploadFailed(_ id: UUID) {
        guard let i = outgoing.firstIndex(where: { $0.id == id }) else { return }
        outgoing[i].delivery = .uploadFailed
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
            if id == requestID && !Task.isCancelled && api.session.isActive {
                if case .thread(let threadID, _) = destination,
                   api.session.composer(workspace: workspace, conversation: .thread(threadID)).access == .unavailable {
                    messages = nil
                    hasOlder = false
                    retry = nil
                } else { retry = request }
            }
            return false
        }
    }
}
