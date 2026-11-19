import Foundation

struct MemberAccess {
    let add: Bool
    let remove: Bool
    static let readOnly = Self(add: false, remove: false)
}

enum MemberChange: Hashable { case add([MemberRef]), remove(MemberRef) }

extension ConversationAPI {
    func memberAccess(workspace: UUID, row: ConversationSummary) async throws -> MemberAccess {
        guard row.joined, row.archived_at == nil, let channel = row.channel_id,
              row.kind == .publicChannel || row.kind == .privateChannel else { return .readOnly }
        let manager = try await mayManage(workspace, channel: channel, privateChannel: row.kind == .privateChannel)
        return MemberAccess(add: row.kind == .publicChannel || manager, remove: manager)
    }

    private func mayManage(_ workspace: UUID, channel: UUID, privateChannel: Bool) async throws -> Bool {
        struct Role: Decodable { let role: String }
        struct Creator: Decodable { let created_by_kind: String; let created_by_principal: UUID }
        struct Agent: Decodable { let principal_id: UUID }
        struct Manager: Decodable { let is_manager: Bool }
        let ws = "eq." + workspace.uuidString
        let viewer = session.userID
        let roles: [Role] = try await rows("memberships", ["workspace_id": ws, "user_id": "eq." + viewer.uuidString,
            "revoked_at": "is.null", "select": "role"])
        guard let role = roles.first?.role else { return false }
        if role == "owner" || role == "admin" { return true }
        let channels: [Creator] = try await rows("channels", ["workspace_id": ws, "channel_id": "eq." + channel.uuidString,
            "archived_at": "is.null", "select": "created_by_kind,created_by_principal"])
        guard let creator = channels.first else { return false }
        if creator.created_by_kind == "user" && creator.created_by_principal == viewer { return true }
        if creator.created_by_kind == "agent" {
            let agents: [Agent] = try await rows("agent_principals", ["workspace_id": ws, "principal_id": "eq." + creator.created_by_principal.uuidString,
                "owner_user_id": "eq." + viewer.uuidString, "select": "principal_id"])
            if !agents.isEmpty { return true }
        }
        guard privateChannel else { return false }
        let managers: [Manager] = try await rows("channel_members", ["workspace_id": ws, "channel_id": "eq." + channel.uuidString,
            "kind": "eq.user", "id": "eq." + viewer.uuidString, "select": "is_manager"])
        return managers.contains { $0.is_manager }
    }

    func changeMembers(_ change: MemberChange, workspace: UUID, row: ConversationSummary, commandID: UUID) async throws {
        struct Command: Encodable {
            let kind: String
            let channel_id, conversation_id: UUID?
            let members: [MemberRef]?
            let member: MemberRef?
        }
        struct Receipt: Decodable { let status: String; let conversation_id: UUID? }
        guard row.joined, row.archived_at == nil, let channel = row.channel_id,
              row.kind == .privateChannel || row.kind == .publicChannel else { throw APIError.invalidResponse }
        guard let current = try await conversationList(workspace)?.first(where: { $0.id == row.id }),
              current.joined, current.archived_at == nil, current.kind == row.kind, current.channel_id == channel
        else { throw APIError.invalidResponse }
        let rights = try await memberAccess(workspace: workspace, row: current)
        let priv = current.kind == .privateChannel
        let command: Command
        switch change {
        case .add(let refs):
            guard rights.add, (1...50).contains(refs.count) else { throw APIError.invalidResponse }
            command = Command(kind: priv ? "channel_member_add" : "conversation_invite", channel_id: priv ? channel : nil,
                              conversation_id: priv ? nil : row.id, members: refs, member: nil)
        case .remove(let member):
            guard rights.remove, member != MemberRef(kind: .user, id: session.userID) else { throw APIError.invalidResponse }
            command = Command(kind: priv ? "channel_member_remove" : "conversation_remove", channel_id: priv ? channel : nil,
                              conversation_id: priv ? nil : row.id, members: nil, member: member)
        }
        let result: Receipt = try await conversationCommand(command, workspace: workspace, id: commandID)
        guard result.status == "accepted", priv || result.conversation_id == row.id else { throw APIError.invalidResponse }
    }
}

struct MemberEditIntent {
    private(set) var selected: [MemberRef] = []
    private(set) var pending: MemberChange?
    private(set) var commandID = UUID()

    mutating func toggle(_ member: MemberRef) {
        retire()
        if selected.contains(member) { selected.removeAll { $0 == member } } else { selected.append(member) }
    }

    mutating func cancel() {
        retire()
        selected = []
    }

    mutating func retire() { pending = nil; commandID = UUID() }

    mutating func begin(_ change: MemberChange) {
        if case .add(let refs) = change, refs != selected || refs.isEmpty { return }
        if pending != change { commandID = UUID(); pending = change }
    }
}
