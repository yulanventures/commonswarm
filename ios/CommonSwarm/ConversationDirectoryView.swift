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


    var body: some View {
        Group {
            switch state {
            case .loading: ProgressView()
            case .failed: RetryView(text: "Couldn’t load conversations", action: refresh)
            case .legacy: LegacyDirectoryView(api: api, workspace: workspace)
            case .ready(let rows): list(rows)
            }
        }.navigationTitle(workspace.name).task { await refresh() }
    }

    private func list(_ rows: [ConversationSummary]) -> some View {
        let live = rows.filter { $0.joined && $0.archived_at == nil }
        let channels = live.filter { !$0.kind.direct }.sorted {
            if ($0.kind == .general) != ($1.kind == .general) { return $0.kind == .general }
            return ($0.slug ?? "") < ($1.slug ?? "")
        }
        let directs = live.filter { $0.kind.direct }.sorted {
            if $0.last_message_at == $1.last_message_at { return $0.id.uuidString < $1.id.uuidString }
            return ($0.last_message_at ?? "") > ($1.last_message_at ?? "")
        }
        return List {
            Section("Workspace") {
                NavigationLink(value: SharedObjectsRoute()) {
                    Label("Lists & docs", systemImage: "list.bullet.rectangle")
                }
                NavigationLink(value: WorkspaceFilesRoute()) {
                    Label("Files", systemImage: "folder")
                }
            }
            Section("Channels") {
                ForEach(channels) { row in link(row) }
                NavigationLink("All channels", value: ChannelDirectoryRoute())
            }
            Section("Direct messages") {
                if directs.isEmpty { Text("No direct messages yet").foregroundStyle(.secondary) }
                ForEach(directs) { row in link(row) }
            }
        }.refreshable { await refresh() }
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
                             }).id(row.id)
                     .toolbar {
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
            }.accessibilityElement(children: .combine)
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
