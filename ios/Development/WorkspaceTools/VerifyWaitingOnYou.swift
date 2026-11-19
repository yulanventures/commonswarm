import Foundation

@main
struct VerifyWaitingOnYou {
    static func expect(_ condition: Bool, _ message: String) {
        if !condition {
            fputs("FAIL: \(message)\n", stderr)
            exit(1)
        }
    }

    static func postFixture(_ url: URL) async throws {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        let (_, _) = try await URLSession.shared.data(for: req)
    }

    static func main() async throws {
        guard CommandLine.arguments.count >= 2, let port = Int(CommandLine.arguments[1]) else {
            fputs("Usage: VerifyWaitingOnYou <port>\n", stderr)
            exit(2)
        }
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let publicKey = "local-fixture"

        // Sign in via real email OTP flow
        let emailAPI = EmailCodeAPI(origin: origin, publicKey: publicKey)
        try await emailAPI.send(to: "reader@example.test")
        let tokens = try await emailAPI.verify(email: "reader@example.test", code: "012345")
        let session = await MainActor.run {
            HumanSession(userID: tokens.userID) { tokens.accessToken }
        }
        let convAPI = ConversationAPI(origin: origin, publicKey: publicKey, session: session)
        let workspaces = try await convAPI.workspaces()
        expect(workspaces.count == 2, "Expected 2 workspaces")
        let mainWS = workspaces[0]

        let waitingAPI = WaitingOnYouAPI(api: convAPI)
        let generalPlace = WaitingPlace(workspaceID: mainWS.id, workspaceName: mainWS.name, conversation: .general, label: "#general")
        let store = await MainActor.run { WaitingOnYouStore(place: generalPlace) }

        // 1. Force 1-item pages on waiting_todos_page to verify keyset pagination across all pages
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/todos-page-size?n=1")!)
        await store.load(api: waitingAPI)
        let initialCounts = await MainActor.run { store.counts }
        expect(initialCounts.channel == WaitingScopeCount(min: 2, complete: true), "Expected 2 (1 ask + 1 #general todo) in #general, got \(initialCounts.channel)")
        expect(initialCounts.workspace == WaitingScopeCount(min: 6, complete: true), "Expected 6 (3 asks + 3 todos) in workspace, got \(initialCounts.workspace)")
        expect(initialCounts.all == WaitingScopeCount(min: 8, complete: true), "Expected 8 (4 asks + 4 todos) across all workspaces, got \(initialCounts.all)")

        let generalAsks = await MainActor.run { store.visibleItems }
        let generalTodos = await MainActor.run { store.visibleTodos }
        expect(generalAsks.count == 1, "Expected 1 visible ask in #general")
        expect(generalTodos.count == 1, "Expected 1 visible #general todo, got \(generalTodos.count)")
        let firstAsk = generalAsks[0]
        let generalTodo = generalTodos[0]
        expect(generalTodo.canMarkDone, "Assigned todo must allow Mark done")
        expect(generalTodo.formattedDue == "Due Nov 24", "Expected local due date Due Nov 24, got \(String(describing: generalTodo.formattedDue))")
        expect(generalTodo.locationText(for: .channel) == nil, "Channel scope must omit redundant location label")
        expect(generalTodo.locationText(for: .workspace) == "#general", "Workspace scope must show #general")
        expect(generalTodo.locationText(for: .all) == "Simulator workspace · #general", "All scope must show workspace + channel")

        // Verify DM scope never receives workspace-only or channel todos
        let atlasID = UUID(uuidString: "00000000-0000-4000-8000-000000000002")!
        let dmPlace = WaitingPlace(workspaceID: mainWS.id, workspaceName: mainWS.name, conversation: .dm(.agent, atlasID), label: "Atlas")
        let allLoadedTodos = await MainActor.run { store.todos }
        expect(WaitingChoiceRules.filterTodos(allLoadedTodos, scope: .channel, place: dmPlace).isEmpty, "DM must never show workspace or channel todos")

        // Verify #mobile channel scope shows only the #mobile-placed request todo (and canMarkDone == false)
        let mobileChID = UUID(uuidString: "00000000-0000-4000-8000-000000000004")!
        let mobilePlace = WaitingPlace(workspaceID: mainWS.id, workspaceName: mainWS.name, conversation: .channel(mobileChID), label: "#mobile")
        let mobileTodos = WaitingChoiceRules.filterTodos(allLoadedTodos, scope: .channel, place: mobilePlace)
        expect(mobileTodos.count == 1 && mobileTodos[0].reason == .request && !mobileTodos[0].canMarkDone, "Expected 1 non-markable request todo in #mobile")
        expect(mobileTodos[0].channelLabel == "#mobile", "Expected #mobile channel label, got \(mobileTodos[0].channelLabel)")

        // Verify recommended option comes first
        expect(firstAsk.orderedOptions.first?.id == "ship" && firstAsk.orderedOptions.first?.isRecommended == true, "Recommended option must sort first")
        expect(firstAsk.prompt.question == "Should we publish build 14 to internal testers now?", "Prompt split should extract trailing question")

        // 2. Verify ask failure keeps card editable & retry reuses same command_id
        try await postFixture(origin.appending(path: "fixture/fail-next"))
        await store.submitSingleOption("ship", for: firstAsk, api: waitingAPI)
        let failState = await MainActor.run { store.failuresBySignal[firstAsk.id] }
        expect(failState != nil && failState?.retryable == true, "Expected retryable failure on 503")
        expect(await MainActor.run { store.visibleItems.count } == 1, "Failed card must stay visible")

        await store.retry(for: firstAsk, api: waitingAPI)
        expect(await MainActor.run { store.visibleItems.count } == 0, "Answered card must leave list")
        let sentBanner = await MainActor.run { store.sentBanner }
        expect(sentBanner == "Sent", "Expected visible Sent banner, got \(String(describing: sentBanner))")

        // 3. Verify Mark done failure -> Retry -> HTTP 409 conflict auto-retry -> committed + Done banner
        try await postFixture(origin.appending(path: "fixture/fail-next-todo"))
        await store.markTodoDone(generalTodo, api: waitingAPI)
        let todoFail = await MainActor.run { store.failuresByTodo[generalTodo.id] }
        expect(todoFail != nil && todoFail?.retryable == true, "Expected retryable failure on todo 503")
        expect(await MainActor.run { store.visibleTodos.count } == 1, "Failed todo card must stay visible")

        try await postFixture(origin.appending(path: "fixture/conflict-next-todo"))
        await store.markTodoDone(generalTodo, api: waitingAPI)
        expect(await MainActor.run { store.visibleTodos.isEmpty }, "Completed todo must leave list")
        let doneBanner = await MainActor.run { store.sentBanner }
        expect(doneBanner == "Done", "Expected visible Done banner, got \(String(describing: doneBanner))")
        let countsAfterGeneralCleared = await MainActor.run { store.counts }
        expect(countsAfterGeneralCleared.channel.min == 0, "Expected 0 waiting in #general after both cleared, got \(countsAfterGeneralCleared.channel.min)")
        expect(countsAfterGeneralCleared.workspace.min == 4, "Expected 4 waiting in workspace (2 asks + 2 todos), got \(countsAfterGeneralCleared.workspace.min)")

        // Verify todo_set_state wire commands (failed + conflict + retried with incremented version, seat + request_id == command_id)
        struct RecordedTodoCommand: Decodable {
            struct Args: Decodable {
                let seat: String
                let request_id: String
                let todo_id: String
                let base_version: Int
                let state: String
            }
            let command_id: String
            let tool: String
            let arguments: Args
        }
        let (todoCmdData, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/todo-commands"))
        let recordedTodos = try JSONDecoder().decode([RecordedTodoCommand].self, from: todoCmdData)
        expect(recordedTodos.count == 3, "Expected 3 todo_set_state calls (1 503 + 1 409 conflict + 1 retry), got \(recordedTodos.count)")
        expect(recordedTodos.allSatisfy { $0.arguments.seat == "seat_0000000000000000000000" && $0.arguments.request_id == $0.command_id && $0.arguments.state == "done" }, "All todo_set_state calls must carry seat, request_id == command_id, and state == done")
        expect(recordedTodos[2].arguments.base_version == recordedTodos[1].arguments.base_version + 1, "Conflict retry must bump base_version from current.version")

        // 4. Verify Open (readTodoDetail) resolves display names (no UUIDs) and comments
        let detail = try await waitingAPI.readTodoDetail(workspaceID: mainWS.id, todoID: mobileTodos[0].id)
        expect(detail.title == "Review dark mode token audit for iPhone SE", "Unexpected detail title")
        expect(detail.assigneeName == "Atlas" && detail.assigneeIsAgent, "Expected Atlas agent assignee")
        expect(detail.formattedDue == "Due Nov 26", "Expected Due Nov 26")
        expect(detail.comments.count == 1 && detail.comments[0].authorName == "Atlas", "Expected resolved comment author")

        // 5. Verify multi-select + Other answer uses v2 wire format
        await MainActor.run { store.scope = .workspace }
        let mobileAsk = await MainActor.run { store.visibleItems.first { $0.multi }! }
        await MainActor.run {
            store.toggleOption("todos", for: mobileAsk)
            store.updateOtherText("Also check VoiceOver focus", for: mobileAsk.id)
        }
        await store.submitDraft(for: mobileAsk, api: waitingAPI)
        let remainingWorkspace = await MainActor.run { store.counts.workspace.min }
        expect(remainingWorkspace == 3, "Expected 3 remaining items (1 ask + 2 todos) in workspace, got \(remainingWorkspace)")

        // 6. Verify home_overview fallback when waiting_todos_page returns 404 (PGRST202)
        try await postFixture(origin.appending(path: "fixture/hide-waiting-todos-rpc"))
        let fallbackStore = await MainActor.run { WaitingOnYouStore(place: generalPlace) }
        await fallbackStore.load(api: waitingAPI)
        let fallbackTodos = await MainActor.run { fallbackStore.todos }
        expect(fallbackTodos.count == 3, "Expected 3 remaining open/doing todos via home_overview fallback (deduplicated), got \(fallbackTodos.count)")
        let fallbackRequest = fallbackTodos.first { $0.id == mobileTodos[0].id }
        expect(fallbackRequest?.reason == .request && fallbackRequest?.canMarkDone == false, "Fallback must let request replace assigned for duplicate todo_id")
        expect(await MainActor.run { fallbackStore.visibleTodos.isEmpty }, "Fallback workspace-only todos must not clutter #general")
        try await postFixture(origin.appending(path: "fixture/show-waiting-todos-rpc"))

        // 7. Inspect ask wire commands recorded by fixture
        struct RecordedCommand: Decodable {
            struct Body: Decodable {
                let kind: String
                let signal_id: String
                let option_id: String?
                let option_ids: [String]?
                let other_text: String?
            }
            let command_id: String
            let command: Body
        }
        let (cmdData, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/commands"))
        let recorded = try JSONDecoder().decode([RecordedCommand].self, from: cmdData)
        expect(recorded.count == 3, "Expected 3 ask commands (1 failed + 1 retry + 1 v2), got \(recorded.count)")
        expect(recorded[0].command_id == recorded[1].command_id, "Retry must reuse original command_id")
        expect(recorded[0].command.option_id == "ship" && recorded[0].command.option_ids == nil && recorded[0].command.other_text == nil, "Single choice must use v1 exact shape")
        expect(recorded[2].command.option_id == nil && recorded[2].command.option_ids == ["todos"] && recorded[2].command.other_text == "Also check VoiceOver focus", "Multi+Other must use v2 shape")

        // 8. Placement rule unit checks (missing root -> unknown, never #general; thread destinations)
        let unknown = WaitingChoiceRules.classifyConversation(nil)
        expect(unknown == .unknown, "nil placement must be .unknown")
        let replyNoRoot = WaitingSignalPlacement(id: UUID(), channel_id: nil, to: nil, to_agent: nil, thread_root_id: UUID(), from: UUID(), from_kind: "agent")
        expect(WaitingChoiceRules.classifyConversation(replyNoRoot, root: nil) == .unknown, "thread reply without root must be .unknown")
        expect(WaitingChoiceRules.cleanOtherText("hello\u{0007}") == nil, "Control chars must be rejected")

        let threadChannelID = UUID()
        let threadGeneral = WaitingPlace(workspace: mainWS, conversation: Conversation(destination: .thread(UUID(), .general), name: "#general", symbol: "number"))
        expect(threadGeneral.conversation == .general, "Thread general must map to .general")
        let threadChannel = WaitingPlace(workspace: mainWS, conversation: Conversation(destination: .thread(UUID(), .publicChannel), name: "#mobile", symbol: "number"), channelID: threadChannelID)
        expect(threadChannel.conversation == .channel(threadChannelID), "Thread channel must map to .channel(channelID)")
        let threadDM = WaitingPlace(
            workspace: mainWS,
            conversation: Conversation(destination: .thread(UUID(), .dm), name: "Atlas", symbol: "cpu"),
            viewerID: session.userID,
            directory: [
                Conversation(destination: .person(session.userID), name: "You", symbol: "person"),
                Conversation(destination: .agent(atlasID), name: "Atlas", symbol: "cpu"),
            ]
        )
        expect(threadDM.conversation == .dm(.agent, atlasID), "Thread DM must map to .dm(.agent, atlasID)")
        let threadGroup = WaitingPlace(workspace: mainWS, conversation: Conversation(destination: .thread(UUID(), .group), name: "Team", symbol: "person.2"))
        expect(threadGroup.conversation == .unknown, "Thread group DM must map to .unknown")

        print("PASS: VerifyWaitingOnYou (asks + paginated todos, home_overview fallback, scope filters, Mark done retry+conflict, todo detail, v1/v2 answer_choice)")
    }
}
