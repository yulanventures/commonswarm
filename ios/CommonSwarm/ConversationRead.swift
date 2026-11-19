import Foundation

enum ConversationKind: String, Decodable {
    case general, publicChannel = "public_channel", privateChannel = "private_channel", dm, group = "group_dm"
    var direct: Bool { self == .dm || self == .group }
    var workspaceFiles: Bool { self == .general || self == .publicChannel }
}

struct ConversationMember: Decodable, Hashable {
    enum Kind: String, Codable { case user, agent }
    let kind: Kind
    let id: UUID
    let name: String?
    let left_at: String?
    var contact: Conversation {
        Conversation(destination: kind == .agent ? .agent(id) : .person(id),
                     name: name ?? (kind == .agent ? "Agent" : "Member"), symbol: kind == .agent ? "cpu" : "person")
    }
}

struct ConversationSummary: Identifiable, Decodable {
    let conversation_id: UUID
    let kind: ConversationKind
    let channel_id: UUID?
    let slug, description, archived_at: String?
    let joined: Bool
    let members: [ConversationMember]?
    let last_message_at, notify_level: String?
    let mention_count, unread_count: Int?
    var id: UUID { conversation_id }
    var access: Composer.Access {
        if archived_at != nil { return .unavailable }
        return joined ? .joined : (kind == .publicChannel ? .preview : .unavailable)
    }

    func item(viewer: UUID) -> Conversation {
        let others = (members ?? []).filter { $0.left_at == nil && !($0.kind == .user && $0.id == viewer) }
        let name: String
        let symbol: String
        if kind.direct {
            name = others.isEmpty ? "Notes to self" : others.map { $0.contact.name }.joined(separator: ", ")
            symbol = kind == .group ? "person.2" : others.first?.contact.symbol ?? "person"
        } else {
            name = kind == .general ? "#general" : "#" + (slug ?? "Channel")
            symbol = kind == .privateChannel ? "lock" : "number"
        }
        return Conversation(destination: .thread(id, kind), name: name, symbol: symbol)
    }
}

extension ConversationAPI {
    private func readRequest(_ body: some Encodable) throws -> URLRequest {
        var req = request("functions/v1/read")
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        return req
    }

    // nil is the explicit legacy-server response. An empty list is a supported workspace.
    func conversationList(_ workspace: UUID) async throws -> [ConversationSummary]? {
        struct Query: Encodable {
            let workspace_id: UUID
            let resource = "conversations"
            let include_archived = false
        }
        struct Reply: Decodable { let conversations: [ConversationSummary] }
        let read = await session.nextMembershipRead()
        let (data, response) = try await session.data(for: readRequest(Query(workspace_id: workspace)))
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw APIError.invalidResponse }
        if status == 400, let refusal = try? JSONDecoder().decode([String: String].self, from: data),
           refusal == ["error": "invalid_request"] || ["unsupported_resource", "invalid_resource"].contains(refusal["error"] ?? "") {
            try await session.recordConversationCapability(workspace: workspace, supported: false)
            return nil
        }
        guard status == 200 else { throw APIError.refused(status) }
        let rows = try JSONDecoder().decode(Reply.self, from: data).conversations
        guard Set(rows.map(\.id)).count == rows.count,
              rows.allSatisfy({ $0.kind != .publicChannel && $0.kind != .privateChannel || $0.channel_id != nil })
        else { throw APIError.invalidResponse }
        try await session.recordConversationCapability(workspace: workspace, supported: true)
        await session.reconcileMemberships(workspace: workspace, rows: rows, read: read)
        return rows
    }

    func threadHistory(_ workspace: UUID, id: UUID, before: Message?) async throws -> [Message] {
        struct Query: Encodable {
            let resource = "conversation_history"
            let workspace_id, conversation_id: UUID
            let limit: Int
            let before_created_at: String?
            let before_id: UUID?
        }
        struct Reply: Decodable { let conversation: ConversationSummary; let messages: [Message] }
        let draft = await session.composer(workspace: workspace, conversation: .thread(id))
        let read = await session.nextMembershipRead()
        do {
            let result: Reply = try await send(readRequest(Query(workspace_id: workspace, conversation_id: id,
                limit: Self.pageSize, before_created_at: before?.created_at, before_id: before?.id)))
            guard result.conversation.id == id else { throw APIError.invalidResponse }
            let access = result.conversation.access
            guard await draft.apply(access, read: read) else { throw CancellationError() }
            guard access != .unavailable else { throw APIError.refused(403) }
            return result.messages
        } catch APIError.refused(let status) where [401, 403, 404].contains(status) {
            _ = await draft.apply(.unavailable, read: read)
            throw APIError.refused(status)
        }
    }
}

extension ConversationAPI {
    func conversationCommand<C: Encodable, R: Decodable>(_ command: C, workspace: UUID, id: UUID) async throws -> R {
        var req = request("functions/v1/command")
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(WorkspaceCommand(command_id: id, workspace_id: workspace, command: command))
        return try await send(req)
    }

    func join(workspace: UUID, conversation: UUID, commandID: UUID) async throws {
        struct Join: Encodable {
            let kind = "conversation_join"
            let conversation_id: UUID
        }
        struct Receipt: Decodable { let status: String; let conversation_id: UUID }
        let receipt: Receipt = try await conversationCommand(Join(conversation_id: conversation), workspace: workspace, id: commandID)
        guard receipt.status == "accepted", receipt.conversation_id == conversation else { throw APIError.invalidResponse }
    }
}
