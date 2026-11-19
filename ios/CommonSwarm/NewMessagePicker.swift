import SwiftUI

struct NewMessagePicker: View {
    let api: ConversationAPI
    let workspace: UUID
    let opened: ([ConversationSummary], UUID) -> Void
    @Environment(\.dismiss) private var dismiss
    @SwiftUI.State private var choices: [MemberChoice]?
    @SwiftUI.State private var selected: [MemberRef] = []
    @SwiftUI.State private var query = ""
    @SwiftUI.State private var busy = false
    @SwiftUI.State private var error: String?
    @SwiftUI.State private var restart = false
    @SwiftUI.State private var commandID = UUID()

    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(.secondary) }
                if let choices {
                    ForEach(choices.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }) { choice in
                        let picked = selected.contains(choice.id)
                        Button {
                            if picked { selected.removeAll { $0 == choice.id } } else { selected.append(choice.id) }
                            commandID = UUID()
                            restart = false
                            error = nil
                        } label: {
                            HStack {
                                Label(choice.name, systemImage: choice.id.kind == .agent ? "cpu" : "person")
                                Spacer()
                                if picked { Image(systemName: "checkmark") }
                            }.frame(minHeight: 44).contentShape(Rectangle())
                        }.accessibilityAddTraits(picked ? .isSelected : [])
                         .disabled(busy || (!picked && Set(selected + [choice.id, MemberRef(kind: .user, id: api.session.userID)]).count > 9))
                    }
                } else if error == nil { ProgressView() }
                else { Button("Retry") { Task { await load() } } }
            }
            .navigationTitle("New message").navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Find people or agents")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(restart ? "Start new group" : "Open") { Task { await open() } }
                        .disabled(busy || selected.isEmpty)
                }
            }
        }.task { await load() }.interactiveDismissDisabled(busy)
    }

    private func load() async {
        error = nil
        do { choices = try await api.memberChoices(workspace) }
        catch { if !Task.isCancelled { self.error = "Couldn’t load people and agents." } }
    }

    private func open() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let id = try await api.openConversation(workspace, members: selected, newGroup: restart, commandID: commandID)
            guard let rows = try await api.conversationList(workspace),
                  rows.contains(where: { $0.id == id && $0.kind.direct && $0.joined }) else { throw APIError.invalidResponse }
            if !Task.isCancelled { opened(rows, id) }
        } catch let refusal as ConversationRefusal where refusal.error == "conversation_member_left" {
            commandID = UUID()
            restart = true
            error = "A member left this group. Start a new group to message these recipients."
        } catch { if !Task.isCancelled { self.error = "Couldn’t open this conversation." } }
    }
}
