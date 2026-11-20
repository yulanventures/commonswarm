import Foundation

enum TodoAPIError: Error, Sendable {
    case refused(String)
    case malformedResponse
}

enum TodoAccessStatus: Equatable, Sendable {
    case granted(TodoAccess)
    case refused(reason: String)
    case unavailable
}

struct TodoAPI {
    static let localSeat = "seat_0000000000000000000000"
    let api: ConversationAPI

    var viewerUserID: UUID { api.session.userID }
    var session: HumanSession { api.session }

    private struct Stream: Encodable {
        let kind = "workspace"
    }

    private struct HouseholdAccessCommand: Encodable {
        let kind = "household_access"
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

    private struct AccessWireResponse: Decodable {
        let status: String?
        let reason: String?
        let error: String?
        let content_role: String?
        let operations: [String]?
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
        let current: TodoWriteRecord?
        let replayed: Bool?
    }

    private struct RefusalProbe: Decodable {
        let status: String?
        let reason: String?
        let error: String?
    }

    private func gatedRows<T: Decodable>(
        _ table: String,
        _ query: [String: String],
        canDispatch: @escaping @MainActor @Sendable () -> Bool
    ) async throws -> [T] {
        var req = api.request("rest/v1/" + table, query)
        req.setValue("swarm_read", forHTTPHeaderField: "Accept-Profile")
        return try await api.send(req, canDispatch: canDispatch)
    }

    private func postCommand<Command: Encodable>(
        workspace: UUID,
        commandID: UUID,
        command: Command,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
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
        let (data, response) = try await api.session.data(for: request, canDispatch: canDispatch)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return (data, status)
    }

    private func sendTool<Arguments: Encodable, Response: Decodable>(
        workspace: UUID,
        tool: String,
        arguments: Arguments,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async throws -> Response {
        let (data, status) = try await postCommand(
            workspace: workspace,
            commandID: UUID(),
            command: ToolCommand(tool: tool, arguments: arguments),
            canDispatch: canDispatch
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
            return .committed(value, replayed: wire.replayed == true)
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

    func access(
        workspace: UUID,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async throws -> TodoAccessStatus {
        let (data, status) = try await postCommand(
            workspace: workspace,
            commandID: UUID(),
            command: HouseholdAccessCommand(),
            canDispatch: canDispatch
        )
        let wire = try? JSONDecoder().decode(AccessWireResponse.self, from: data)
        if status == 401 {
            return .refused(reason: "unauthorized")
        }
        if status == 404 {
            return .refused(reason: wire?.reason ?? wire?.error ?? "not_found")
        }
        if status == 403 {
            return .refused(reason: wire?.reason ?? wire?.error ?? "forbidden")
        }
        if status == 400 {
            return .unavailable
        }
        guard status == 200, let wire else {
            throw APIError.refused(status)
        }
        if wire.status == "ok", let ops = wire.operations {
            let opSet = Set(ops)
            let isAdmin = await fetchIsWorkspaceAdmin(workspace: workspace, canDispatch: canDispatch)
            return .granted(
                TodoAccess(
                    canRead: opSet.contains("read"),
                    canCreate: opSet.contains("read") && opSet.contains("create"),
                    canUpdate: opSet.contains("read") && opSet.contains("update"),
                    isWorkspaceAdmin: isAdmin
                )
            )
        }
        if wire.status == "refused" {
            return .refused(reason: wire.reason ?? "workspace_access_refused")
        }
        return .unavailable
    }

    private func fetchIsWorkspaceAdmin(
        workspace: UUID,
        canDispatch: @escaping @MainActor @Sendable () -> Bool
    ) async -> Bool {
        struct MembershipRow: Decodable {
            let user_id: UUID
            let role: String
        }
        let viewerID = await MainActor.run { api.session.userID }
        guard await canDispatch() else { return false }
        let rows: [MembershipRow] = (try? await gatedRows(
            "memberships",
            [
                "select": "user_id,role",
                "workspace_id": "eq.\(workspace.uuidString.lowercased())",
                "user_id": "eq.\(viewerID.uuidString.lowercased())",
            ],
            canDispatch: canDispatch
        )) ?? []
        guard let role = rows.first?.role.lowercased() else { return false }
        return role == "owner" || role == "admin"
    }

    func listTodos(
        workspace: UUID,
        scope: TodoFilter,
        offset: Int = 0,
        limit: Int = 50,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async throws -> TodoListPage {
        let wire: ListWireResponse = try await sendTool(
            workspace: workspace,
            tool: "todo_list",
            arguments: ListArguments(scope: scope.rawValue, offset: offset, limit: min(max(limit, 1), 50)),
            canDispatch: canDispatch
        )
        if wire.status == "refused" {
            throw TodoAPIError.refused(wire.reason ?? "unknown")
        }
        guard wire.status == "ok", let todos = wire.todos else {
            throw TodoAPIError.malformedResponse
        }
        return TodoListPage(todos: todos, nextOffset: wire.next_offset)
    }

    func readTodo(
        workspace: UUID,
        todoID: UUID,
        commentOffset: Int = 0,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async throws -> TodoReadResponse {
        let wire: ReadWireResponse = try await sendTool(
            workspace: workspace,
            tool: "todo_read",
            arguments: ReadArguments(todo_id: todoID.uuidString.lowercased(), comment_offset: max(commentOffset, 0)),
            canDispatch: canDispatch
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
        requestID: UUID,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async -> TodoWriteOutcome<TodoWriteRecord> {
        let unconfirmed = "The to-do may or may not have been saved. Retry unchanged to check."
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
                ),
                canDispatch: canDispatch
            )
            return decodeWrite(data: data, status: status, unconfirmedMessage: unconfirmed, fallbackRefusal: "Couldn’t add to-do.")
        } catch is CancellationError {
            return .cancelled
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
        requestID: UUID,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async -> TodoWriteOutcome<TodoWriteRecord> {
        let unconfirmed = "The to-do may or may not have been updated. Retry unchanged to check."
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
                ),
                canDispatch: canDispatch
            )
            return decodeWrite(data: data, status: status, unconfirmedMessage: unconfirmed, fallbackRefusal: "Couldn’t save changes.")
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .unconfirmed(message: unconfirmed)
        }
    }

    func assignTodo(
        workspace: UUID,
        todoID: UUID,
        baseVersion: Int,
        to party: TodoParty?,
        requestID: UUID,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async -> TodoWriteOutcome<TodoWriteRecord> {
        let unconfirmed = "The assignment may or may not have changed. Retry unchanged to check."
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
                ),
                canDispatch: canDispatch
            )
            return decodeWrite(data: data, status: status, unconfirmedMessage: unconfirmed, fallbackRefusal: "Couldn’t update assignment.")
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .unconfirmed(message: unconfirmed)
        }
    }

    func setTodoState(
        workspace: UUID,
        todoID: UUID,
        baseVersion: Int,
        state: TodoState,
        requestID: UUID,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async -> TodoWriteOutcome<TodoWriteRecord> {
        let unconfirmed = "The to-do state may or may not have changed. Retry unchanged to check."
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
                ),
                canDispatch: canDispatch
            )
            return decodeWrite(data: data, status: status, unconfirmedMessage: unconfirmed, fallbackRefusal: "Couldn’t update to-do state.")
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .unconfirmed(message: unconfirmed)
        }
    }

    func answerOffer(
        workspace: UUID,
        todoID: UUID,
        offerID: UUID,
        answer: TodoOfferAnswer,
        requestID: UUID,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async -> TodoWriteOutcome<TodoWriteRecord> {
        let unconfirmed = "The request may or may not have been answered. Retry unchanged to check."
        do {
            let (data, status) = try await postCommand(
                workspace: workspace,
                commandID: requestID,
                command: AnswerOfferCommand(
                    todo_id: todoID.uuidString.lowercased(),
                    offer_id: offerID.uuidString.lowercased(),
                    answer: answer.rawValue
                ),
                canDispatch: canDispatch
            )
            return decodeWrite(data: data, status: status, unconfirmedMessage: unconfirmed, fallbackRefusal: "Couldn’t answer work request.")
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .unconfirmed(message: unconfirmed)
        }
    }

    func postComment(
        workspace: UUID,
        todoID: UUID,
        body: String,
        mentions: [TodoParty],
        requestID: UUID,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async -> TodoWriteOutcome<TodoComment> {
        let unconfirmed = "The comment may or may not have been posted. Retry unchanged to check."
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
                ),
                canDispatch: canDispatch
            )
            return decodeWrite(data: data, status: status, unconfirmedMessage: unconfirmed, fallbackRefusal: "Couldn’t post comment.")
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .unconfirmed(message: unconfirmed)
        }
    }

    func directory(
        workspace: UUID,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async throws -> TodoDirectory {
        struct Person: Decodable {
            let user_id: UUID
            let display_name: String?
        }
        struct Agent: Decodable {
            let principal_id: UUID
            let name: String
        }
        guard await canDispatch() else { throw CancellationError() }
        let filter = "eq." + workspace.uuidString.lowercased()
        async let peopleRows: [Person] = gatedRows("member_profiles", ["select": "user_id,display_name", "workspace_id": filter], canDispatch: canDispatch)
        async let agentRows: [Agent] = gatedRows("agent_principals", ["select": "principal_id,name", "workspace_id": filter, "revoked_at": "is.null"], canDispatch: canDispatch)
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
