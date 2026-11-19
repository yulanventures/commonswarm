import SwiftUI

public struct WorkspaceToolsRootView: View {
    let api: ConversationAPI
    let workspace: Workspace
    
    public init(api: ConversationAPI, workspace: Workspace) {
        self.api = api
        self.workspace = workspace
    }
    
    public var body: some View {
        NavigationLink(value: "todos") {
            Label("To-dos", systemImage: "checkmark.circle")
        }
        .navigationDestination(for: String.self) { value in
            if value == "todos" {
                TodoListView(api: TodoAPI(origin: api.origin, publicKey: api.publicKey, session: api.session), workspaceID: workspace.workspace_id)
            }
        }
    }
}
