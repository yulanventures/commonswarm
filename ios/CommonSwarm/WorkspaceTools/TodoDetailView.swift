import SwiftUI

struct TodoDetailView: View {
    let todo: Todo
    let assigneeName: String?
    
    var body: some View {
        List {
            Section("Details") {
                Text(todo.title).font(.headline)
                if let name = assigneeName {
                    Text("Assignee: \(name)")
                } else if let assignee = todo.assignee_id {
                    Text("Assignee: \(assignee.uuidString.prefix(8))...")
                }
                if let due = todo.due_date {
                    Text("Due: \(due)")
                }
            }
            if let notes = todo.notes {
                Section("Notes") {
                    Text(notes)
                }
            }
            Section("Status") {
                Text(todo.state.rawValue.capitalized)
            }
        }
        .navigationTitle("To-do Detail")
    }
}
