import SwiftUI

struct TodoListView: View {
    let api: TodoAPI
    let workspaceID: UUID
    @StateObject var viewModel = TodoViewModel()
    
    var body: some View {
        Group {
            if viewModel.isLoading {
                ProgressView("Loading to-dos...")
            } else if let error = viewModel.error {
                RetryView(text: "Couldn’t load to-dos", action: load)
            } else if viewModel.todos.isEmpty {
                ContentUnavailableView("No to-dos yet", systemImage: "checkmark.circle")
            } else {
                List(viewModel.todos) { todo in
                    NavigationLink(destination: TodoDetailView(todo: todo, assigneeName: viewModel.members[todo.assignee_id ?? UUID()])) {
                        VStack(alignment: .leading) {
                            Text(todo.title)
                                .font(.headline)
                                .lineLimit(2)
                            HStack {
                                Text(todo.state.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                                    .font(.subheadline)
                                    .foregroundColor(todo.state == .open ? .blue : .gray)
                                if let due = todo.due_date {
                                    Text("Due: \(due)")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("To-dos")
        .task { await load() }
    }
    
    func load() async {
        await viewModel.load(api: api, workspaceID: workspaceID)
    }
}
