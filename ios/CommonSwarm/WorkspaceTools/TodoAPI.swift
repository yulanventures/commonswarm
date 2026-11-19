import Foundation

struct TodoAPI {
    let origin: URL
    let publicKey: String
    let session: HumanSession

    private func request(_ path: String, _ query: [String: String] = [:]) -> URLRequest {
        var components = URLComponents(url: origin.appending(path: path), resolvingAgainstBaseURL: false)!
        components.queryItems = query.isEmpty ? nil : query.map { URLQueryItem(name: $0.key, value: $0.value) }
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

    func todos(workspace: UUID) async throws -> [Todo] {
        let query = ["select": "todo_id,title,assignee_id,notes,due_date,state", "workspace_id": "eq." + workspace.uuidString]
        var request = request("rest/v1/todos", query)
        request.setValue("swarm_read", forHTTPHeaderField: "Accept-Profile")
        return try await send(request)
    }

    func members(workspace: UUID) async throws -> [UUID: String] {
        struct Member: Decodable { let user_id: UUID; let display_name: String }
        let query = ["select": "user_id,display_name", "workspace_id": "eq." + workspace.uuidString]
        var request = request("rest/v1/member_profiles", query)
        request.setValue("swarm_read", forHTTPHeaderField: "Accept-Profile")
        let members: [Member] = try await send(request)
        return Dictionary(uniqueKeysWithValues: members.map { ($0.user_id, $0.display_name) })
    }
}
