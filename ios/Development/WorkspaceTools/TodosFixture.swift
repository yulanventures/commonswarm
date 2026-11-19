import Foundation

struct TodosFixture {
    static let items = [
        Todo(id: UUID(), title: "Review Lane 1 iOS progress", assignee_id: nil, notes: "Need to check if everything is on track.", due_date: nil, state: .open),
        Todo(id: UUID(), title: "Design Lane 2 To-do UI", assignee_id: UUID(), notes: nil, due_date: "2026-11-20", state: .open),
        Todo(id: UUID(), title: "Implement Todo View", assignee_id: nil, notes: "Follow design guidelines.", due_date: nil, state: .done)
    ]
}
