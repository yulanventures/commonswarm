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
                    VStack(alignment: .leading) {
                        Text(todo.title)
                            .font(.headline)
                        Text(todo.state.rawValue.capitalized)
                            .font(.subheadline)
                            .foregroundColor(todo.state == .open ? .blue : .gray)
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
