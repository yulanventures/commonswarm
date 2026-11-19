import Foundation

struct Todo: Decodable, Hashable, Identifiable {
    let id: UUID
    let title: String
    let assignee_id: UUID?
    let notes: String?
    let due_date: String?
    let state: State
    
    enum State: String, Decodable {
        case open, done, reopened
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

class TodoViewModel: ObservableObject {
    @Published var todos: [Todo] = []
    @Published var isLoading = false
    @Published var error: Error?
    
    func load(api: TodoAPI, workspaceID: UUID) async {
        await MainActor.run { isLoading = true; error = nil }
        do {
            let fetchedTodos = try await api.todos(workspace: workspaceID)
            await MainActor.run { self.todos = fetchedTodos }
        } catch {
            await MainActor.run { self.error = error }
        }
        await MainActor.run { isLoading = false }
    }
}
