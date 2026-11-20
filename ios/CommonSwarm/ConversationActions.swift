import Foundation

enum ConversationAction: Hashable {
    case leave
    case markRead(through: UUID)
    case star(Bool)
    case notify(String)
}

extension ConversationKind {
    var canLeave: Bool { self == .publicChannel || self == .privateChannel || self == .group }
}

extension ConversationAPI {
    @MainActor
    func perform(_ action: ConversationAction, on row: ConversationSummary, workspace: UUID, commandID: UUID) async throws -> ConversationSummary {
        struct Change: Encodable {
            var kind: String
            var conversation_id: UUID?
            var channel_id: UUID?
            var through_signal_id: UUID?
            var starred: Bool?
            var notify_level: String?
            var involvement: String?
        }
        struct Receipt: Decodable {
            struct Preference: Decodable { let workspace_id, channel_id: UUID; let starred: Bool; let involvement: String; let star_rank: Int? }
            let status: String
            let conversation_id, channel_id: UUID?
            let left, starred: Bool?
            let star_rank: Int?
            let notify_level, read_through_at: String?
            let preference: Preference?
        }
        guard row.joined, row.archived_at == nil else { throw APIError.invalidResponse }
        let priv = row.kind == .privateChannel
        var command = Change(kind: "", conversation_id: row.id)
        switch action {
        case .leave:
            guard row.kind.canLeave else { throw APIError.invalidResponse }
            command.kind = priv ? "channel_leave" : "conversation_leave"
        case .markRead(let through):
            command.kind = "conversation_mark_read"
            command.through_signal_id = through
        case .star(let value):
            command.kind = priv ? "channel_preference_set" : "conversation_set_notify"
            command.starred = value
        case .notify(let level):
            guard ["everything", "mentions", "muted"].contains(level) else { throw APIError.invalidResponse }
            command.kind = priv ? "channel_preference_set" : "conversation_set_notify"
            if priv { command.involvement = level } else { command.notify_level = level }
        }
        if command.kind.hasPrefix("channel_") {
            guard let channel = row.channel_id else { throw APIError.invalidResponse }
            command.channel_id = channel
            command.conversation_id = nil
        }
        let result: Receipt = try await conversationCommand(command, workspace: workspace, id: commandID)
        guard result.status == "accepted" else { throw APIError.invalidResponse }
        if command.kind == "channel_preference_set" {
            guard result.preference?.workspace_id == workspace, result.preference?.channel_id == command.channel_id else { throw APIError.invalidResponse }
        } else if command.channel_id != nil {
            guard result.channel_id == command.channel_id else { throw APIError.invalidResponse }
        } else if result.conversation_id != row.id { throw APIError.invalidResponse }
        var updated = row
        switch action {
        case .leave:
            guard !priv || result.left == true else { throw APIError.invalidResponse }
            updated.joined = false
            let draft = session.composer(workspace: workspace, conversation: .thread(row.id))
            draft.apply(updated.access, read: session.nextMembershipRead())
        case .markRead:
            guard result.read_through_at != nil else { throw APIError.invalidResponse }
            updated.mention_count = 0
            updated.unread_count = 0
        case .star, .notify:
            guard let starred = result.preference?.starred ?? result.starred,
                  let level = result.preference?.involvement ?? result.notify_level else { throw APIError.invalidResponse }
            updated.starred = starred
            updated.star_rank = result.preference?.star_rank ?? result.star_rank
            updated.notify_level = level
        }
        return updated
    }
}
