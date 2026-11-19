import Foundation

struct TodosFixture {
    static let items = [
        Todo(id: UUID(), title: "Ensure CommonSwarm iPhone app achieves feature parity with the web as fast as possible by coordinating closely with lane 1 and lane 2 engineers", assignee_id: nil, notes: "This is a very long title to test the UI layout and ensure the owner can identify the right task.", due_date: "2026-11-30", state: .open),
        Todo(id: UUID(), title: "Design Lane 2 To-do UI", assignee_id: UUID(), notes: "Focus on touch targets and information density.", due_date: "2026-11-20", state: .open),
        Todo(id: UUID(), title: "Implement Todo View", assignee_id: nil, notes: "Follow design guidelines.", due_date: nil, state: .done)
    ]
}
