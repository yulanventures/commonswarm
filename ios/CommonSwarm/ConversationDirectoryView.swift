import SwiftUI

struct DirectoryView: View {
    let api: ConversationAPI
    let workspace: Workspace
    private enum Load { case loading, legacy, ready([ConversationSummary]), failed }
    @SwiftUI.State private var state: Load = .loading
    @SwiftUI.State private var generation = UUID()

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
            Section("Channels") { ForEach(channels) { row in link(row) } }
            Section("Direct messages") {
                if directs.isEmpty { Text("No direct messages yet").foregroundStyle(.secondary) }
                ForEach(directs) { row in link(row) }
            }
        }.refreshable { await refresh() }
         .navigationDestination(for: ThreadRoute.self) { route in
             if let row = rows.first(where: { $0.id == route.id && $0.joined && $0.archived_at == nil }) {
                 let item = row.item(viewer: api.session.userID)
                 HistoryView(api: api, workspace: workspace, item: item,
                             directory: (row.members ?? []).map(\.contact),
                             draft: api.session.composer(workspace: workspace.id, conversation: item.id)).id(row.id)
             } else { ContentUnavailableView("Conversation unavailable", systemImage: "bubble.left") }
         }
    }

    private func link(_ row: ConversationSummary) -> some View {
        let item = row.item(viewer: api.session.userID)
        let mentions = row.notify_level == "muted" ? 0 : row.mention_count ?? 0
        return NavigationLink(value: ThreadRoute(id: row.id)) {
            HStack {
                Label(item.name, systemImage: item.symbol)
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
            guard generation == request, !Task.isCancelled else { return }
            state = rows.map(Load.ready) ?? .legacy
        } catch { if generation == request && !Task.isCancelled { state = .failed } }
    }
}

struct ThreadRoute: Hashable { let id: UUID }
