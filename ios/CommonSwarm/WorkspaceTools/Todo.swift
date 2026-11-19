import Foundation

struct Todo: Decodable, Hashable, Identifiable {
    let id: UUID
    let title: String
    let assignee_id: UUID?
    let notes: String?
    let due_date: String?
    let state: State
    
    enum State: String, Decodable {
        case open, done, reopened, inProgress = "in_progress", blocked
    }
    
    enum CodingKeys: String, CodingKey {
        case id = "todo_id"
        case title
        case assignee_id
        case notes
        case due_date
        case state
    }
}

@MainActor
class TodoViewModel: ObservableObject {
    @Published var todos: [Todo] = []
    @Published var isLoading = false
    @Published var error: Error?
    @Published var members: [UUID: String] = [:]
    
    func load(api: TodoAPI, workspaceID: UUID) async {
        isLoading = true
        error = nil
        #if DEBUG
        self.todos = [
            Todo(id: UUID(), title: "Ensure CommonSwarm iPhone app achieves feature parity with the web as fast as possible by coordinating closely with lane 1 and lane 2 engineers", assignee_id: nil, notes: "This is a very long title to test the UI layout and ensure the owner can identify the right task.", due_date: "2026-11-30", state: .open),
            Todo(id: UUID(), title: "Design Lane 2 To-do UI", assignee_id: UUID(), notes: "Focus on touch targets and information density.", due_date: "2026-11-20", state: .inProgress),
            Todo(id: UUID(), title: "Implement Todo View", assignee_id: nil, notes: "Follow design guidelines.", due_date: nil, state: .done)
        ]
        self.members = [:] // Mock member names
        isLoading = false
        #else
        do {
            let fetchedTodos = try await api.todos(workspace: workspaceID)
            self.todos = fetchedTodos
            self.members = try await api.members(workspace: workspaceID)
        } catch {
            self.error = error
        }
        isLoading = false
        #endif
    }
}
