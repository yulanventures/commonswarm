import Foundation

@main
struct VerifyTodos {
    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        if !condition() {
            fputs("FAIL: \(message)\n", stderr)
            exit(1)
        }
    }

    static func main() async throws {
        guard CommandLine.arguments.count >= 2, let port = Int(CommandLine.arguments[1]) else {
            fputs("Usage: VerifyTodos <port>\n", stderr)
            exit(2)
        }
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let publicKey = "local-fixture"

        // Sign in via real email OTP flow against loopback fixture.
        let emailAPI = EmailCodeAPI(origin: origin, publicKey: publicKey)
        try await emailAPI.send(to: "reader@example.test")
        let tokens = try await emailAPI.verify(email: "reader@example.test", code: "012345")

        let session = await MainActor.run {
            HumanSession(userID: tokens.userID) { tokens.accessToken }
        }
        let conversationAPI = ConversationAPI(origin: origin, publicKey: publicKey, session: session)
        let workspaces = try await conversationAPI.workspaces()
        expect(workspaces.count == 1, "Expected 1 workspace")
        let workspaceID = workspaces[0].id

        let todoAPI = TodoAPI(api: conversationAPI)

        // 1. Open scope returns only open + doing todos.
        let openPage = try await todoAPI.listTodos(workspace: workspaceID, scope: .open)
        expect(openPage.todos.count == 3, "Expected 3 open/doing todos, got \(openPage.todos.count)")
        expect(openPage.todos.allSatisfy { $0.state == .open || $0.state == .doing }, "Open scope must only return open/doing")
        expect(openPage.todos.contains { $0.state == .doing }, "Expected a doing todo")
        expect(openPage.todos.contains { $0.assignee == nil }, "Expected an unassigned todo")

        // 2. All scope decodes all 4 states: open, doing, done, dropped.
        let allPage = try await todoAPI.listTodos(workspace: workspaceID, scope: .all)
        expect(allPage.todos.count == 5, "Expected 5 total todos, got \(allPage.todos.count)")
        let states = Set(allPage.todos.map(\.state))
        expect(states == Set(TodoState.allCases), "Expected all 4 TodoState cases, got \(states)")

        // 3. Directory resolves viewer, person, agent, and unassigned without raw UUIDs.
        let directory = try await todoAPI.directory(workspace: workspaceID)
        let doingTodo = openPage.todos.first { $0.state == .doing }!
        expect(directory.assigneeLabel(doingTodo.assignee) == "Maya Chen", "Expected Maya Chen, got \(directory.assigneeLabel(doingTodo.assignee))")
        let agentTodo = openPage.todos.first { $0.assignee?.kind == .agent }!
        expect(directory.assigneeLabel(agentTodo.assignee) == "Atlas", "Expected Atlas")
        let unassignedTodo = openPage.todos.first { $0.assignee == nil }!
        expect(directory.assigneeLabel(unassignedTodo.assignee) == "Unassigned", "Expected Unassigned")
        let doneTodo = allPage.todos.first { $0.state == .done }!
        expect(directory.assigneeLabel(doneTodo.assignee) == "You", "Expected You for viewer")

        // 4. Read detail returns full notes, comments, and exact due_on.
        let detailResponse = try await todoAPI.readTodo(workspace: workspaceID, todoID: doingTodo.id)
        expect(detailResponse.todo.title == doingTodo.title, "Title mismatch")
        expect(detailResponse.todo.due_on == "2026-11-24", "Expected due_on 2026-11-24")
        expect(!detailResponse.todo.notes.isEmpty, "Expected non-empty notes")
        expect(detailResponse.comments.count == 2, "Expected 2 comments")
        expect(directory.actorLabel(detailResponse.comments[0].author) == "Maya Chen", "Expected Maya Chen comment author")
        expect(directory.actorLabel(detailResponse.comments[1].author) == "Atlas", "Expected Atlas comment author")

        // 5. Missing todo returns typed refusal.
        do {
            _ = try await todoAPI.readTodo(workspace: workspaceID, todoID: UUID())
            expect(false, "Expected todo_not_found refusal")
        } catch TodoAPIError.refused(let reason) {
            expect(reason == "todo_not_found", "Expected todo_not_found, got \(reason)")
        }

        // 6. Local calendar date formatting does not shift across non-UTC time zones.
        var chicago = Calendar(identifier: .gregorian)
        chicago.timeZone = TimeZone(identifier: "America/Chicago")!
        let nov19 = chicago.date(from: DateComponents(year: 2026, month: 11, day: 19, hour: 23, minute: 30))!
        expect(TodoCalendarDate.formatDue("2026-11-19", now: nov19, calendar: chicago) == "Due today", "Expected Due today")
        expect(TodoCalendarDate.formatDue("2026-11-20", now: nov19, calendar: chicago) == "Due tomorrow", "Expected Due tomorrow")
        expect(TodoCalendarDate.formatDue("2026-11-18", now: nov19, calendar: chicago) == "Due yesterday", "Expected Due yesterday")
        expect(TodoCalendarDate.formatDue("2026-11-24", now: nov19, calendar: chicago) == "Due Tue, Nov 24", "Expected Due Tue, Nov 24")
        expect(TodoCalendarDate.formatDate("2026-11-24", now: nov19, calendar: chicago) == "Tue, Nov 24", "Expected Tue, Nov 24")
        expect(TodoCalendarDate.formatDate("2027-01-05", now: nov19, calendar: chicago) == "Tue, Jan 5, 2027", "Expected year when different")
        expect(TodoCalendarDate.formatDate("2026-02-30", now: nov19, calendar: chicago) == nil, "Invalid calendar date must return nil")

        // 7. List ordering: open & doing first, then done, then dropped.
        let vm = await MainActor.run { TodoListViewModel(viewerUserID: tokens.userID) }
        await vm.load(api: todoAPI, workspaceID: workspaceID)
        let openOrdered = await MainActor.run { vm.orderedTodos }
        expect(openOrdered.count == 3, "Expected 3 items in open view model")
        await MainActor.run { vm.filter = .all }
        await vm.load(api: todoAPI, workspaceID: workspaceID)
        let allOrdered = await MainActor.run { vm.orderedTodos }
        expect(allOrdered.map(\.state) == [.doing, .open, .open, .done, .dropped], "Unexpected ordering: \(allOrdered.map(\.state))")

        print("PASS: VerifyTodos (open/all, all 4 states, todo_read, display names, local due_on, refusals)")
    }
}
