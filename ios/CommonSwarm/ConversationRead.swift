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
        struct Refusal: Decodable { let error: String }
        let (data, response) = try await session.data(for: readRequest(Query(workspace_id: workspace)))
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw APIError.invalidResponse }
        if status == 404 { return nil }
        if status == 400, let code = try? JSONDecoder().decode(Refusal.self, from: data).error,
           ["invalid_request", "invalid_resource", "unsupported_resource", "not_found"].contains(code) { return nil }
        guard status == 200 else { throw APIError.refused(status) }
        let rows = try JSONDecoder().decode(Reply.self, from: data).conversations
        guard Set(rows.map(\.id)).count == rows.count,
              rows.allSatisfy({ $0.kind != .publicChannel && $0.kind != .privateChannel || $0.channel_id != nil })
        else { throw APIError.invalidResponse }
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
        let result: Reply = try await send(readRequest(Query(workspace_id: workspace, conversation_id: id,
            limit: Self.pageSize, before_created_at: before?.created_at, before_id: before?.id)))
        guard result.conversation.id == id else { throw APIError.invalidResponse }
        return result.messages
    }
}
