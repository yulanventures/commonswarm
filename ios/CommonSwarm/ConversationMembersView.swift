import SwiftUI

struct ConversationMembersView: View {
    let api: ConversationAPI
    let workspace: UUID
    @SwiftUI.State var row: ConversationSummary
    let updated: ([ConversationSummary]) -> Void
    @Environment(\.dismiss) private var dismiss
    @SwiftUI.State private var access = MemberAccess.readOnly
    @SwiftUI.State private var choices: [MemberChoice] = []
    @SwiftUI.State private var edit = MemberEditIntent()
    @SwiftUI.State private var loaded = false
    @SwiftUI.State private var removing: MemberChoice?
    @SwiftUI.State private var adding = false
    @SwiftUI.State private var query = ""
    @SwiftUI.State private var error: String?
    @SwiftUI.State private var busy = false


    private var members: [MemberChoice] {
        (row.members ?? []).filter { $0.left_at == nil }.map {
            .init(id: .init(kind: $0.kind, id: $0.id), name: $0.contact.name)
        }
    }

    private var labels: [MemberRef: String] { MemberChoice.disambiguators(choices + members) }
    private var destination: String { row.item(viewer: api.session.userID, labels: labels).name }

    private func display(_ choice: MemberChoice) -> String {
        labels[choice.id].map { choice.name + " · " + $0 } ?? choice.name
    }

    private var retryTitle: String {
        guard let change = edit.pending else { return "Retry" }
        let refs: [MemberRef]
        let action, preposition: String
        switch change {
        case .add(let items): refs = items; action = "Retry adding "; preposition = " to "
        case .remove(let item): refs = [item]; action = "Retry removing "; preposition = " from "
        }
        let names = refs.map { ref in
            (choices + members).first(where: { $0.id == ref }).map(display) ?? ref.id.uuidString
        }
        return action + names.joined(separator: ", ") + preposition + destination
    }

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Text(error)
                    Button(retryTitle) {
                        Task { await retry() }
                    }.disabled(busy)
                }
                if !loaded { if error == nil { ProgressView() } }
                else if adding {
                    TextField("Find a member", text: $query)
                    let existing = Set(members.map(\.id))
                    ForEach(choices.filter { !existing.contains($0.id) && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)) }) { member in
                        let picked = edit.selected.contains(member.id)
                        Button {
                            edit.toggle(member.id)
                            error = nil
                        } label: {
                            HStack {
                                MemberChoiceLabel(choice: member, detail: labels[member.id])
                                Spacer()
                                if picked { Image(systemName: "checkmark") }
                            }.frame(minHeight: 44).contentShape(Rectangle())
                        }.accessibilityAddTraits(picked ? .isSelected : []).disabled(busy || (!picked && edit.selected.count >= 50))
                    }
                } else {
                    if row.kind == .general && members.isEmpty { Text("Everyone in this workspace") }
                    ForEach(members) { member in
                        HStack {
                            MemberChoiceLabel(choice: member, detail: labels[member.id])
                            Spacer()
                            if access.remove && member.id != MemberRef(kind: .user, id: api.session.userID) {
                                Button { edit.retire(); error = nil; removing = member } label: { Text("Remove").frame(minHeight: 44).contentShape(Rectangle()) }
                                    .buttonStyle(.borderless).accessibilityLabel("Remove " + display(member) + " from " + destination).disabled(busy)
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
                        edit.cancel()
                        error = nil
                        if adding { adding = false; query = ""; Task { await load() } } else { dismiss() }
                    }.disabled(busy)
                }
                if access.add {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(adding ? "Add" : "Add members") {
                            if adding { edit.begin(.add(edit.selected)); Task { await retry() } } else { edit.cancel(); error = nil; adding = true }
                        }.disabled(busy || (adding && edit.selected.isEmpty))
                    }
                }
            }
            .alert("Remove " + (removing.map(display) ?? "member") + " from " + destination + "?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { member in
                Button("Remove", role: .destructive) { edit.begin(.remove(member.id)); Task { await retry() } }
                Button("Cancel", role: .cancel) {}
            }
        }.task { await load() }.interactiveDismissDisabled(busy)
    }

    private func load() async {
        do {
            guard let rows = try await api.conversationList(workspace), let current = rows.first(where: { $0.id == row.id }),
                  current.access != .unavailable else { dismiss(); return }
            row = current
            access = try await api.memberAccess(workspace: workspace, row: row)
            choices = try await api.memberChoices(workspace)
            loaded = true
            error = nil
        } catch { loaded = false; access = .readOnly; self.error = "Couldn’t load membership controls." }
    }

    private func retry() async {
        guard !busy else { return }
        guard edit.pending != nil else { await load(); return }
        busy = true
        defer { busy = false }
        do {
            guard try await edit.dispatchPending(api: api, workspace: workspace, row: row) else { return }
            guard let fresh = try await api.conversationList(workspace), let current = fresh.first(where: { $0.id == row.id }) else {
                throw APIError.invalidResponse
            }
            try Task.checkCancellation()
            updated(fresh)
            row = current
            edit.cancel()
            adding = false
            query = ""
            await load()
        } catch { if !Task.isCancelled { self.error = "Couldn’t confirm the membership change." } }
    }
}

struct MembersButton: View {
    let api: ConversationAPI
    let workspace: UUID
    let row: ConversationSummary
    @ObservedObject var draft: Composer
    let updated: ([ConversationSummary]) -> Void
    @SwiftUI.State private var showing = false

    var body: some View {
        Button { showing = true } label: { Label("Members", systemImage: "person.2") }
            .disabled(draft.access == .unavailable || draft.access == .checking)
            .onChange(of: draft.access) { showing = false }
            .sheet(isPresented: $showing) {
                ConversationMembersView(api: api, workspace: workspace, row: row, updated: updated)
            }
    }
}
