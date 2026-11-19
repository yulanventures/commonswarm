import Foundation

enum AnswerChoiceOutcome: Equatable, Sendable {
    case accepted
    case failed(message: String, retryable: Bool)
}

enum MarkTodoDoneOutcome: Equatable, Sendable {
    case done
    case failed(message: String, retryable: Bool)
}

struct WaitingLoadSnapshot: Sendable {
    let items: [WaitingAskItem]
    let todos: [WaitingTodoItem]
    let workspaceComplete: [UUID: Bool]
    let workspaceFailed: [UUID: Bool]
    let enumeratedAllWorkspaces: Bool
}

struct WaitingOnYouAPI: Sendable {
    let api: ConversationAPI

    private static let askChoicesBatchSize = 50
    private static let maxDecisionQueuePages = 20
    private static let waitingTodosPageLimit = 50
    private static let maxWaitingTodosPages = 20
    private static let householdLocalSeat = "seat_0000000000000000000000"
    private static let todoSaveFailedMessage = "Couldn’t update that to-do. Try again."

    private struct ToolsUnavailableError: Error {}

    private struct PostgRESTErrorWire: Decodable {
        let code: String?
    }

    private struct WaitingTodoEntryWire: Decodable {
        let todo_id: UUID
        let title: String
        let state: String
        let due_on: String?
        let reason: WaitingTodoReason
        let agent_id: UUID?
        let state_at: String
        let placement: WaitingTodoPlacement
        let channel_id: UUID?
    }

    private struct WaitingTodosQueueWire: Decodable {
        let workspace_id: UUID
        let generated_at: String
        let total: Int
        let truncated: Bool
        let todos: [WaitingTodoEntryWire]
    }

    private struct HomeOverviewWire: Decodable {
        struct AssignedTodo: Decodable {
            let todo_id: UUID
            let title: String
            let state: String
            let due_on: String?
        }
        struct WaitingTodo: Decodable {
            let todo_id: UUID
            let title: String
            let state: String
            let due_on: String?
            let reason: WaitingTodoReason
            let agent_id: UUID?
        }
        struct NeedsYou: Decodable {
            let assigned: [AssignedTodo]
            let waiting: [WaitingTodo]
        }
        struct WorkspaceRow: Decodable {
            let workspace_id: UUID
            let needs_you: NeedsYou
        }
        let generated_at: String
        let workspaces: [WorkspaceRow]
    }

    private struct PartyWire: Decodable {
        let kind: String
        let id: UUID
    }

    private struct TodoWire: Decodable {
        let todo_id: UUID
        let title: String
        let state: String
        let version: Int
        let notes: String?
        let due_on: String?
        let assignee: PartyWire?
    }

    private struct TodoCommentWire: Decodable {
        let comment_id: UUID
        let author: PartyWire
        let body: String
        let created_at: String
    }

    private struct TodoReadReplyWire: Decodable {
        let status: String
        let reason: String?
        let todo: TodoWire?
        let comments: [TodoCommentWire]?
    }

    private struct TodoWriteReplyWire: Decodable {
        let status: String
        let reason: String?
        let current: TodoWire?
    }

    private struct MemberProfileWire: Decodable {
        let user_id: UUID
        let display_name: String?
    }

    private struct AgentPrincipalWire: Decodable {
        let principal_id: UUID
        let name: String?
    }

    private struct HouseholdToolCommand<Arguments: Encodable>: Encodable {
        let kind = "household_tool"
        let tool: String
        let arguments: Arguments
    }

    private struct TodoReadArgs: Encodable {
        let seat: String
        let todo_id: String
    }

    private struct TodoSetStateArgs: Encodable {
        let seat: String
        let request_id: String
        let todo_id: String
        let base_version: Int
        let state: String
    }

    private struct DecisionAskWire: Decodable {
        struct Sender: Decodable {
            let kind: String
            let id: UUID
            let name: String?
        }
        let signal_id: UUID
        let from: Sender
        let body: String
        let created_at: String
        let until: String
    }

    private struct DecisionQueueWire: Decodable {
        let workspace_id: UUID
        let generated_at: String
        let total: Int
        let truncated: Bool
        let asks: [DecisionAskWire]
    }

    private struct AskChoicesWire: Decodable {
        let asks: [WaitingAskChoiceState]
    }

    private struct ChannelWire: Decodable {
        let channel_id: UUID
        let slug: String
    }

    private struct CommandStream: Encodable {
        let kind = "workspace"
    }

    private struct AnswerChoiceV1Command: Encodable {
        let kind = "answer_choice"
        let signal_id: String
        let option_id: String
    }

    private struct AnswerChoiceV2Command: Encodable {
        let kind = "answer_choice"
        let signal_id: String
        let option_ids: [String]?
        let other_text: String?

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(kind, forKey: .kind)
            try container.encode(signal_id, forKey: .signal_id)
            if let option_ids, !option_ids.isEmpty {
                try container.encode(option_ids, forKey: .option_ids)
            }
            if let other_text {
                try container.encode(other_text, forKey: .other_text)
            }
        }

        private enum CodingKeys: String, CodingKey {
            case kind, signal_id, option_ids, other_text
        }
    }

    private struct CommandEnvelope<Command: Encodable>: Encodable {
        let command_id: String
        let workspace_id: String
        let client_version = ConversationAPI.clientVersion
        let stream = CommandStream()
        let command: Command
    }

    private struct CommandReceiptWire: Decodable {
        let status: String?
        let error: String?
        let message: String?
    }

    private func rpc<Body: Encodable, Output: Decodable>(_ name: String, body: Body) async throws -> Output {
        var request = api.request("rest/v1/rpc/" + name)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("swarm_read", forHTTPHeaderField: "Content-Profile")
        request.setValue("swarm_read", forHTTPHeaderField: "Accept-Profile")
        request.httpBody = try JSONEncoder().encode(body)
        return try await api.send(request)
    }

    private func decisionQueue(workspaceID: UUID) async throws -> (asks: [DecisionAskWire], complete: Bool)? {
        struct FirstArgs: Encodable { let p_workspace_id: String }
        struct PageArgs: Encodable {
            let p_workspace_id: String
            let p_after_created_at: String
            let p_after_id: String
        }

        let wsID = workspaceID.uuidString.lowercased()
        let first: DecisionQueueWire? = try await rpc("decision_queue", body: FirstArgs(p_workspace_id: wsID))
        guard let first else { return nil }
        if !first.truncated && first.asks.count >= first.total {
            return (first.asks, true)
        }

        var asks = first.asks
        var seen = Set(asks.map(\.signal_id))
        var page = first
        var truncated = true
        var pages = 1

        while truncated && pages < Self.maxDecisionQueuePages, let last = page.asks.last {
            let fetched: DecisionQueueWire?? = try? await rpc(
                "decision_queue_page",
                body: PageArgs(
                    p_workspace_id: wsID,
                    p_after_created_at: last.created_at,
                    p_after_id: last.signal_id.uuidString.lowercased()
                )
            )
            guard let nextPage = fetched ?? nil else {
                break
            }
            var added = 0
            for ask in nextPage.asks where !seen.contains(ask.signal_id) {
                seen.insert(ask.signal_id)
                asks.append(ask)
                added += 1
            }
            page = nextPage
            pages += 1
            if !nextPage.truncated || nextPage.asks.isEmpty || added == 0 {
                truncated = nextPage.truncated
                break
            }
        }
        return (asks, !truncated)
    }

    private func askChoices(workspaceID: UUID, signalIDs: [UUID]) async throws -> [WaitingAskChoiceState] {
        struct Args: Encodable {
            let p_workspace_id: String
            let p_signal_ids: [String]
        }
        guard !signalIDs.isEmpty else { return [] }
        let wsID = workspaceID.uuidString.lowercased()
        var out: [WaitingAskChoiceState] = []
        var offset = 0
        while offset < signalIDs.count {
            let end = min(offset + Self.askChoicesBatchSize, signalIDs.count)
            let chunk = signalIDs[offset..<end].map { $0.uuidString.lowercased() }
            let wire: AskChoicesWire = try await rpc("ask_choices", body: Args(p_workspace_id: wsID, p_signal_ids: chunk))
            out.append(contentsOf: wire.asks)
            offset = end
        }
        return out
    }

    private func signalLocations(workspaceID: UUID, signalIDs: [UUID]) async throws -> [UUID: WaitingSignalPlacement] {
        guard !signalIDs.isEmpty else { return [:] }
        let wsFilter = "eq." + workspaceID.uuidString.lowercased()
        func fetchBatch(_ ids: [UUID]) async throws -> [WaitingSignalPlacement] {
            var rows: [WaitingSignalPlacement] = []
            var offset = 0
            while offset < ids.count {
                let end = min(offset + Self.askChoicesBatchSize, ids.count)
                let joined = ids[offset..<end].map { $0.uuidString.lowercased() }.joined(separator: ",")
                let batch: [WaitingSignalPlacement] = try await api.rows(
                    "signals",
                    [
                        "select": "id,channel_id,to,to_agent,thread_root_id,from,from_kind",
                        "workspace_id": wsFilter,
                        "id": "in.(\(joined))",
                    ]
                )
                rows.append(contentsOf: batch)
                offset = end
            }
            return rows
        }

        var map: [UUID: WaitingSignalPlacement] = [:]
        for row in try await fetchBatch(signalIDs) {
            map[row.id] = row
        }
        let missingRoots = Array(Set(map.values.compactMap { loc -> UUID? in
            guard loc.channel_id == nil, let rootID = loc.thread_root_id, map[rootID] == nil else { return nil }
            return rootID
        }))
        if !missingRoots.isEmpty {
            for row in try await fetchBatch(missingRoots) {
                map[row.id] = row
            }
        }
        return map
    }

    private func rpcRaw<Body: Encodable>(_ name: String, body: Body) async throws -> (Data, Int) {
        var request = api.request("rest/v1/rpc/" + name)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("swarm_read", forHTTPHeaderField: "Content-Profile")
        request.setValue("swarm_read", forHTTPHeaderField: "Accept-Profile")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await api.session.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw APIError.invalidResponse }
        return (data, status)
    }

    private func waitingTodosPage(workspaceID: UUID) async throws -> (todos: [WaitingTodoEntryWire], complete: Bool)? {
        struct FirstArgs: Encodable {
            let p_workspace_id: String
            let p_limit: Int
        }
        struct PageArgs: Encodable {
            let p_workspace_id: String
            let p_limit: Int
            let p_after_state_at: String
            let p_after_todo_id: String
        }

        func fetchPage<Args: Encodable>(_ args: Args) async throws -> WaitingTodosQueueWire? {
            let (data, status) = try await rpcRaw("waiting_todos_page", body: args)
            if status == 404 {
                throw ToolsUnavailableError()
            }
            if status != 200 {
                if let err = try? JSONDecoder().decode(PostgRESTErrorWire.self, from: data),
                   err.code == "PGRST202" || err.code == "42883" {
                    throw ToolsUnavailableError()
                }
                throw APIError.refused(status)
            }
            let decoded = try JSONDecoder().decode(WaitingTodosQueueWire?.self, from: data)
            if let q = decoded {
                guard q.workspace_id == workspaceID, q.todos.count <= q.total else {
                    throw APIError.invalidResponse
                }
                for entry in q.todos {
                    if entry.placement == .channel && entry.channel_id == nil {
                        throw APIError.invalidResponse
                    }
                    if entry.state != "open" && entry.state != "doing" {
                        throw APIError.invalidResponse
                    }
                }
            }
            return decoded
        }

        let wsID = workspaceID.uuidString.lowercased()
        guard let first = try await fetchPage(FirstArgs(p_workspace_id: wsID, p_limit: Self.waitingTodosPageLimit)) else {
            return nil
        }
        if !first.truncated && first.todos.count >= first.total {
            return (first.todos, true)
        }

        var todos = first.todos
        var seen = Set(todos.map(\.todo_id))
        var page = first
        var truncated = true
        var pages = 1

        while truncated && pages < Self.maxWaitingTodosPages, let last = page.todos.last {
            guard let nextPage = try? await fetchPage(
                PageArgs(
                    p_workspace_id: wsID,
                    p_limit: Self.waitingTodosPageLimit,
                    p_after_state_at: last.state_at,
                    p_after_todo_id: last.todo_id.uuidString.lowercased()
                )
            ) else {
                break
            }
            var added = 0
            for todo in nextPage.todos where !seen.contains(todo.todo_id) {
                seen.insert(todo.todo_id)
                todos.append(todo)
                added += 1
            }
            page = nextPage
            pages += 1
            if !nextPage.truncated {
                truncated = false
                break
            }
            if added == 0 { break }
        }
        return (todos, !truncated && todos.count >= page.total)
    }

    private func homeOverview() async -> HomeOverviewWire? {
        struct EmptyArgs: Encodable {}
        guard let (data, status) = try? await rpcRaw("home_overview", body: EmptyArgs()),
              status == 200 else { return nil }
        return try? JSONDecoder().decode(HomeOverviewWire.self, from: data)
    }

    private static func extractOverviewTodos(
        row: HomeOverviewWire.WorkspaceRow,
        generatedAt: String,
        workspace: Workspace
    ) -> (todos: [WaitingTodoItem], complete: Bool) {
        var byID: [UUID: WaitingTodoItem] = [:]
        var order: [UUID] = []
        for todo in row.needs_you.assigned {
            if todo.state == "done" || todo.state == "dropped" { continue }
            byID[todo.todo_id] = WaitingTodoItem(
                id: todo.todo_id,
                workspaceID: workspace.id,
                workspaceName: workspace.name,
                title: todo.title,
                state: todo.state == "doing" ? "doing" : "open",
                dueOn: todo.due_on,
                reason: .assigned,
                agentID: nil,
                stateAt: generatedAt,
                placement: .workspace,
                channelID: nil,
                channelLabel: ""
            )
            order.append(todo.todo_id)
        }
        for todo in row.needs_you.waiting {
            if todo.state == "done" || todo.state == "dropped" { continue }
            let item = WaitingTodoItem(
                id: todo.todo_id,
                workspaceID: workspace.id,
                workspaceName: workspace.name,
                title: todo.title,
                state: todo.state == "doing" ? "doing" : "open",
                dueOn: todo.due_on,
                reason: todo.reason,
                agentID: todo.agent_id,
                stateAt: generatedAt,
                placement: .workspace,
                channelID: nil,
                channelLabel: ""
            )
            if byID[todo.todo_id] == nil {
                byID[todo.todo_id] = item
                order.append(todo.todo_id)
            } else if todo.reason == .request {
                byID[todo.todo_id] = item
            }
        }
        let todos = order.compactMap { byID[$0] }
        let atCap = row.needs_you.assigned.count >= 20 || row.needs_you.waiting.count >= 20
        return (todos, !atCap)
    }

    private func channelSlugs(workspaceID: UUID) async -> [UUID: String] {
        let filter = "eq." + workspaceID.uuidString.lowercased()
        guard let rows: [ChannelWire] = try? await api.rows(
            "channels",
            ["select": "channel_id,slug", "workspace_id": filter, "archived_at": "is.null"]
        ) else { return [:] }
        return Dictionary(uniqueKeysWithValues: rows.map { ($0.channel_id, "#" + $0.slug) })
    }

    private struct WorkspaceLoadInternal: Sendable {
        let workspace: Workspace
        let items: [WaitingAskItem]
        let todos: [WaitingTodoItem]
        let asksComplete: Bool
        let asksFailed: Bool
        let todosComplete: Bool
        let todosFailed: Bool
        let needsOverviewFallback: Bool
    }

    private func loadWorkspace(_ workspace: Workspace) async -> WorkspaceLoadInternal {
        async let asksResultTask: (asks: [DecisionAskWire], complete: Bool, ok: Bool) = {
            do {
                guard let queue = try await decisionQueue(workspaceID: workspace.id) else {
                    return ([], true, true)
                }
                return (queue.asks, queue.complete, true)
            } catch {
                return ([], false, false)
            }
        }()

        async let todosResultTask: (entries: [WaitingTodoEntryWire], complete: Bool, failed: Bool, fallback: Bool) = {
            do {
                guard let page = try await waitingTodosPage(workspaceID: workspace.id) else {
                    return ([], true, false, false)
                }
                return (page.todos, page.complete, false, false)
            } catch is ToolsUnavailableError {
                return ([], false, false, true)
            } catch {
                return ([], false, true, false)
            }
        }()

        let asksResult = await asksResultTask
        let todosResult = await todosResultTask

        let askIDs = asksResult.asks.map(\.signal_id)
        let todosNeedChannels = todosResult.entries.contains { $0.placement == .channel && $0.channel_id != nil }

        var items: [WaitingAskItem] = []
        var asksFailed = !asksResult.ok
        var asksComplete = asksResult.ok && asksResult.complete
        var channels: [UUID: String] = [:]

        if !askIDs.isEmpty {
            async let choicesTask = askChoices(workspaceID: workspace.id, signalIDs: askIDs)
            async let locationsTask = signalLocations(workspaceID: workspace.id, signalIDs: askIDs)
            async let channelsTask = channelSlugs(workspaceID: workspace.id)

            let choicesList = try? await choicesTask
            let locations: [UUID: WaitingSignalPlacement]
            let locationsFailed: Bool
            do {
                locations = try await locationsTask
                locationsFailed = false
            } catch {
                locations = [:]
                locationsFailed = true
            }
            channels = await channelsTask

            if let choicesList {
                let choicesByID = Dictionary(uniqueKeysWithValues: choicesList.map { ($0.signal_id, $0) })
                var anyUnknownLocation = false
                for ask in asksResult.asks {
                    guard let choiceState = choicesByID[ask.signal_id],
                          choiceState.answer == nil,
                          (2...6).contains(choiceState.options.count) else { continue }
                    let loc = locations[ask.signal_id]
                    let root = loc?.thread_root_id.flatMap { locations[$0] }
                    let conversation = WaitingChoiceRules.classifyConversation(loc, root: root)
                    if conversation == .unknown {
                        anyUnknownLocation = true
                    }
                    let fromKind: WaitingPartnerKind = ask.from.kind == "agent" ? .agent : .person
                    let senderName = ask.from.name?.trimmingCharacters(in: .whitespacesAndNewlines)
                    let displayName = (senderName?.isEmpty == false) ? senderName! : (fromKind == .agent ? "Agent" : "Member")
                    let channelLabel: String
                    switch conversation {
                    case .channel(let channelID):
                        channelLabel = channels[channelID] ?? "#channel"
                    case .general:
                        channelLabel = "#general"
                    case .dm:
                        channelLabel = displayName
                    case .group, .unknown:
                        channelLabel = ""
                    }
                    items.append(WaitingAskItem(
                        id: ask.signal_id,
                        workspaceID: workspace.id,
                        workspaceName: workspace.name,
                        conversation: conversation,
                        channelLabel: channelLabel,
                        fromKind: fromKind,
                        fromID: ask.from.id,
                        fromName: displayName,
                        body: ask.body,
                        createdAt: ask.created_at,
                        until: ask.until,
                        multi: choiceState.isMulti,
                        options: choiceState.options
                    ))
                }
                if locationsFailed || anyUnknownLocation {
                    asksFailed = true
                    asksComplete = false
                }
            } else {
                asksFailed = true
                asksComplete = false
            }
        } else if todosNeedChannels {
            channels = await channelSlugs(workspaceID: workspace.id)
        }

        let mappedTodos: [WaitingTodoItem] = todosResult.entries.map { entry in
            let channelLabel: String
            switch entry.placement {
            case .general:
                channelLabel = "#general"
            case .channel:
                if let chID = entry.channel_id {
                    channelLabel = channels[chID] ?? "#channel"
                } else {
                    channelLabel = ""
                }
            case .workspace:
                channelLabel = ""
            }
            return WaitingTodoItem(
                id: entry.todo_id,
                workspaceID: workspace.id,
                workspaceName: workspace.name,
                title: entry.title,
                state: entry.state,
                dueOn: entry.due_on,
                reason: entry.reason,
                agentID: entry.agent_id,
                stateAt: entry.state_at,
                placement: entry.placement,
                channelID: entry.placement == .channel ? entry.channel_id : nil,
                channelLabel: channelLabel
            )
        }

        return WorkspaceLoadInternal(
            workspace: workspace,
            items: items,
            todos: mappedTodos,
            asksComplete: asksComplete,
            asksFailed: asksFailed,
            todosComplete: todosResult.complete,
            todosFailed: todosResult.failed,
            needsOverviewFallback: todosResult.fallback
        )
    }

    func loadAll(currentWorkspaceID: UUID, currentWorkspaceName: String) async -> WaitingLoadSnapshot {
        let workspaces: [Workspace]
        let enumeratedAll: Bool
        if let fetched = try? await api.workspaces(), !fetched.isEmpty {
            workspaces = fetched
            enumeratedAll = true
        } else {
            workspaces = [Workspace(workspace_id: currentWorkspaceID, name: currentWorkspaceName)]
            enumeratedAll = false
        }

        let results = await withTaskGroup(of: WorkspaceLoadInternal.self, returning: [WorkspaceLoadInternal].self) { group in
            for ws in workspaces {
                group.addTask { await loadWorkspace(ws) }
            }
            var collected: [WorkspaceLoadInternal] = []
            for await result in group {
                collected.append(result)
            }
            return collected
        }

        let needsFallback = results.contains { $0.needsOverviewFallback }
        let overview: HomeOverviewWire? = needsFallback ? await homeOverview() : nil
        let overviewByWorkspace = Dictionary(
            uniqueKeysWithValues: (overview?.workspaces ?? []).map { ($0.workspace_id, $0) }
        )

        let orderIndex = Dictionary(uniqueKeysWithValues: workspaces.enumerated().map { ($0.element.id, $0.offset) })
        let sortedResults = results.sorted { (orderIndex[$0.workspace.id] ?? .max) < (orderIndex[$1.workspace.id] ?? .max) }
        var allItems: [WaitingAskItem] = []
        var allTodos: [WaitingTodoItem] = []
        var completeMap: [UUID: Bool] = [:]
        var failedMap: [UUID: Bool] = [:]
        for result in sortedResults {
            allItems.append(contentsOf: result.items)
            var todos = result.todos
            var todosComplete = result.todosComplete
            var todosFailed = result.todosFailed
            if result.needsOverviewFallback {
                if let overview, let row = overviewByWorkspace[result.workspace.id] {
                    let extracted = Self.extractOverviewTodos(
                        row: row,
                        generatedAt: overview.generated_at,
                        workspace: result.workspace
                    )
                    todos = extracted.todos
                    todosComplete = extracted.complete
                    todosFailed = false
                } else {
                    todosComplete = false
                    todosFailed = true
                }
            }
            allTodos.append(contentsOf: todos)
            let anyFailed = result.asksFailed || todosFailed
            completeMap[result.workspace.id] = result.asksComplete && todosComplete && !anyFailed
            failedMap[result.workspace.id] = anyFailed
        }
        return WaitingLoadSnapshot(
            items: allItems,
            todos: allTodos,
            workspaceComplete: completeMap,
            workspaceFailed: failedMap,
            enumeratedAllWorkspaces: enumeratedAll
        )
    }

    private func postHouseholdTool<Args: Encodable>(
        workspaceID: UUID,
        commandID: UUID,
        tool: String,
        arguments: Args
    ) async throws -> (Data, Int) {
        var request = api.request("functions/v1/command")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let envelope = CommandEnvelope(
            command_id: commandID.uuidString.lowercased(),
            workspace_id: workspaceID.uuidString.lowercased(),
            command: HouseholdToolCommand(tool: tool, arguments: arguments)
        )
        request.httpBody = try JSONEncoder().encode(envelope)
        let (data, response) = try await api.session.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode else {
            throw APIError.invalidResponse
        }
        return (data, status)
    }

    private static func todoRefusalMessage(_ reason: String?) -> String {
        switch reason {
        case "todo_not_found":
            return "This to-do is no longer available."
        case "not_assignee", "not_permitted", "owner_only", "workspace_access_refused":
            return "You can’t update this to-do."
        case "content_read_only", "content_consent_required":
            return "To-dos are read-only in this workspace."
        case "invalid_transition":
            return "This to-do can’t be marked done right now."
        case "todo_write_rate_limited":
            return "Too many changes at once. Try again in a moment."
        default:
            return Self.todoSaveFailedMessage
        }
    }

    func markTodoDone(workspaceID: UUID, todoID: UUID) async -> MarkTodoDoneOutcome {
        do {
            let (readData, readStatus) = try await postHouseholdTool(
                workspaceID: workspaceID,
                commandID: UUID(),
                tool: "todo_read",
                arguments: TodoReadArgs(seat: Self.householdLocalSeat, todo_id: todoID.uuidString.lowercased())
            )
            guard readStatus == 200,
                  let readReply = try? JSONDecoder().decode(TodoReadReplyWire.self, from: readData) else {
                return .failed(message: Self.todoSaveFailedMessage, retryable: true)
            }
            if readReply.status == "refused" {
                return .failed(message: Self.todoRefusalMessage(readReply.reason), retryable: true)
            }
            guard readReply.status == "ok", let todo = readReply.todo else {
                return .failed(message: Self.todoSaveFailedMessage, retryable: true)
            }
            if todo.state == "done" || todo.state == "dropped" {
                return .done
            }

            func sendSetState(baseVersion: Int) async throws -> TodoWriteReplyWire {
                let reqID = UUID()
                let (data, status) = try await postHouseholdTool(
                    workspaceID: workspaceID,
                    commandID: reqID,
                    tool: "todo_set_state",
                    arguments: TodoSetStateArgs(
                        seat: Self.householdLocalSeat,
                        request_id: reqID.uuidString.lowercased(),
                        todo_id: todoID.uuidString.lowercased(),
                        base_version: baseVersion,
                        state: "done"
                    )
                )
                guard status == 200 || status == 409,
                      let reply = try? JSONDecoder().decode(TodoWriteReplyWire.self, from: data) else {
                    throw APIError.refused(status)
                }
                return reply
            }

            var reply = try await sendSetState(baseVersion: todo.version)
            if reply.status == "conflict", let current = reply.current {
                if current.state == "done" || current.state == "dropped" {
                    return .done
                }
                reply = try await sendSetState(baseVersion: current.version)
            }
            if reply.status == "committed" {
                return .done
            }
            if reply.status == "refused" {
                return .failed(message: Self.todoRefusalMessage(reply.reason), retryable: true)
            }
            return .failed(message: Self.todoSaveFailedMessage, retryable: true)
        } catch {
            return .failed(message: Self.todoSaveFailedMessage, retryable: true)
        }
    }

    func readTodoDetail(workspaceID: UUID, todoID: UUID) async throws -> WaitingTodoDetail {
        let (data, status) = try await postHouseholdTool(
            workspaceID: workspaceID,
            commandID: UUID(),
            tool: "todo_read",
            arguments: TodoReadArgs(seat: Self.householdLocalSeat, todo_id: todoID.uuidString.lowercased())
        )
        guard status == 200,
              let reply = try? JSONDecoder().decode(TodoReadReplyWire.self, from: data),
              reply.status == "ok",
              let todo = reply.todo else {
            throw APIError.refused(status)
        }

        let wsFilter = "eq." + workspaceID.uuidString.lowercased()
        async let membersTask: [MemberProfileWire]? = try? await api.rows(
            "member_profiles",
            ["select": "user_id,display_name", "workspace_id": wsFilter]
        )
        async let agentsTask: [AgentPrincipalWire]? = try? await api.rows(
            "agent_principals",
            ["select": "principal_id,name", "workspace_id": wsFilter]
        )
        let members = await membersTask ?? []
        let agents = await agentsTask ?? []
        let userNames = Dictionary(uniqueKeysWithValues: members.compactMap { row -> (UUID, String)? in
            let trimmed = row.display_name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : (row.user_id, trimmed)
        })
        let agentNames = Dictionary(uniqueKeysWithValues: agents.compactMap { row -> (UUID, String)? in
            let trimmed = row.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : (row.principal_id, trimmed)
        })

        let viewerID = await MainActor.run { api.session.userID }
        func resolveParty(_ party: PartyWire?) -> (name: String, isAgent: Bool) {
            guard let party else { return ("Unassigned", false) }
            if party.kind == "agent" {
                return (agentNames[party.id] ?? "Agent", true)
            }
            if party.id == viewerID { return ("You", false) }
            return (userNames[party.id] ?? "Member", false)
        }

        let assignee = resolveParty(todo.assignee)
        let comments: [WaitingTodoComment] = (reply.comments ?? []).map { comment in
            let author = resolveParty(comment.author)
            return WaitingTodoComment(
                id: comment.comment_id,
                authorName: author.name,
                authorIsAgent: author.isAgent,
                body: comment.body,
                createdAt: comment.created_at
            )
        }

        return WaitingTodoDetail(
            id: todo.todo_id,
            workspaceID: workspaceID,
            title: todo.title,
            state: todo.state,
            version: todo.version,
            notes: todo.notes,
            dueOn: todo.due_on,
            assigneeName: assignee.name,
            assigneeIsAgent: assignee.isAgent,
            comments: comments
        )
    }

    func answerChoice(
        commandID: UUID,
        workspaceID: UUID,
        signalID: UUID,
        multi: Bool,
        submission: WaitingChoiceSubmission
    ) async -> AnswerChoiceOutcome {
        let useV1 = !multi && submission.otherText == nil && submission.optionIds.count == 1
        var request = api.request("functions/v1/command")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            if useV1, let optionID = submission.optionIds.first {
                let envelope = CommandEnvelope(
                    command_id: commandID.uuidString.lowercased(),
                    workspace_id: workspaceID.uuidString.lowercased(),
                    command: AnswerChoiceV1Command(
                        signal_id: signalID.uuidString.lowercased(),
                        option_id: optionID
                    )
                )
                request.httpBody = try JSONEncoder().encode(envelope)
            } else {
                let envelope = CommandEnvelope(
                    command_id: commandID.uuidString.lowercased(),
                    workspace_id: workspaceID.uuidString.lowercased(),
                    command: AnswerChoiceV2Command(
                        signal_id: signalID.uuidString.lowercased(),
                        option_ids: submission.optionIds.isEmpty ? nil : submission.optionIds,
                        other_text: submission.otherText
                    )
                )
                request.httpBody = try JSONEncoder().encode(envelope)
            }
            let (data, response) = try await api.session.data(for: request)
            guard let status = (response as? HTTPURLResponse)?.statusCode else {
                return .failed(message: WaitingChoiceRules.answerFailedMessage, retryable: true)
            }
            let receipt = try? JSONDecoder().decode(CommandReceiptWire.self, from: data)
            if status == 200 && receipt?.status == "accepted" {
                return .accepted
            }
            if status == 400 && (receipt?.error == "invalid_request" || receipt?.error == nil) {
                let msg = useV1 ? WaitingChoiceRules.answerFailedMessage : WaitingChoiceRules.answerUnsupportedMessage
                return .failed(message: msg, retryable: useV1)
            }
            let message = (receipt?.message?.isEmpty == false) ? receipt!.message! : WaitingChoiceRules.answerFailedMessage
            return .failed(message: message, retryable: status >= 500 || status == 408 || status == 429)
        } catch {
            return .failed(message: WaitingChoiceRules.answerFailedMessage, retryable: true)
        }
    }
}
