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

    private struct Envelope<Command: Encodable>: Encodable {
        let command_id: String
        let workspace_id: String
        let client_version = ConversationAPI.clientVersion
        let stream = Stream()
        let command: Command
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

    private struct CreateAssignWire: Encodable {
        let to: TodoParty
    }

    private struct CreateArguments: Encodable {
        let seat = TodoAPI.localSeat
        let request_id: String
        let title: String
        let notes: String?
        let due_on: String?
        let assign: CreateAssignWire?
    }

    private struct UpdateArguments: Encodable {
        let seat = TodoAPI.localSeat
        let request_id: String
        let todo_id: String
        let base_version: Int
        let title: String
        let notes: String
        let due_on: String?

        private enum CodingKeys: String, CodingKey {
            case seat, request_id, todo_id, base_version, title, notes, due_on
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(seat, forKey: .seat)
            try container.encode(request_id, forKey: .request_id)
            try container.encode(todo_id, forKey: .todo_id)
            try container.encode(base_version, forKey: .base_version)
            try container.encode(title, forKey: .title)
            try container.encode(notes, forKey: .notes)
            if let due_on {
                try container.encode(due_on, forKey: .due_on)
            } else {
                try container.encodeNil(forKey: .due_on)
            }
        }
    }

    private struct AssignArguments: Encodable {
        let seat = TodoAPI.localSeat
        let request_id: String
        let todo_id: String
        let base_version: Int
        let to: TodoParty?

        private enum CodingKeys: String, CodingKey {
            case seat, request_id, todo_id, base_version, to
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(seat, forKey: .seat)
            try container.encode(request_id, forKey: .request_id)
            try container.encode(todo_id, forKey: .todo_id)
            try container.encode(base_version, forKey: .base_version)
            if let to {
                try container.encode(to, forKey: .to)
            } else {
                try container.encodeNil(forKey: .to)
            }
        }
    }

    private struct SetStateArguments: Encodable {
        let seat = TodoAPI.localSeat
        let request_id: String
        let todo_id: String
        let base_version: Int
        let state: String
    }

    private struct CommentTargetWire: Encodable {
        let kind = "todo"
        let id: String
    }

    private struct CommentArguments: Encodable {
        let seat = TodoAPI.localSeat
        let request_id: String
        let target: CommentTargetWire
        let body: String
        let mentions: [TodoParty]?
    }

    private struct AnswerOfferCommand: Encodable {
        let kind = "household_todo_answer"
        let todo_id: String
        let offer_id: String
        let answer: String
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

    private struct WriteWireResponse<Value: Decodable>: Decodable {
        let status: String?
        let reason: String?
        let error: String?
        let value: Value?
        let current: TodoDetail?
    }

    private struct RefusalProbe: Decodable {
        let status: String?
        let reason: String?
        let error: String?
    }

    var session: HumanSession { api.session }

    private func postCommand<Command: Encodable>(
        workspace: UUID,
        commandID: UUID,
        command: Command
    ) async throws -> (Data, Int) {
        var request = api.request("functions/v1/command")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let envelope = Envelope(
            command_id: commandID.uuidString.lowercased(),
            workspace_id: workspace.uuidString.lowercased(),
            command: command
        )
        request.httpBody = try JSONEncoder().encode(envelope)
        let (data, response) = try await api.session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return (data, status)
    }

    private func sendTool<Arguments: Encodable, Response: Decodable>(
        workspace: UUID,
        tool: String,
        arguments: Arguments
    ) async throws -> Response {
        let (data, status) = try await postCommand(
            workspace: workspace,
            commandID: UUID(),
            command: ToolCommand(tool: tool, arguments: arguments)
        )
        guard status != 0 else { throw APIError.invalidResponse }
        if status == 401 {
            throw TodoAPIError.refused("unauthorized")
        }
        if status == 403 {
            let probe = try? JSONDecoder().decode(RefusalProbe.self, from: data)
            throw TodoAPIError.refused(probe?.reason ?? probe?.error ?? "forbidden")
        }
        if status == 404 {
            let probe = try? JSONDecoder().decode(RefusalProbe.self, from: data)
            throw TodoAPIError.refused(probe?.reason ?? probe?.error ?? "todo_not_found")
        }
        if status != 200 {
            if let probe = try? JSONDecoder().decode(RefusalProbe.self, from: data),
               probe.status == "refused", let reason = probe.reason {
                throw TodoAPIError.refused(reason)
            }
            throw APIError.refused(status)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private func decodeWrite<Value: Decodable & Sendable>(
        data: Data,
        status: Int,
        unconfirmedMessage: String,
        fallbackRefusal: String
    ) -> TodoWriteOutcome<Value> {
        let wire = try? JSONDecoder().decode(WriteWireResponse<Value>.self, from: data)
        if status == 401 {
            return .refused(reason: "unauthorized", message: TodoRules.refusalMessage("unauthorized", fallback: fallbackRefusal))
        }
        if status == 403 {
            let reason = wire?.reason ?? wire?.error ?? "forbidden"
            return .refused(reason: reason, message: TodoRules.refusalMessage(reason, fallback: fallbackRefusal))
        }
        if status == 404 {
            let reason = wire?.reason ?? wire?.error ?? "todo_not_found"
            return .refused(reason: reason, message: TodoRules.refusalMessage(reason, fallback: fallbackRefusal))
        }
        guard status == 200 || status == 400 || status == 409, let wire else {
            return .unconfirmed(message: unconfirmedMessage)
        }
        if wire.status == "committed", let value = wire.value {
            return .committed(value)
        }
        if wire.status == "conflict" {
            return .conflict(
                current: wire.current,
                message: "Someone else updated this to-do. Review the latest version and try again."
            )
        }
        if wire.status == "refused" {
            let reason = wire.reason ?? "refused"
            return .refused(reason: reason, message: TodoRules.refusalMessage(reason, fallback: fallbackRefusal))
        }
        return .unconfirmed(message: unconfirmedMessage)
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

    func createTodo(
        workspace: UUID,
        title: String,
        notes: String?,
        dueOn: String?,
        assignee: TodoParty?,
        requestID: UUID
    ) async -> TodoWriteOutcome<TodoDetail> {
        let unconfirmed = "The to-do may or may not have been saved. Retry or reload to check."
        do {
            let (data, status) = try await postCommand(
                workspace: workspace,
                commandID: requestID,
                command: ToolCommand(
                    tool: "todo_create",
                    arguments: CreateArguments(
                        request_id: requestID.uuidString.lowercased(),
                        title: title,
                        notes: notes,
                        due_on: dueOn,
                        assign: assignee.map { CreateAssignWire(to: $0) }
                    )
                )
            )
            return decodeWrite(data: data, status: status, unconfirmedMessage: unconfirmed, fallbackRefusal: "Couldn’t add to-do.")
        } catch {
            return .unconfirmed(message: unconfirmed)
        }
    }

    func updateTodo(
        workspace: UUID,
        todoID: UUID,
        baseVersion: Int,
        title: String,
        notes: String,
        dueOn: String?,
        requestID: UUID
    ) async -> TodoWriteOutcome<TodoDetail> {
        let unconfirmed = "The to-do may or may not have been updated. Retry or reload to check."
        do {
            let (data, status) = try await postCommand(
                workspace: workspace,
                commandID: requestID,
                command: ToolCommand(
                    tool: "todo_update",
                    arguments: UpdateArguments(
                        request_id: requestID.uuidString.lowercased(),
                        todo_id: todoID.uuidString.lowercased(),
                        base_version: baseVersion,
                        title: title,
                        notes: notes,
                        due_on: dueOn
                    )
                )
            )
            return decodeWrite(data: data, status: status, unconfirmedMessage: unconfirmed, fallbackRefusal: "Couldn’t save changes.")
        } catch {
            return .unconfirmed(message: unconfirmed)
        }
    }

    func assignTodo(
        workspace: UUID,
        todoID: UUID,
        baseVersion: Int,
        to party: TodoParty?,
        requestID: UUID
    ) async -> TodoWriteOutcome<TodoDetail> {
        let unconfirmed = "The assignment may or may not have changed. Retry or reload to check."
        do {
            let (data, status) = try await postCommand(
                workspace: workspace,
                commandID: requestID,
                command: ToolCommand(
                    tool: "todo_assign",
                    arguments: AssignArguments(
                        request_id: requestID.uuidString.lowercased(),
                        todo_id: todoID.uuidString.lowercased(),
                        base_version: baseVersion,
                        to: party
                    )
                )
            )
            return decodeWrite(data: data, status: status, unconfirmedMessage: unconfirmed, fallbackRefusal: "Couldn’t update assignment.")
        } catch {
            return .unconfirmed(message: unconfirmed)
        }
    }

    func setTodoState(
        workspace: UUID,
        todoID: UUID,
        baseVersion: Int,
        state: TodoState,
        requestID: UUID
    ) async -> TodoWriteOutcome<TodoDetail> {
        let unconfirmed = "The to-do state may or may not have changed. Retry or reload to check."
        do {
            let (data, status) = try await postCommand(
                workspace: workspace,
                commandID: requestID,
                command: ToolCommand(
                    tool: "todo_set_state",
                    arguments: SetStateArguments(
                        request_id: requestID.uuidString.lowercased(),
                        todo_id: todoID.uuidString.lowercased(),
                        base_version: baseVersion,
                        state: state.rawValue
                    )
                )
            )
            return decodeWrite(data: data, status: status, unconfirmedMessage: unconfirmed, fallbackRefusal: "Couldn’t update to-do state.")
        } catch {
            return .unconfirmed(message: unconfirmed)
        }
    }

    func answerOffer(
        workspace: UUID,
        todoID: UUID,
        offerID: UUID,
        answer: TodoOfferAnswer,
        requestID: UUID
    ) async -> TodoWriteOutcome<TodoDetail> {
        let unconfirmed = "The request may or may not have been answered. Retry or reload to check."
        do {
            let (data, status) = try await postCommand(
                workspace: workspace,
                commandID: requestID,
                command: AnswerOfferCommand(
                    todo_id: todoID.uuidString.lowercased(),
                    offer_id: offerID.uuidString.lowercased(),
                    answer: answer.rawValue
                )
            )
            return decodeWrite(data: data, status: status, unconfirmedMessage: unconfirmed, fallbackRefusal: "Couldn’t answer work request.")
        } catch {
            return .unconfirmed(message: unconfirmed)
        }
    }

    func postComment(
        workspace: UUID,
        todoID: UUID,
        body: String,
        mentions: [TodoParty],
        requestID: UUID
    ) async -> TodoWriteOutcome<TodoComment> {
        let unconfirmed = "The comment may or may not have been posted. Retry or reload to check."
        do {
            let (data, status) = try await postCommand(
                workspace: workspace,
                commandID: requestID,
                command: ToolCommand(
                    tool: "todo_comment",
                    arguments: CommentArguments(
                        request_id: requestID.uuidString.lowercased(),
                        target: CommentTargetWire(id: todoID.uuidString.lowercased()),
                        body: body,
                        mentions: mentions.isEmpty ? nil : mentions
                    )
                )
            )
            return decodeWrite(data: data, status: status, unconfirmedMessage: unconfirmed, fallbackRefusal: "Couldn’t post comment.")
        } catch {
            return .unconfirmed(message: unconfirmed)
        }
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
