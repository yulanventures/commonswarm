import Foundation

enum TodoAPIError: Error, Sendable {
    case refused(String)
    case malformedResponse
}

struct TodoAPI {
    static let localSeat = "seat_0000000000000000000000"
    let api: ConversationAPI

    var viewerUserID: UUID { api.session.userID }

    private struct Stream: Encodable {
        let kind = "workspace"
    }

    private struct ToolCommand<Arguments: Encodable>: Encodable {
        let kind = "household_tool"
        let tool: String
        let arguments: Arguments
    }

    private struct Envelope<Arguments: Encodable>: Encodable {
        let command_id: String
        let workspace_id: String
        let client_version = ConversationAPI.clientVersion
        let stream = Stream()
        let command: ToolCommand<Arguments>
    }

    private struct ListArguments: Encodable {
        let seat = TodoAPI.localSeat
        let scope: String
        let offset: Int
        let limit: Int
    }

    private struct ReadArguments: Encodable {
        let seat = TodoAPI.localSeat
        let todo_id: String
        let comment_offset: Int
    }

    private struct ListWireResponse: Decodable {
        let status: String
        let reason: String?
        let todos: [TodoSummary]?
        let next_offset: Int?
    }

    private struct ReadWireResponse: Decodable {
        let status: String
        let reason: String?
        let todo: TodoDetail?
        let comments: [TodoComment]?
        let next_comment_offset: Int?
    }

    private struct RefusalProbe: Decodable {
        let status: String?
        let reason: String?
    }

    private func sendTool<Arguments: Encodable, Response: Decodable>(
        workspace: UUID,
        tool: String,
        arguments: Arguments
    ) async throws -> Response {
        var request = api.request("functions/v1/command")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let envelope = Envelope(
            command_id: UUID().uuidString.lowercased(),
            workspace_id: workspace.uuidString.lowercased(),
            command: ToolCommand(tool: tool, arguments: arguments)
        )
        request.httpBody = try JSONEncoder().encode(envelope)
        let (data, response) = try await api.session.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw APIError.invalidResponse }
        if status != 200 {
            if let probe = try? JSONDecoder().decode(RefusalProbe.self, from: data),
               probe.status == "refused", let reason = probe.reason {
                throw TodoAPIError.refused(reason)
            }
            throw APIError.refused(status)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    func listTodos(workspace: UUID, scope: TodoFilter, offset: Int = 0, limit: Int = 50) async throws -> TodoListPage {
        let wire: ListWireResponse = try await sendTool(
            workspace: workspace,
            tool: "todo_list",
            arguments: ListArguments(scope: scope.rawValue, offset: offset, limit: min(max(limit, 1), 50))
        )
        if wire.status == "refused" {
            throw TodoAPIError.refused(wire.reason ?? "unknown")
        }
        guard wire.status == "ok", let todos = wire.todos else {
            throw TodoAPIError.malformedResponse
        }
        return TodoListPage(todos: todos, nextOffset: wire.next_offset)
    }

    func readTodo(workspace: UUID, todoID: UUID, commentOffset: Int = 0) async throws -> TodoReadResponse {
        let wire: ReadWireResponse = try await sendTool(
            workspace: workspace,
            tool: "todo_read",
            arguments: ReadArguments(todo_id: todoID.uuidString.lowercased(), comment_offset: max(commentOffset, 0))
        )
        if wire.status == "refused" {
            throw TodoAPIError.refused(wire.reason ?? "unknown")
        }
        guard wire.status == "ok", let todo = wire.todo else {
            throw TodoAPIError.malformedResponse
        }
        return TodoReadResponse(todo: todo, comments: wire.comments ?? [], nextCommentOffset: wire.next_comment_offset)
    }

    func directory(workspace: UUID) async throws -> TodoDirectory {
        struct Person: Decodable {
            let user_id: UUID
            let display_name: String?
        }
        struct Agent: Decodable {
            let principal_id: UUID
            let name: String
        }
        let filter = "eq." + workspace.uuidString.lowercased()
        async let peopleRows: [Person] = api.rows("member_profiles", ["select": "user_id,display_name", "workspace_id": filter])
        async let agentRows: [Agent] = api.rows("agent_principals", ["select": "principal_id,name", "workspace_id": filter, "revoked_at": "is.null"])
        let (people, agents) = try await (peopleRows, agentRows)
        var peopleByID: [UUID: String] = [:]
        for person in people {
            if let name = person.display_name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
                peopleByID[person.user_id] = name
            }
        }
        var agentsByID: [UUID: String] = [:]
        for agent in agents {
            let name = agent.name.trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty {
                agentsByID[agent.principal_id] = name
            }
        }
        return TodoDirectory(viewerUserID: api.session.userID, people: peopleByID, agents: agentsByID)
    }
}
