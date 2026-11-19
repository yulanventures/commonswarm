import SwiftUI

struct NewMessagePicker: View {
    let api: ConversationAPI
    let workspace: UUID
    let opened: ([ConversationSummary], UUID, [MemberRef: String]) -> Void
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
            VStack(spacing: 0) {
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Find people or agents", text: $query).autocorrectionDisabled()
                    if !query.isEmpty {
                        Button { query = "" } label: {
                            Image(systemName: "xmark.circle.fill").frame(width: 44, height: 44)
                        }.accessibilityLabel("Clear search")
                    }
                }.frame(minHeight: 44).padding(.horizontal)
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
                                Label {
                                    VStack(alignment: .leading) {
                                        Text(choice.name)
                                        if let tag = labels[choice.id] { Text(tag).font(.caption).foregroundStyle(.secondary) }
                                    }
                                } icon: { Image(systemName: choice.id.kind == .agent ? "cpu" : "person") }
                                Spacer()
                                if picked { Image(systemName: "checkmark") }
                            }.frame(minHeight: 44).contentShape(Rectangle())
                        }.accessibilityAddTraits(picked ? .isSelected : [])
                         .disabled(busy || (!picked && Set(selected + [choice.id, MemberRef(kind: .user, id: api.session.userID)]).count > 9))
                    }
                } else if error == nil { ProgressView() }
                else { Button("Retry") { Task { await load() } } }
            }
            if !selected.isEmpty {
                Button { Task { await open() } } label: {
                    Text(restart ? "Start new group" : "Open")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent).disabled(busy)
                .padding(.horizontal).padding(.vertical, 6)
                .background(.bar)
            }
        }
            .navigationTitle("New message").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) } }
        }
        .task { await load() }.interactiveDismissDisabled(busy)
    }

    private var labels: [MemberRef: String] { MemberChoice.disambiguators(choices ?? []) }

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
            if !Task.isCancelled { opened(rows, id, labels) }
        } catch let refusal as ConversationRefusal where refusal.error == "conversation_left" {
            error = "You left this group. Ask a current member to start a new group with you."
        } catch let refusal as ConversationRefusal where refusal.error == "conversation_member_left" {
            commandID = UUID()
            restart = true
            error = "A member left this group. Start a new group to message these recipients."
        } catch { if !Task.isCancelled { self.error = "Couldn’t open this conversation." } }
    }
}
