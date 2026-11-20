import SwiftUI

struct DirectoryView: View {
    let api: ConversationAPI
    let workspace: Workspace
    private enum Load { case loading, legacy, ready([ConversationSummary]), failed }
    @SwiftUI.State private var state: Load = .loading
    @SwiftUI.State private var generation = UUID()

    @SwiftUI.State private var joining = Set<UUID>()
    @SwiftUI.State private var joinIDs: [UUID: UUID] = [:]
    @SwiftUI.State private var joinErrors = Set<UUID>()

    @SwiftUI.State private var labels: [MemberRef: String] = [:]
    @SwiftUI.State private var composing = false
    @SwiftUI.State private var opened: ThreadRoute?
    @SwiftUI.State private var selected: ThreadRoute?


    private struct ActionTarget: Identifiable {
        let id: UUID
        let row: ConversationSummary
        let action: ConversationAction
    }
    @SwiftUI.State private var leaveTarget: ConversationSummary?
    @SwiftUI.State private var editing = Set<UUID>()
    @SwiftUI.State private var retryAction: ActionTarget?
    @SwiftUI.State private var actionError: String?

    var body: some View {
        Group {
            switch state {
            case .loading: ProgressView()
            case .failed: RetryView(text: "Couldn’t load conversations", action: refresh)
            case .legacy: LegacyDirectoryView(api: api, workspace: workspace)
            case .ready(let rows): list(rows)
            }
        }.navigationTitle(workspace.name).task { await refresh() }
        .confirmationDialog(leaveTarget.map { "Leave " + $0.item(viewer: api.session.userID, labels: labels).name + "?" } ?? "Leave conversation?",
                            isPresented: Binding(get: { leaveTarget != nil }, set: { if !$0 { leaveTarget = nil } }),
                            titleVisibility: .visible, presenting: leaveTarget) { row in
            Button("Leave", role: .destructive) { start(.leave, row) }
            Button("Cancel", role: .cancel) {}
        } message: { row in
            if row.kind == .group { Text("You’ll lose access to this group’s history. A current member must start a new group to include you again.") }
            else if row.kind == .privateChannel { Text("You’ll need a new invitation to return.") }
        }
        .alert(actionError ?? "", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            if let target = retryAction { Button("Retry " + target.row.item(viewer: api.session.userID, labels: labels).name) { Task { await perform(target) } } }
            Button("Cancel", role: .cancel) { retryAction = nil }
        }
    }

    private func list(_ rows: [ConversationSummary]) -> some View {
        let live = rows.filter { $0.joined && $0.archived_at == nil }
        let starred = live.filter { $0.starred == true }.sorted { ($0.star_rank ?? Int.max, $0.id.uuidString) < ($1.star_rank ?? Int.max, $1.id.uuidString) }
        let channels = live.filter { !$0.kind.direct && $0.starred != true }.sorted {
            if ($0.kind == .general) != ($1.kind == .general) { return $0.kind == .general }
            return ($0.slug ?? "") < ($1.slug ?? "")
        }
        let directs = live.filter { $0.kind.direct && $0.starred != true }.sorted {
            if $0.last_message_at == $1.last_message_at { return $0.id.uuidString < $1.id.uuidString }
            return ($0.last_message_at ?? "") > ($1.last_message_at ?? "")
        }
        return List {
            Section("Workspace") {
                NavigationLink(value: TodosRoute()) {
                    Label("To-dos", systemImage: "checkmark.circle")
                }
                NavigationLink(value: SharedObjectsRoute()) {
                    Label("Lists & docs", systemImage: "list.bullet.rectangle")
                }
                NavigationLink(value: WorkspaceFilesRoute()) {
                    Label("Files", systemImage: "folder")
                }
            }
            if !starred.isEmpty { Section("Starred") { ForEach(starred) { row in link(row) } } }
            Section("Channels") {
                ForEach(channels) { row in link(row) }
                NavigationLink("All channels", value: ChannelDirectoryRoute())
            }
            Section("Direct messages") {
                if !live.contains(where: { $0.kind.direct }) { Text("No direct messages yet").foregroundStyle(.secondary) }
                ForEach(directs) { row in link(row) }
            }
        }.refreshable { await refresh() }
         .navigationDestination(for: TodosRoute.self) { _ in
             TodoListView(api: TodoAPI(api: api), workspaceID: workspace.id)
         }
         .navigationDestination(for: SharedObjectsRoute.self) { _ in
             SharedObjectsListView(api: api, workspace: workspace)
         }
         .navigationDestination(for: WorkspaceFilesRoute.self) { _ in
             WorkspaceFilesView(api: api, workspace: workspace)
         }
         .navigationDestination(for: ChannelDirectoryRoute.self) { _ in
             List(rows.filter { !$0.kind.direct && $0.archived_at == nil && ($0.joined || $0.kind == .publicChannel) }) { row in
                 VStack(alignment: .leading) {
                     link(row)
                     if let description = row.description, !description.isEmpty {
                         Text(description).font(.subheadline).foregroundStyle(.secondary)
                     }
                     if !row.joined { joinButton(row) }
                 }
             }.navigationTitle("All channels")
         }
         .toolbar {
             Button { composing = true } label: { Label("New message", systemImage: "square.and.pencil") }
         }
         .sheet(isPresented: $composing, onDismiss: {
             if let opened { selected = opened; self.opened = nil }
         }) {
             NewMessagePicker(api: api, workspace: workspace.id) { updated, id, names in
                 labels = names
                 state = .ready(updated)
                 opened = ThreadRoute(id: id)
                 composing = false
             }
         }
         .navigationDestination(for: ThreadRoute.self) { route in detail(route, rows: rows) }
         .navigationDestination(item: $selected) { route in detail(route, rows: rows) }
    }

    @ViewBuilder private func detail(_ route: ThreadRoute, rows: [ConversationSummary]) -> some View {
             if let row = rows.first(where: { $0.id == route.id && ($0.joined || $0.kind == .publicChannel) && $0.archived_at == nil }) {
                 let item = row.item(viewer: api.session.userID, labels: labels)
                 HistoryView(api: api, workspace: workspace, item: item,
                             directory: (row.members ?? []).map(\.contact),
                             draft: api.session.composer(workspace: workspace.id, conversation: item.id),
                             previewBar: row.kind != .publicChannel ? nil : AnyView(
                                 VStack { Text("Channel preview").font(.headline); joinButton(row) }
                                     .frame(maxWidth: .infinity).padding(.vertical, 8).background(.bar)
                             ), recipientDetails: (row.members ?? []).compactMap { member in
                                 guard row.kind.direct, member.left_at == nil,
                                       let id = labels[MemberRef(kind: member.kind, id: member.id)] else { return nil }
                                 return member.contact.name + " · " + id
                             }, waitingChannelID: row.channel_id).id(row.id)
                     .toolbar {
                         if row.joined {
                             ConversationOptionsButton(draft: api.session.composer(workspace: workspace.id, conversation: item.id)) { actions(row) }
                                 .disabled(editing.contains(row.id))
                         }
                         MembersButton(api: api, workspace: workspace.id, row: row,
                                       draft: api.session.composer(workspace: workspace.id, conversation: item.id)) { state = .ready($0) }
                     }
             } else { ContentUnavailableView("Conversation unavailable", systemImage: "bubble.left") }
    }

    @ViewBuilder private func joinButton(_ row: ConversationSummary) -> some View {
        if joinErrors.contains(row.id) { Text("Couldn’t join channel").foregroundStyle(.secondary) }
        Button {
            Task { await join(row) }
        } label: {
            Text(joining.contains(row.id) ? "Joining…" : "Join #" + (row.slug ?? "channel"))
                .frame(minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(.borderless).disabled(joining.contains(row.id))
    }

    private func join(_ row: ConversationSummary) async {
        guard row.kind == .publicChannel, joining.insert(row.id).inserted else { return }
        defer { joining.remove(row.id) }
        let id = joinIDs[row.id] ?? UUID()
        joinIDs[row.id] = id
        joinErrors.remove(row.id)
        do {
            try await api.join(workspace: workspace.id, conversation: row.id, commandID: id)
            await refresh()
            joinIDs.removeValue(forKey: row.id)
        } catch { if !Task.isCancelled { joinErrors.insert(row.id) } }
    }

    private func link(_ row: ConversationSummary) -> some View {
        let item = row.item(viewer: api.session.userID, labels: labels)
        let mentions = row.notify_level == "muted" ? 0 : row.mention_count ?? 0
        return NavigationLink(value: ThreadRoute(id: row.id)) {
            HStack {
                if row.kind == .general || row.kind == .publicChannel {
                    Text(item.name)
                } else {
                    Label(item.name, systemImage: item.symbol)
                }
                Spacer()
                if mentions > 0 {
                    Text(mentions > 99 ? "99+" : String(mentions))
                        .font(.caption.bold()).padding(.horizontal, 7).padding(.vertical, 3)
                        .background(.tint.opacity(0.15), in: Capsule())
                        .accessibilityLabel(mentions == 1 ? "1 mention" : "\(mentions) mentions")
                } else if row.notify_level != "muted", (row.unread_count ?? 0) > 0 {
                    Circle().fill(.tint).frame(width: 8, height: 8).accessibilityLabel("Unread")
                }
                if row.notify_level == "muted" {
                    Image(systemName: "bell.slash").accessibilityLabel("Muted")
                }
            }.accessibilityElement(children: .combine)
        }.contextMenu { if row.joined { actions(row) } }
    }

    @ViewBuilder private func actions(_ row: ConversationSummary) -> some View {
        if let through = row.last_message_id, (row.unread_count ?? 0) > 0 || (row.mention_count ?? 0) > 0 {
            Button("Mark as read") { start(.markRead(through: through), row) }
        }
        Button(row.starred == true ? "Unstar" : "Star") { start(.star(row.starred != true), row) }
        Menu("Notifications") {
            ForEach(["everything", "mentions", "muted"], id: \.self) { level in
                Button { start(.notify(level), row) } label: {
                    let name = level == "muted" ? "Mute" : level == "mentions" ? "Mentions only" : "All messages"
                    if (row.notify_level ?? "everything") == level { Label(name, systemImage: "checkmark") }
                    else { Text(name) }
                }
            }
        }
        if row.kind.canLeave {
            Button("Leave…", role: .destructive) { leaveTarget = row }
        }
    }

    private func start(_ action: ConversationAction, _ row: ConversationSummary) {
        Task { await perform(.init(id: UUID(), row: row, action: action)) }
    }

    private func perform(_ target: ActionTarget) async {
        let id = target.row.id
        guard case .ready(let before) = state, before.contains(where: { $0.id == id && $0.joined }),
              editing.insert(id).inserted else { return }
        defer { editing.remove(id) }
        do {
            let updated = try await api.perform(target.action, on: target.row, workspace: workspace.id, commandID: target.id)
            guard !Task.isCancelled, case .ready(var rows) = state, let i = rows.firstIndex(where: { $0.id == id }) else { return }
            generation = UUID()
            switch target.action {
            case .leave:
                if updated.kind == .publicChannel { rows[i].joined = false; rows[i].starred = false }
                else { rows.remove(at: i) }
            case .markRead:
                if rows[i].last_message_id == target.row.last_message_id {
                    rows[i].mention_count = 0
                    rows[i].unread_count = 0
                }
            case .star, .notify:
                rows[i].starred = updated.starred
                rows[i].star_rank = updated.star_rank
                rows[i].notify_level = updated.notify_level
            }
            state = .ready(rows)
            retryAction = nil
        } catch {
            guard !Task.isCancelled else { return }
            retryAction = target
            if let refusal = error as? ConversationRefusal, refusal.error == "channel_last_manager" {
                actionError = "Add another channel manager before leaving."
                retryAction = nil
            } else {
                let name = target.row.item(viewer: api.session.userID, labels: labels).name
                switch target.action {
                case .leave: actionError = "Couldn’t confirm leaving " + name + "."
                case .markRead: actionError = "Couldn’t confirm marking " + name + " as read."
                case .star, .notify: actionError = "Couldn’t confirm preferences for " + name + "."
                }
                // A lost Leave reply can still mean access has ended. A fresh list retires that draft.
                if case .leave = target.action, let rows = try? await api.conversationList(workspace.id),
                   !Task.isCancelled, !rows.contains(where: { $0.id == id && $0.joined }) {
                    generation = UUID()
                    state = .ready(rows)
                    retryAction = nil
                    actionError = nil
                }
            }
        }
    }

    private func refresh() async {
        let request = UUID()
        generation = request
        do {
            let rows = try await api.conversationList(workspace.id)
            let names = rows == nil ? [:] : MemberChoice.disambiguators(try await api.memberChoices(workspace.id))
            guard generation == request, !Task.isCancelled else { return }
            labels = names
            state = rows.map(Load.ready) ?? .legacy
        } catch { if generation == request && !Task.isCancelled { state = .failed } }
    }
}

struct ThreadRoute: Hashable { let id: UUID }

private struct ChannelDirectoryRoute: Hashable {}


private struct ConversationOptionsButton<Actions: View>: View {
    @ObservedObject var draft: Composer
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        Menu(content: actions) { Label("Conversation options", systemImage: "ellipsis.circle") }
            .disabled(draft.access != .joined)
    }
}
