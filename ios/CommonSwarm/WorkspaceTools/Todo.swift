import Foundation

struct Todo: Decodable, Hashable, Identifiable {
    let id: UUID
    let title: String
    let assignee_id: UUID?
    let notes: String?
    let due_date: String? // Assuming ISO string for now
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
    
    // Will implement loading from fixtures/API
}
