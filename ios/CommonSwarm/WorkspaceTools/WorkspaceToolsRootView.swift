import SwiftUI

struct TodosRoute: Hashable {}

struct WorkspaceToolsRootView: View {
    let api: ConversationAPI
    let workspace: Workspace

    var body: some View {
        Section {
            NavigationLink {
                TodoListView(api: TodoAPI(api: api), workspaceID: workspace.id)
            } label: {
                Label("To-dos", systemImage: "checkmark.circle")
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }
        }
    }
}
