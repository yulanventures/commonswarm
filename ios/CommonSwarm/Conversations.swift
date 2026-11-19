import Foundation

struct Workspace: Decodable, Hashable, Identifiable {
    let workspace_id: UUID
    let name: String
    var id: UUID { workspace_id }
}

struct Conversation: Hashable, Identifiable {
    enum Destination: Hashable { case general, channel(UUID, String), person(UUID), agent(UUID) }
    enum ID: Hashable { case general, channel(UUID), person(UUID), agent(UUID) }
    let destination: Destination
    var id: ID {
        switch destination {
        case .general: .general
        case .channel(let uuid, _): .channel(uuid)
        case .person(let uuid): .person(uuid)
        case .agent(let uuid): .agent(uuid)
        }
    }
    let name: String
    let symbol: String
    var isDirect: Bool {
        switch id { case .person, .agent: true; default: false }
    }
}

struct Message: Decodable, Identifiable {
    let id: UUID
    let from: UUID
    let from_kind: String
    let body: String
    let created_at: String
    let attachments: [MessageAttachment]?
}

struct MessageAttachment: Decodable, Hashable, Identifiable {
    let file_id: UUID
    let version_n: Int
    let name: String
    let content_type: String
    let size_bytes: Int

    var id: String { file_id.uuidString + "@" + String(version_n) }
    var isRasterImage: Bool { ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(content_type) }
}

struct Post: Encodable {
    let command_id: UUID
    let workspace_id: UUID
    let client_version = "0.1.0"
    let stream = ["kind": "workspace"]
    let command: [String: String?]

    var body: String? { command["body"] ?? nil }

    init(id: UUID, workspace: UUID, destination: Conversation.Destination, body: String) {
        command_id = id
        workspace_id = workspace
        var fields: [String: String?] = ["kind": "post_signal", "signal_kind": "note", "body": body,
                                         "to_user_id": nil, "to_agent_principal_id": nil,
                                         "in_reply_to": nil, "about": nil]
        switch destination {
        case .general: break
        case .channel(let id, let slug):
            fields["channel"] = slug
            fields["expected_channel_id"] = id.uuidString.lowercased()
        case .person(let person): fields["to_user_id"] = person.uuidString.lowercased()
        case .agent(let agent): fields["to_agent_principal_id"] = agent.uuidString.lowercased()
        }
        command = fields
    }
}

enum APIError: Error { case refused(Int), invalidResponse }

struct ConversationAPI {
    static let pageSize = 50
    let origin: URL
    let publicKey: String
    let session: HumanSession

    private func request(_ path: String, _ query: [String: String] = [:]) -> URLRequest {
        var components = URLComponents(url: origin.appending(path: path), resolvingAgainstBaseURL: false)!
        components.queryItems = query.isEmpty ? nil : query.map { URLQueryItem(name: $0.key, value: $0.value) }
        // PostgREST decodes a literal plus as a space, including the UTC offset in a cursor.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        var request = URLRequest(url: components.url!)
        request.setValue(publicKey, forHTTPHeaderField: "apikey")
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw APIError.invalidResponse }
        guard (200..<300).contains(status) else { throw APIError.refused(status) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func rows<T: Decodable>(_ table: String, _ query: [String: String]) async throws -> [T] {
        var request = request("rest/v1/" + table, query)
        request.setValue("swarm_read", forHTTPHeaderField: "Accept-Profile")
        return try await send(request)
    }

    func workspaces() async throws -> [Workspace] {
        try await rows("workspaces", ["select": "workspace_id,name", "archived_at": "is.null", "order": "name,workspace_id"])
    }

    func directory(_ workspace: UUID) async throws -> [Conversation] {
        struct Channel: Decodable { let channel_id: UUID; let slug, visibility: String }
        struct Person: Decodable { let user_id: UUID; let display_name: String? }
        struct Agent: Decodable { let principal_id: UUID; let name: String }
        let filter = "eq." + workspace.uuidString
        async let channels: [Channel] = rows("channels", ["select": "channel_id,slug,visibility", "workspace_id": filter,
                                                           "archived_at": "is.null", "order": "sort_rank,slug"])
        async let people: [Person] = rows("member_profiles", ["select": "user_id,display_name", "workspace_id": filter])
        async let agents: [Agent] = rows("agent_principals", ["select": "principal_id,name", "workspace_id": filter, "revoked_at": "is.null"])
        let (channelRows, peopleRows, agentRows) = try await (channels, people, agents)
        let dms = peopleRows.filter { $0.user_id != session.userID }.map {
            Conversation(destination: .person($0.user_id), name: $0.display_name ?? "Member", symbol: "person.crop.circle")
        } + agentRows.map { Conversation(destination: .agent($0.principal_id), name: $0.name, symbol: "cpu") }
        return [Conversation(destination: .general, name: "#general", symbol: "number")] + channelRows.map {
            Conversation(destination: .channel($0.channel_id, $0.slug), name: "#" + $0.slug, symbol: $0.visibility == "private" ? "lock" : "number")
        } + dms.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func history(_ workspace: UUID, _ destination: Conversation.Destination, before: Message? = nil) async throws -> [Message] {
        var query = ["select": "id,from,from_kind,body,created_at,attachments", "workspace_id": "eq." + workspace.uuidString,
                     "order": "created_at.desc,id.desc", "limit": String(Self.pageSize)]
        var predicates: [String] = []
        switch destination {
        case .general:
            query["channel_id"] = "is.null"
            query["to"] = "is.null"
            query["to_agent"] = "is.null"
            predicates.append("or(thread_root_id.is.null,broadcast_to_channel.eq.true)")
        case .channel(let id, _):
            query["channel_id"] = "eq." + id.uuidString
            predicates.append("or(thread_root_id.is.null,broadcast_to_channel.eq.true)")
        case .person(let id), .agent(let id):
            let peerIsAgent: Bool
            if case .agent = destination { peerIsAgent = true } else { peerIsAgent = false }
            let viewer = session.userID.uuidString
            let toPeer = peerIsAgent ? "to_agent" : "to"
            let peerKind = peerIsAgent ? "agent" : "user"
            query["channel_id"] = "is.null"
            query["recipients->1"] = "is.null"
            predicates.append("or(and(from_kind.eq.user,from.eq.\(viewer),\(toPeer).eq.\(id)),and(from_kind.eq.\(peerKind),from.eq.\(id),to.eq.\(viewer)))")
        }
        if let before {
            predicates.append("or(created_at.lt.\(before.created_at),and(created_at.eq.\(before.created_at),id.lt.\(before.id)))")
        }
        query["and"] = "(" + predicates.joined(separator: ",") + ")"
        let result: [Message] = try await rows("signals", query)
        return Array(result.reversed())
    }

    func download(_ attachment: MessageAttachment, workspace: UUID) async throws -> Data {
        struct Command: Encodable {
            let kind = "file_download_url"
            let file_id: UUID
            let version_n: Int
        }
        struct Envelope: Encodable {
            let command_id = UUID()
            let workspace_id: UUID
            let stream = ["kind": "workspace"]
            let command: Command
        }
        struct Grant: Decodable {
            let status: String
            let file_id: UUID
            let version_n, size_bytes: Int
            let download_path: String
        }
        guard attachment.version_n > 0, (1...25 * 1024 * 1024).contains(attachment.size_bytes) else {
            throw APIError.invalidResponse
        }
        var req = request("functions/v1/command")
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(Envelope(workspace_id: workspace,
            command: Command(file_id: attachment.file_id, version_n: attachment.version_n)))
        let grant: Grant = try await send(req)
        let expected = "/storage/v1/object/sign/swarm-files/" + workspace.uuidString.lowercased() + "/"
            + attachment.file_id.uuidString.lowercased() + "/" + String(attachment.version_n)
        guard grant.status == "accepted", grant.file_id == attachment.file_id,
              grant.version_n == attachment.version_n, grant.size_bytes == attachment.size_bytes,
              let path = URLComponents(string: grant.download_path),
              path.scheme == nil, path.host == nil, path.fragment == nil,
              path.percentEncodedPath == expected, path.queryItems?.contains(where: { $0.name == "token" && $0.value?.isEmpty == false }) == true,
              let url = URL(string: grant.download_path, relativeTo: origin)?.absoluteURL else {
            throw APIError.invalidResponse
        }
        return try await session.downloadStorage(url, size: grant.size_bytes)
    }

    @discardableResult
    func post(_ post: Post) async throws -> UUID {
        struct Receipt: Decodable {
            struct Signal: Decodable { let id: UUID }
            let status: String
            let signal: Signal
        }
        var request = request("functions/v1/command")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(post)
        let receipt: Receipt = try await send(request)
        guard receipt.status == "accepted" else { throw APIError.invalidResponse }
        return receipt.signal.id
    }
}
