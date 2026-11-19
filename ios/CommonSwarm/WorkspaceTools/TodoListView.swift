import SwiftUI

struct TodoListView: View {
    @StateObject var viewModel = TodoViewModel()
    
    var body: some View {
        List(viewModel.todos) { todo in
            VStack(alignment: .leading) {
                Text(todo.title)
                    .font(.headline)
                Text(todo.state.rawValue.capitalized)
                    .font(.subheadline)
                    .foregroundColor(todo.state == .open ? .blue : .gray)
            }
        }
        .navigationTitle("To-dos")
        .onAppear {
            viewModel.todos = TodosFixture.items
        }
    }
}
