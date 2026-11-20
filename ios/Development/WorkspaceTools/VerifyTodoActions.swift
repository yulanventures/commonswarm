import Foundation

@main
struct VerifyTodoActions {
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

    struct RecordedCommand: Decodable {
        let command_id: String
        let kind: String
        let request_id: String?
    }

    static func recordedCommands(_ origin: URL) async throws -> [RecordedCommand] {
        let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/commands"))
        return try JSONDecoder().decode([RecordedCommand].self, from: data)
    }

    static func main() async throws {
        guard CommandLine.arguments.count >= 2, let port = Int(CommandLine.arguments[1]) else {
            fputs("Usage: VerifyTodoActions <port>\n", stderr)
            exit(2)
        }
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let publicKey = "local-fixture"

        let emailAPI = EmailCodeAPI(origin: origin, publicKey: publicKey)
        try await emailAPI.send(to: "reader@example.test")
        let tokens = try await emailAPI.verify(email: "reader@example.test", code: "012345")
        let session = await MainActor.run {
            HumanSession(userID: tokens.userID) { tokens.accessToken }
        }
        let convAPI = ConversationAPI(origin: origin, publicKey: publicKey, session: session)
        let workspaces = try await convAPI.workspaces()
        let ws = workspaces[0]
        let todoAPI = TodoAPI(api: convAPI)

        // 1. Load list & detail with real server `{ kind, id }` comment author shapes + paginated comments
        let listVM = await MainActor.run { TodoListViewModel(viewerUserID: tokens.userID) }
        await listVM.load(api: todoAPI, workspaceID: ws.id)
        let todos = await MainActor.run { listVM.orderedTodos }
        expect(todos.count == 1, "Expected 1 seeded todo")
        let directory = await MainActor.run { listVM.directory }
        let atlasParty = directory.sortedAgents[0].party

        let detailVM = await MainActor.run { TodoDetailViewModel() }
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todos[0].todo_id)
        let initialComments = await MainActor.run { detailVM.comments }
        expect(initialComments.count == 1 && directory.actorLabel(initialComments[0].author) == "Maya Chen", "Expected first comment decoded with {kind,id} author Maya Chen")
        expect(await MainActor.run { detailVM.nextCommentOffset == 1 }, "Expected nextCommentOffset == 1")
        await detailVM.loadMoreComments(api: todoAPI, workspaceID: ws.id)
        let allComments = await MainActor.run { detailVM.comments }
        expect(allComments.count == 2 && directory.actorLabel(allComments[1].author) == "Atlas", "Expected paginated second comment decoded with agent author Atlas")
        expect(await MainActor.run { detailVM.nextCommentOffset == nil }, "Expected comment pagination complete")

        // 2. Offer accept with 503 retry reusing command_id
        try await postFixture(origin.appending(path: "fixture/fail-next-write"))
        let failOffer = await detailVM.answerOffer(.accept, api: todoAPI, workspaceID: ws.id)
        expect(!failOffer, "503 offer answer must remain unconfirmed")
        let okOffer = await detailVM.answerOffer(.accept, api: todoAPI, workspaceID: ws.id)
        expect(okOffer, "Retry offer accept must succeed")
        let offerCmds = try await recordedCommands(origin).filter { $0.kind == "household_todo_answer" }
        expect(offerCmds.count == 2 && offerCmds[0].command_id == offerCmds[1].command_id, "Offer retry must reuse command_id")
        expect(await MainActor.run { detailVM.detail?.offer == nil && detailVM.detail?.assignee == atlasParty }, "Accepted offer must assign Atlas and clear offer")

        // 3. State transition: conflict updates detail in-place, then 503 retry reuses command_id -> done -> reopen
        try await postFixture(origin.appending(path: "fixture/conflict-next-write"))
        let conflictState = await detailVM.setState(.done, api: todoAPI, workspaceID: ws.id)
        expect(!conflictState, "Conflict must return false")
        expect(await MainActor.run { (detailVM.actionError ?? "").contains("Someone else updated") }, "Conflict notice expected")

        try await postFixture(origin.appending(path: "fixture/fail-next-write"))
        let unconfirmedDone = await detailVM.setState(.done, api: todoAPI, workspaceID: ws.id)
        expect(!unconfirmedDone, "503 setState must remain unconfirmed")
        let okDone = await detailVM.setState(.done, api: todoAPI, workspaceID: ws.id)
        expect(okDone, "Retry setState(.done) must succeed")
        let stateCmds = try await recordedCommands(origin).filter { $0.kind == "todo_set_state" }
        expect(stateCmds.count == 3 && stateCmds[1].command_id == stateCmds[2].command_id, "setState retry must reuse command_id")
        expect(await MainActor.run { detailVM.detail?.state == .done }, "Todo must now be .done")

        let okReopen = await detailVM.setState(.open, api: todoAPI, workspaceID: ws.id)
        let isReopened = await MainActor.run { detailVM.detail?.state == .open }
        expect(okReopen && isReopened, "Reopen must restore .open")

        // 4. Assign to nil (unassign) with 503 retry reusing command_id
        try await postFixture(origin.appending(path: "fixture/fail-next-write"))
        let unconfirmedAssign = await detailVM.assign(to: nil, api: todoAPI, workspaceID: ws.id)
        expect(!unconfirmedAssign, "503 assign must remain unconfirmed")
        let okUnassign = await detailVM.assign(to: nil, api: todoAPI, workspaceID: ws.id)
        let isUnassigned = await MainActor.run { detailVM.detail?.assignee == nil }
        expect(okUnassign && isUnassigned, "Retry unassign must clear assignee")
        let assignCmds = try await recordedCommands(origin).filter { $0.kind == "todo_assign" }
        expect(assignCmds.count == 2 && assignCmds[0].command_id == assignCmds[1].command_id, "assign retry must reuse command_id")

        // 5. Update details bound to frozen TodoEditSession: conflict closes editor & stale session sends 0 writes; fresh session commits with 503 retry reusing command_id
        let staleEdit = await MainActor.run { detailVM.beginEdit() }!
        try await postFixture(origin.appending(path: "fixture/conflict-next-write"))
        let conflictUpdate = await detailVM.updateDetails(session: staleEdit, title: "Stale title", notes: "Stale", dueOn: nil, api: todoAPI, workspaceID: ws.id)
        let editorClosedOnConflict = await MainActor.run { detailVM.activeEditSession == nil }
        expect(!conflictUpdate && editorClosedOnConflict, "Conflict update must close stale editor")
        let cmdsBeforeStaleEdit = try await recordedCommands(origin).count
        let blockedStale = await detailVM.updateDetails(session: staleEdit, title: "Stale title", notes: "Stale", dueOn: nil, api: todoAPI, workspaceID: ws.id)
        let cmdsAfterStaleEdit = try await recordedCommands(origin).count
        expect(!blockedStale && cmdsBeforeStaleEdit == cmdsAfterStaleEdit, "Stale edit session must send ZERO network calls")

        let freshEdit = await MainActor.run { detailVM.beginEdit() }!
        try await postFixture(origin.appending(path: "fixture/fail-next-write"))
        let unconfirmedUpdate = await detailVM.updateDetails(session: freshEdit, title: "Confirm tile delivery", notes: "Updated notes", dueOn: nil, api: todoAPI, workspaceID: ws.id)
        expect(!unconfirmedUpdate, "503 update must remain unconfirmed")
        let okUpdate = await detailVM.updateDetails(session: freshEdit, title: "Confirm tile delivery", notes: "Updated notes", dueOn: nil, api: todoAPI, workspaceID: ws.id)
        expect(okUpdate, "Retry update must succeed")
        let updated = await MainActor.run { detailVM.detail }!
        expect(updated.title == "Confirm tile delivery" && updated.notes == "Updated notes" && updated.due_on == nil, "Updated fields mismatch")
        let updateCmds = try await recordedCommands(origin).filter { $0.kind == "todo_update" }
        expect(updateCmds.count == 3 && updateCmds[1].command_id == updateCmds[2].command_id, "update retry must reuse command_id")

        // 6. Post comment with mention + 503 retry reusing command_id
        try await postFixture(origin.appending(path: "fixture/fail-next-write"))
        let unconfirmedComment = await detailVM.postComment(body: "Order confirmed!", mentions: [atlasParty], api: todoAPI, workspaceID: ws.id)
        expect(!unconfirmedComment, "503 comment must remain unconfirmed")
        let okComment = await detailVM.postComment(body: "Order confirmed!", mentions: [atlasParty], api: todoAPI, workspaceID: ws.id)
        expect(okComment, "Retry comment must succeed")
        let commentCmds = try await recordedCommands(origin).filter { $0.kind == "todo_comment" }
        expect(commentCmds.count == 2 && commentCmds[0].command_id == commentCmds[1].command_id, "comment retry must reuse command_id")
        expect(await MainActor.run { detailVM.comments.count == 3 && detailVM.comments.last?.body == "Order confirmed!" }, "Posted comment must append")

        // 7. Lifecycle witness: retired listVM refuses to dispatch createTodo (0 network sends); activate() restores createTodo cleanly; 503 retry reuses command_id
        let cmdsBeforeRetiredCreate = try await recordedCommands(origin).count
        await MainActor.run { listVM.retire() }
        let retiredCreate = await listVM.createTodo(title: "Should not send", notes: "", dueOn: nil, assignee: nil, api: todoAPI, workspaceID: ws.id)
        let cmdsAfterRetiredCreate = try await recordedCommands(origin).count
        expect(retiredCreate == nil && cmdsBeforeRetiredCreate == cmdsAfterRetiredCreate, "Retired listVM must refuse createTodo with ZERO network requests")

        await MainActor.run { listVM.activate() }
        try await postFixture(origin.appending(path: "fixture/fail-next-write"))
        let unconfirmedCreate = await listVM.createTodo(title: "Schedule electrician", notes: "Morning slot", dueOn: "2026-11-28", assignee: atlasParty, api: todoAPI, workspaceID: ws.id)
        expect(unconfirmedCreate == nil, "503 create must remain unconfirmed")
        let created = await listVM.createTodo(title: "Schedule electrician", notes: "Morning slot", dueOn: "2026-11-28", assignee: atlasParty, api: todoAPI, workspaceID: ws.id)
        expect(created != nil && created?.title == "Schedule electrician" && created?.assignee == atlasParty, "Activated listVM retry create must succeed")
        let createCmds = try await recordedCommands(origin).filter { $0.kind == "todo_create" }
        expect(createCmds.count == 2 && createCmds[0].command_id == createCmds[1].command_id, "create retry must reuse command_id")

        // Retired detailVM also refuses to dispatch writes with ZERO network requests until activate()
        let cmdsBeforeRetiredDetail = try await recordedCommands(origin).count
        await MainActor.run { detailVM.retire() }
        let retiredState = await detailVM.setState(.doing, api: todoAPI, workspaceID: ws.id)
        let cmdsAfterRetiredDetail = try await recordedCommands(origin).count
        expect(!retiredState && cmdsBeforeRetiredDetail == cmdsAfterRetiredDetail, "Retired detailVM must refuse writes with ZERO network requests")
        await MainActor.run { detailVM.activate() }

        // 8. content_read_only downgrades cleanly & closes editors; production-shaped 403 {"error":"forbidden"} clears detail & list fail-closed
        _ = await MainActor.run { detailVM.beginEdit() }
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/read-only?on=1")!)
        let roResult = await detailVM.setState(.dropped, api: todoAPI, workspaceID: ws.id)
        let nowReadOnly = await MainActor.run { detailVM.isReadOnly && detailVM.activeEditSession == nil }
        expect(!roResult && nowReadOnly, "content_read_only must set isReadOnly and close open editor")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-403?on=1")!)
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todos[0].todo_id)
        await listVM.load(api: todoAPI, workspaceID: ws.id)
        let retiredOnEdge403 = await MainActor.run {
            detailVM.detail == nil && detailVM.comments.isEmpty && detailVM.failure == .refused("forbidden")
                && listVM.todos == nil && listVM.failure == .refused("forbidden")
        }
        expect(retiredOnEdge403, "Production-shaped 403 {\"error\":\"forbidden\"} must clear detail and list fail-closed")

        print("PASS: VerifyTodoActions (dual-shape comment authors, pagination, offer accept, state/assign/update/comment/create + conflict & 503 command_id reuse, read-only & fail-closed access loss)")
    }
}
