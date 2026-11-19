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

        // 0. Exercise real conversation directory path (POST /functions/v1/read -> HTTP 200)
        let directoryRows = try await convAPI.conversationList(mainWS.id)
        expect(directoryRows != nil, "Expected modern conversationList response from POST /functions/v1/read")
        let rows = directoryRows ?? []
        let generalRow = rows.first { $0.kind == .general }!
        let groupRows = rows.filter { $0.kind == .group }
        expect(groupRows.count == 2, "Expected two distinct group DMs in directory, got \(groupRows.count)")

        let waitingAPI = WaitingOnYouAPI(api: convAPI)
        let generalPlace = WaitingPlace(
            workspace: mainWS,
            conversation: generalRow.item(viewer: tokens.userID),
            viewerID: tokens.userID,
            directory: (generalRow.members ?? []).map(\.contact),
            channelID: generalRow.channel_id
        )
        expect(generalPlace.conversation == .general, "Directory #general must resolve to .general")

        // 1. Missing placement on #general ask + two distinct group DMs via directory:
        //    neither group DM may match the unresolved ask or workspace/channel todos; queue stays incomplete with Retry.
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/omit-location?id=30000000-0000-4000-8000-000000000001")!)
        let groupPlaceA = WaitingPlace(
            workspace: mainWS,
            conversation: groupRows[0].item(viewer: tokens.userID),
            viewerID: tokens.userID,
            directory: (groupRows[0].members ?? []).map(\.contact),
            channelID: groupRows[0].channel_id
        )
        let groupPlaceB = WaitingPlace(
            workspace: mainWS,
            conversation: groupRows[1].item(viewer: tokens.userID),
            viewerID: tokens.userID,
            directory: (groupRows[1].members ?? []).map(\.contact),
            channelID: groupRows[1].channel_id
        )
        expect(groupPlaceA.conversation != groupPlaceB.conversation, "Distinct group DMs must have distinct conversation identities")
        let groupStoreA = await MainActor.run { WaitingOnYouStore(place: groupPlaceA) }
        let groupStoreB = await MainActor.run { WaitingOnYouStore(place: groupPlaceB) }
        await groupStoreA.load(api: waitingAPI)
        await groupStoreB.load(api: waitingAPI)
        expect(await MainActor.run { groupStoreA.visibleItems.isEmpty && groupStoreA.visibleTodos.isEmpty }, "Group A must not receive unresolved ask or non-group todos")
        expect(await MainActor.run { groupStoreB.visibleItems.isEmpty && groupStoreB.visibleTodos.isEmpty }, "Group B must not receive unresolved ask or non-group todos")
        expect(await MainActor.run { groupStoreA.scopeFailed && !groupStoreA.scopeComplete }, "Missing location must mark scope failed/incomplete (never false empty state)")
        expect(await MainActor.run { groupStoreA.counts.all.badgeText == "8+" }, "Incomplete cross-workspace header badge must show 8+, got \(await MainActor.run { groupStoreA.counts.all.badgeText })")
        try await postFixture(origin.appending(path: "fixture/restore-locations"))

        // 2. Force 1-item pages on waiting_todos_page to verify keyset pagination across all pages
        let store = await MainActor.run { WaitingOnYouStore(place: generalPlace) }
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

        // 3. Verify ask failure keeps card editable & retry reuses same command_id
        try await postFixture(origin.appending(path: "fixture/fail-next"))
        await store.submitSingleOption("ship", for: firstAsk, api: waitingAPI)
        let failState = await MainActor.run { store.failuresBySignal[firstAsk.id] }
        expect(failState != nil && failState?.retryable == true, "Expected retryable failure on 503")
        expect(await MainActor.run { store.visibleItems.count } == 1, "Failed card must stay visible")

        await store.retry(for: firstAsk, api: waitingAPI)
        expect(await MainActor.run { store.visibleItems.count } == 0, "Answered card must leave list")
        let sentBanner = await MainActor.run { store.sentBanner }
        expect(sentBanner == "Sent", "Expected visible Sent banner, got \(String(describing: sentBanner))")

        // 4. Verify Mark done failure -> Retry -> HTTP 409 conflict auto-retry -> committed + Done banner
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

        // 5. Verify Open (readTodoDetail) decodes real server Actor comment authors (user_id + principal_id) AND honors next_comment_offset
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/comments-page-size?n=2")!)
        let generalDetailPage1 = try await waitingAPI.readTodoDetail(workspaceID: mainWS.id, todoID: generalTodo.id)
        expect(generalDetailPage1.comments.count == 2, "Expected 2 comments on page 1, got \(generalDetailPage1.comments.count)")
        expect(generalDetailPage1.comments[0].authorName == "Maya Chen" && !generalDetailPage1.comments[0].authorIsAgent, "Expected person Actor comment decoded as Maya Chen")
        expect(generalDetailPage1.comments[1].authorName == "Atlas" && generalDetailPage1.comments[1].authorIsAgent, "Expected agent Actor comment decoded as Atlas")
        expect(generalDetailPage1.nextCommentOffset == 2, "Expected next_comment_offset == 2, got \(String(describing: generalDetailPage1.nextCommentOffset))")

        let generalDetailPage2 = try await waitingAPI.readTodoDetail(workspaceID: mainWS.id, todoID: generalTodo.id, commentOffset: 2)
        let mergedDetail = generalDetailPage1.appendingComments(generalDetailPage2.comments, nextOffset: generalDetailPage2.nextCommentOffset)
        expect(mergedDetail.comments.count == 3 && mergedDetail.comments[2].authorName == "You" && mergedDetail.nextCommentOffset == nil, "Expected page 2 comment authored by You and nil nextCommentOffset")
        try await postFixture(origin.appending(path: "fixture/comments-page-size"))

        let detail = try await waitingAPI.readTodoDetail(workspaceID: mainWS.id, todoID: mobileTodos[0].id)
        expect(detail.title == "Review dark mode token audit for iPhone SE", "Unexpected detail title")
        expect(detail.assigneeName == "Atlas" && detail.assigneeIsAgent, "Expected Atlas agent assignee")
        expect(detail.formattedDue == "Due Nov 26", "Expected Due Nov 26")
        expect(detail.comments.count == 1 && detail.comments[0].authorName == "Atlas" && detail.comments[0].authorIsAgent, "Expected resolved agent Actor comment author")

        // 5b. Verify Dropped distinction: conflict returning Dropped AND already-dropped todo NEVER announce Done
        let wsAssignedTodo = await MainActor.run { store.todos.first { $0.id == UUID(uuidString: "50000000-0000-4000-8000-000000000003")! }! }
        try await postFixture(origin.appending(path: "fixture/conflict-drop-next-todo"))
        await store.markTodoDone(wsAssignedTodo, api: waitingAPI)
        let conflictDroppedBanner = await MainActor.run { store.statusBanner }
        expect(conflictDroppedBanner?.kind == .dropped && conflictDroppedBanner?.text == "This to-do was dropped.", "Conflict returning Dropped must announce dropped, NOT Done; got \(String(describing: conflictDroppedBanner))")
        expect(await MainActor.run { !store.todos.contains(where: { $0.id == wsAssignedTodo.id }) }, "Stale dropped card must leave list")

        // Also verify initial todo_read seeing already-dropped returns .dropped (NOT .done)
        let alreadyDroppedOutcome = await waitingAPI.markTodoDone(workspaceID: mainWS.id, todoID: wsAssignedTodo.id)
        expect(alreadyDroppedOutcome == .dropped, "Already-dropped to-do must return .dropped, got \(alreadyDroppedOutcome)")
        let droppedDetail = try await waitingAPI.readTodoDetail(workspaceID: mainWS.id, todoID: wsAssignedTodo.id)
        expect(droppedDetail.state == "dropped", "Fresh detail must report state == dropped")

        // 6. Verify multi-select + Other answer uses v2 wire format
        await MainActor.run { store.scope = .workspace }
        let mobileAsk = await MainActor.run { store.visibleItems.first { $0.multi }! }
        await MainActor.run {
            store.toggleOption("todos", for: mobileAsk)
            store.updateOtherText("Also check VoiceOver focus", for: mobileAsk.id)
        }
        await store.submitDraft(for: mobileAsk, api: waitingAPI)
        let remainingWorkspace = await MainActor.run { store.counts.workspace.min }
        expect(remainingWorkspace == 2, "Expected 2 remaining items (1 ask + 1 request todo) in workspace, got \(remainingWorkspace)")

        // 7. Verify home_overview fallback when waiting_todos_page returns PGRST202 (and marks incomplete when at 20-row cap)
        try await postFixture(origin.appending(path: "fixture/hide-waiting-todos-rpc"))
        let fallbackStore = await MainActor.run { WaitingOnYouStore(place: generalPlace) }
        await fallbackStore.load(api: waitingAPI)
        let fallbackTodos = await MainActor.run { fallbackStore.todos }
        expect(fallbackTodos.count == 2, "Expected 2 remaining open/doing todos via home_overview fallback (deduplicated), got \(fallbackTodos.count)")
        let fallbackRequest = fallbackTodos.first { $0.id == mobileTodos[0].id }
        expect(fallbackRequest?.reason == .request && fallbackRequest?.canMarkDone == false, "Fallback must let request replace assigned for duplicate todo_id")
        expect(await MainActor.run { fallbackStore.visibleTodos.isEmpty }, "Fallback workspace-only todos must not clutter #general")
        expect(await MainActor.run { fallbackStore.scopeComplete && !fallbackStore.scopeFailed }, "Uncapped home_overview fallback should complete cleanly")

        // At 20-row home_overview cap -> must mark incomplete (N+), never claiming a complete count
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/cap-home-overview?on=1")!)
        let cappedStore = await MainActor.run { WaitingOnYouStore(place: generalPlace) }
        await cappedStore.load(api: waitingAPI)
        expect(await MainActor.run { !cappedStore.scopeComplete && !cappedStore.counts.workspace.complete && cappedStore.counts.workspace.badgeText.hasSuffix("+") }, "Capped home_overview fallback must stay incomplete with + badge")

        // Non-missing failure (503 or bare 404 without PGRST202/42883) -> must NOT fall back and must mark failed/incomplete
        try await postFixture(origin.appending(path: "fixture/show-waiting-todos-rpc"))
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/fail-waiting-todos-rpc?status=503")!)
        let failedTodosStore = await MainActor.run { WaitingOnYouStore(place: generalPlace) }
        await failedTodosStore.load(api: waitingAPI)
        expect(await MainActor.run { failedTodosStore.scopeFailed && !failedTodosStore.scopeComplete }, "503 on waiting_todos_page must mark scopeFailed and !scopeComplete, never treated as empty")

        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/fail-waiting-todos-rpc?status=404")!)
        let bare404Store = await MainActor.run { WaitingOnYouStore(place: generalPlace) }
        await bare404Store.load(api: waitingAPI)
        expect(await MainActor.run { bare404Store.scopeFailed && !bare404Store.scopeComplete }, "Bare 404 without PGRST202/42883 must not silently fall back or claim empty")
        try await postFixture(origin.appending(path: "fixture/show-waiting-todos-rpc"))

        // 8. Verify survey-style Review questions batch send (sends ONLY answered, skips skipped, reuses command_id on retry)
        await MainActor.run { store.scope = .all }
        let reviewCandidates = await MainActor.run { store.visibleItems }
        expect(reviewCandidates.count == 2, "Expected 2 remaining asks across all workspaces for review batch, got \(reviewCandidates.count)")
        let q1 = reviewCandidates[0]
        let q2 = reviewCandidates[1]
        await MainActor.run {
            store.selectReviewOption(q1.orderedOptions[0].id, for: q1)
            store.selectReviewOption(q2.orderedOptions[0].id, for: q2)
            store.skipReviewQuestion(q2)
        }
        expect(await MainActor.run { store.reviewSubmission(for: q1) != nil }, "Q1 must stay staged in session draft")
        expect(await MainActor.run { store.reviewSubmission(for: q2) == nil }, "Skipped Q2 must have nil submission")
        let q1Labels = await MainActor.run { store.reviewAnswerLabels(for: q1) }
        expect(q1Labels == [q1.orderedOptions[0].label], "Expected Q1 summary label")

        // Fail once during review batch -> Q1 fails with stable command_id, Q2 is skipped (never sent)
        try await postFixture(origin.appending(path: "fixture/fail-next"))
        let firstBatch = await store.submitReviewBatch(items: reviewCandidates, api: waitingAPI)
        expect(firstBatch.sentIDs.isEmpty && firstBatch.failedIDs == [q1.id] && firstBatch.skippedIDs == [q2.id], "First review batch should record Q1 failed and Q2 skipped")
        let retryBatch = await store.submitReviewBatch(items: reviewCandidates, api: waitingAPI)
        expect(retryBatch.allSucceeded && retryBatch.sentIDs == [q1.id] && retryBatch.skippedIDs == [q2.id], "Retry review batch should send Q1 and still skip Q2")
        expect(await MainActor.run { store.visibleItems.map(\.id) == [q2.id] }, "Only skipped Q2 should remain unanswered")

        // 9. Inspect ask wire commands recorded by fixture
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
        expect(recorded.count == 5, "Expected 5 ask commands (2 initial + 1 v2 + 1 failed review + 1 retried review), got \(recorded.count)")
        expect(recorded[0].command_id == recorded[1].command_id, "Retry must reuse original command_id")
        expect(recorded[0].command.option_id == "ship" && recorded[0].command.option_ids == nil && recorded[0].command.other_text == nil, "Single choice must use v1 exact shape")
        expect(recorded[2].command.option_id == nil && recorded[2].command.option_ids == ["todos"] && recorded[2].command.other_text == "Also check VoiceOver focus", "Multi+Other must use v2 shape")
        expect(recorded[3].command_id == recorded[4].command_id, "Review batch retry must reuse original command_id")
        expect(recorded.allSatisfy { $0.command.signal_id != q2.id.uuidString.lowercased() }, "Skipped Q2 must NEVER be sent")

        // 10. Placement rule unit checks
        expect(WaitingChoiceRules.classifyConversation(nil) == .unknown, "nil placement must be .unknown")
        let replyNoRoot = WaitingSignalPlacement(id: UUID(), channel_id: nil, to: nil, to_agent: nil, thread_root_id: UUID(), from: UUID(), from_kind: "agent")
        expect(WaitingChoiceRules.classifyConversation(replyNoRoot, root: nil) == .unknown, "thread reply without root must be .unknown")
        expect(WaitingChoiceRules.cleanOtherText("hello\u{0007}") == nil, "Control chars must be rejected")

        print("PASS: VerifyWaitingOnYou (directory read, distinct groups, missing-location retry, asks + paginated todos, home_overview fallback, Mark done retry+conflict, todo detail, survey Review batch send+skip+retry)")
    }
}
