import SwiftUI

// Select the property-wrapper form on deployment targets predating the State macro.
private typealias ViewState<Value> = SwiftUI.State<Value>

@main
struct CommonSwarmApp: App {
    @StateObject private var auth = SignIn()
    var body: some Scene { WindowGroup { SessionView(auth: auth) } }
}

private struct WindowAnchor: UIViewRepresentable {
    var onWindow: (UIWindow) -> Void
    final class Probe: UIView {
        var onWindow: ((UIWindow) -> Void)?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let window { onWindow?(window) }
        }
    }
    func makeUIView(context: Context) -> Probe { let probe = Probe(); probe.onWindow = onWindow; return probe }
    func updateUIView(_ uiView: Probe, context: Context) { uiView.onWindow = onWindow }
}

struct Deployment {
    let origin: URL
    let publicKey: String

    static var current: Self? {
        #if DEBUG && targetEnvironment(simulator)
        return Self(origin: URL(string: "http://127.0.0.1:8765")!, publicKey: "local-fixture")
        #elseif DEBUG && COMMONSWARM_USB_TEST
        guard let key = Bundle.main.object(forInfoDictionaryKey: "CommonSwarmPublicKey") as? String,
              !key.isEmpty else { return nil }
        return Self(origin: URL(string: "https://api.commonswarm.com")!, publicKey: key)
        #else
        return nil
        #endif
    }
}

private struct SessionView: View {
    @ObservedObject var auth: SignIn
    @ViewState private var window: UIWindow?

    var body: some View {
        Group {
            if auth.startup == .waiting || auth.startup == .restoring {
                ProgressView("Restoring sign-in")
            } else if auth.startup == .waitingForUnlock {
                ProgressView("Waiting for unlock")
            } else if auth.startup == .retryRestore {
                RetryView(text: "Couldn’t restore sign-in", action: auth.restore)
            } else if auth.startup == .retrySignOut {
                RetryView(text: "Couldn’t finish signing out") { auth.signOut() }
            } else if let session = auth.session, let deployment = Deployment.current {
                WorkspacesView(api: ConversationAPI(origin: deployment.origin, publicKey: deployment.publicKey, session: session),
                               signOut: auth.signOut)
                    .id(session.userID)
            } else {
                SignInView(auth: auth, deployment: Deployment.current, window: window)
            }
        }.task { await auth.restore() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)) { _ in
            Task { await auth.didUnlock() }
        }
        .background(WindowAnchor { window = $0 }.frame(width: 0, height: 0))
    }
}

private struct WorkspacesView: View {
    let api: ConversationAPI
    let signOut: () -> Void
    @ViewState private var workspaces: [Workspace]?
    @ViewState private var selection: Workspace?
    @ViewState private var failed = false

    var body: some View {
        NavigationStack {
            if let selection {
                DirectoryView(api: api, workspace: selection)
                    .id(selection.id)
                    .toolbar {
                        Menu {
                            if (workspaces?.count ?? 0) > 1 { Button("Switch workspace") { self.selection = nil } }
                            Button("Sign out", action: signOut)
                        } label: { Label("Account", systemImage: "person.crop.circle") }
                    }
            } else {
                Group {
                    if failed { RetryView(text: "Couldn’t load workspaces", action: load) }
                    else if let workspaces {
                        if workspaces.isEmpty { ContentUnavailableView("No workspaces yet", systemImage: "person.2") }
                        else { List(workspaces) { ws in Button(ws.name) { selection = ws } } }
                    } else { ProgressView() }
                }.navigationTitle("Workspaces")
                    .toolbar { Button("Sign out", action: signOut) }
            }
        }.task { await load() }
    }

    private func load() async {
        failed = false
        do {
            let rows = try await api.workspaces()
            try Task.checkCancellation()
            workspaces = rows
            if rows.count == 1 { selection = rows.first }
        } catch { if !Task.isCancelled { failed = true } }
    }
}

private struct RetryView: View {
    let text: String
    let action: () async -> Void
    var body: some View {
        VStack { Text(text); Button("Retry") { Task { await action() } } }
    }
}

private struct DirectoryView: View {
    let api: ConversationAPI
    let workspace: Workspace
    @ViewState private var directory: [Conversation]?
    @ViewState private var failed = false

    var body: some View {
        List {
            if failed { RetryView(text: "Couldn’t load conversations", action: load) }
            if let directory {
                ForEach([false, true], id: \.self) { direct in
                    Section(direct ? "Direct messages" : "Channels") {
                        let conversations = directory.filter { $0.isDirect == direct }
                        if direct && conversations.isEmpty { Text("No direct messages yet") }
                        ForEach(conversations) { item in
                            NavigationLink(value: item) {
                                if item.isDirect {
                                    Label {
                                        VStack(alignment: .leading) {
                                            Text(item.name)
                                            if case .agent = item.id { Text("Agent").font(.caption).foregroundStyle(.secondary) }
                                        }
                                    } icon: { Image(systemName: item.symbol) }
                                } else {
                                    HStack(spacing: 6) {
                                        if item.symbol == "lock" {
                                            Image(systemName: "lock").accessibilityHidden(true)
                                        }
                                        Text(item.symbol == "lock" ? String(item.name.dropFirst()) : item.name)
                                            .lineLimit(1).truncationMode(.tail)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .accessibilityLabel(item.symbol == "lock" ? "Private channel, " + item.name : item.name)
                                }
                            }
                        }
                    }
                }
            } else if !failed { ProgressView() }
        }.navigationTitle(workspace.name)
            .task { await load() }.refreshable { await load() }
            .navigationDestination(for: Conversation.self) { item in
                HistoryView(api: api, workspace: workspace, item: item, directory: directory ?? [],
                            draft: api.session.composer(workspace: workspace.id, conversation: item.id)).id(item.id)
            }
    }

    private func load() async {
        do {
            let rows = try await api.directory(workspace.id)
            try Task.checkCancellation()
            directory = rows
            failed = false
        } catch { if !Task.isCancelled { failed = true } }
    }
}

// Align the same point in the row and viewport after prepending history.
private struct HistoryAnchor: Equatable {
    let id: UUID
    let top: CGFloat
    let alignment: CGFloat
}

private struct HistoryAnchorKey: PreferenceKey {
    static let defaultValue: HistoryAnchor? = nil
    static func reduce(value: inout HistoryAnchor?, nextValue: () -> HistoryAnchor?) {
        guard let next = nextValue() else { return }
        if let previous = value, previous.top <= next.top { return }
        value = next
    }
}

private struct HistoryRowPosition: View {
    let id: UUID
    var body: some View {
        GeometryReader { geometry in
            let viewport = geometry.bounds(of: .scrollView(axis: .vertical))
            Color.clear.preference(key: HistoryAnchorKey.self, value: viewport.flatMap { bounds in
                let top = -bounds.minY
                let room = bounds.height - geometry.size.height
                // Use the first row lying fully in the viewport, even when the Retry control is above it.
                guard room != 0 else {
                    return top == 0 ? HistoryAnchor(id: id, top: top, alignment: 0) : nil
                }
                let alignment = top / room
                guard (0...1).contains(alignment) else { return nil }
                return HistoryAnchor(id: id, top: top, alignment: alignment)
            })
        }
    }
}

private struct HistoryView: View {
    let api: ConversationAPI
    let workspace: Workspace
    let item: Conversation
    let directory: [Conversation]
    @ObservedObject var draft: Composer
    @StateObject private var history = MessageHistory()
    @ViewState private var readingAnchor: HistoryAnchor?
    @ViewState private var restoreAnchor: HistoryAnchor?
    @ViewState private var restoreGeneration = 0
    @ViewState private var scrollToLatest = 0
    @ViewState private var awayFromLatest = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var appearance

    var body: some View {
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if let retry = history.retry { RetryView(text: "Couldn’t load messages") { await load(retry) } }
                    if history.hasOlder, let first = history.messages?.first, history.retry == nil {
                        Button("Load earlier messages") { Task { await load(.older(before: first)) } }.disabled(history.loadingOlder)
                    }
                    if let messages = history.messages {
                        if messages.isEmpty && draft.outgoing.isEmpty { Text("No messages yet").foregroundStyle(.secondary) }
                        ForEach(messages) { message in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Text(sender(message)).bold()
                                    if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(message.created_at) {
                                        Text(date, format: .dateTime.month().day().hour().minute()).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Text(message.body).textSelection(.enabled)
                                    .foregroundStyle(appearance == .dark ? Color(red: 0.79, green: 0.80, blue: 0.83) : Color(red: 0.25, green: 0.27, blue: 0.31))
                                ForEach(message.attachments ?? []) { attachment in
                                    MessageAttachmentView(api: api, workspace: workspace.id, attachment: attachment)
                                }
                            }.background(HistoryRowPosition(id: message.id)).id(message.id)
                        }
                    } else if history.retry == nil { ProgressView() }
                    ForEach(draft.outgoing) { row in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text("You").bold()
                                switch row.delivery {
                                case .sending, .retrying: Text("Sending…")
                                case .unconfirmed: Text("Delivery unconfirmed")
                                case .refused: Text("Couldn’t send")
                                case .accepted: Text(row.createdAt, format: .dateTime.hour().minute())
                                }
                            }
                            Text(row.post.body ?? "").textSelection(.enabled)
                            if case .unconfirmed = row.delivery {
                                Button("Retry") { deliver(draft.retry(row.id)) }
                            } else if case .refused = row.delivery {
                                Button("Edit message") { draft.editRefused(row.id) }.disabled(!draft.text.isEmpty)
                            }
                        }.id(row.id)
                    }
                }.scrollTargetLayout().padding()
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY > 24
            } action: { _, away in
                awayFromLatest = away
            }
            .onPreferenceChange(HistoryAnchorKey.self) { readingAnchor = $0 }
            .onChange(of: restoreGeneration) {
                if let anchor = restoreAnchor {
                    reader.scrollTo(anchor.id, anchor: UnitPoint(x: 0.5, y: anchor.alignment))
                }
            }
            .onChange(of: scrollToLatest) {
                if let id = latestID { reader.scrollTo(id, anchor: .bottom) }
            }
            .refreshable { await load() }
            .overlay(alignment: .bottomTrailing) {
                if awayFromLatest {
                    JumpToLatestButton {
                        guard let last = latestID else { return }
                        if reduceMotion { reader.scrollTo(last, anchor: .bottom) }
                        else { withAnimation(.easeOut(duration: 0.2)) { reader.scrollTo(last, anchor: .bottom) } }
                    }
                    .padding(.trailing, 12).padding(.bottom, 4)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ConversationComposer(draft: draft, destination: item.name, send: { deliver(draft.begin(workspace: workspace.id, destination: item.destination)) })
            }
        }.navigationTitle(item.name).navigationBarTitleDisplayMode(.inline)
            .task { await load() }
    }

    private func sender(_ message: Message) -> String {
        if message.from_kind == "user", message.from == api.session.userID { return "You" }
        let key: Conversation.ID = message.from_kind == "agent" ? .agent(message.from) : .person(message.from)
        return directory.first { $0.id == key }?.name ?? (message.from_kind == "agent" ? "Agent" : "Member")
    }

    private func load(_ request: MessageHistory.Page = .latest) async {
        let firstLoad = history.messages == nil
        var before: HistoryAnchor?
        let loaded = await history.load(request, api: api, workspace: workspace.id, destination: item.destination) {
            before = readingAnchor
        }
        guard loaded else { return }
        draft.reconcile(history.messages ?? [])
        if firstLoad { scrollToLatest += 1 }
        else if let before {
            restoreAnchor = before
            restoreGeneration += 1
        }
    }

    private var latestID: UUID? { draft.outgoing.last?.id ?? history.messages?.last?.id }

    private func deliver(_ post: Post?) {
        guard let post else { return }
        scrollToLatest += 1
        Task {
            do {
                let signalID = try await api.post(post)
                guard api.session.isActive else { return }
                draft.accepted(post.command_id, signalID: signalID)
                draft.reconcile(history.messages ?? [])
                await load()
            } catch {
                if api.session.isActive { draft.failed(post.command_id, with: error) }
            }
        }
    }
}
