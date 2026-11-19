import SwiftUI

struct ConversationMembersView: View {
    let api: ConversationAPI
    let workspace: UUID
    @SwiftUI.State var row: ConversationSummary
    let updated: ([ConversationSummary]) -> Void
    @Environment(\.dismiss) private var dismiss
    @SwiftUI.State private var access = MemberAccess.readOnly
    @SwiftUI.State private var choices: [MemberChoice] = []
    @SwiftUI.State private var selected: [MemberRef] = []
    @SwiftUI.State private var removing: MemberChoice?
    @SwiftUI.State private var adding = false
    @SwiftUI.State private var query = ""
    @SwiftUI.State private var error: String?
    @SwiftUI.State private var busy = false
    @SwiftUI.State private var pending: MemberChange?
    @SwiftUI.State private var commandID = UUID()

    private var members: [MemberChoice] {
        (row.members ?? []).filter { $0.left_at == nil }.map {
            .init(id: .init(kind: $0.kind, id: $0.id), name: $0.contact.name)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Text(error)
                    Button("Retry") {
                        Task { if let pending { await submit(pending) } else { await load() } }
                    }.disabled(busy)
                }
                if adding {
                    TextField("Find a member", text: $query)
                    let existing = Set(members.map(\.id))
                    ForEach(choices.filter { !existing.contains($0.id) && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)) }) { member in
                        let picked = selected.contains(member.id)
                        Button {
                            if picked { selected.removeAll { $0 == member.id } } else { selected.append(member.id) }
                        } label: {
                            HStack {
                                Label(member.name, systemImage: member.id.kind == .agent ? "cpu" : "person")
                                Spacer()
                                if picked { Image(systemName: "checkmark") }
                            }.frame(minHeight: 44).contentShape(Rectangle())
                        }.accessibilityAddTraits(picked ? .isSelected : []).disabled(busy || (!picked && selected.count >= 50))
                    }
                } else {
                    ForEach(members) { member in
                        HStack {
                            Label(member.name, systemImage: member.id.kind == .agent ? "cpu" : "person")
                            Spacer()
                            if access.remove && member.id != MemberRef(kind: .user, id: api.session.userID) {
                                Button { removing = member } label: { Text("Remove").frame(minHeight: 44).contentShape(Rectangle()) }
                                    .buttonStyle(.borderless).accessibilityLabel("Remove " + member.name).disabled(busy)
                            }
                        }
                    }
                }
            }
            .navigationTitle(adding ? "Add members" : "Members")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(adding ? "Cancel" : "Done") {
                        if adding { adding = false; selected = []; query = "" } else { dismiss() }
                    }.disabled(busy)
                }
                if access.add {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(adding ? "Add" : "Add members") {
                            if adding { Task { await submit(.add(selected)) } } else { adding = true }
                        }.disabled(busy || (adding && selected.isEmpty))
                    }
                }
            }
            .alert("Remove " + (removing?.name ?? "member") + "?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { member in
                Button("Remove", role: .destructive) { Task { await submit(.remove(member.id)) } }
                Button("Cancel", role: .cancel) {}
            }
        }.task { await load() }.interactiveDismissDisabled(busy)
    }

    private func load() async {
        do {
            access = try await api.memberAccess(workspace: workspace, row: row)
            if access.add { choices = try await api.memberChoices(workspace) }
            error = nil
        } catch { access = .readOnly; self.error = "Couldn’t load membership controls." }
    }

    private func submit(_ change: MemberChange) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        if pending != change { pending = change; commandID = UUID() }
        do {
            try await api.changeMembers(change, workspace: workspace, row: row, commandID: commandID)
            guard let fresh = try await api.conversationList(workspace), let current = fresh.first(where: { $0.id == row.id }) else {
                throw APIError.invalidResponse
            }
            try Task.checkCancellation()
            updated(fresh)
            row = current
            pending = nil
            selected = []
            adding = false
            query = ""
            await load()
        } catch { if !Task.isCancelled { self.error = "Couldn’t confirm the membership change." } }
    }
}
