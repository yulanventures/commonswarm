import SwiftUI

// Select the property-wrapper form on deployment targets predating the State macro.
private typealias ViewState<Value> = SwiftUI.State<Value>

@main
struct CommonSwarmApp: App {
    var body: some Scene { WindowGroup { SessionView() } }
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

private struct Deployment {
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
    @StateObject private var auth = SignIn()
    @ViewState private var window: UIWindow?

    var body: some View {
        Group {
            if let session = auth.session, let deployment = Deployment.current {
                WorkspacesView(api: ConversationAPI(origin: deployment.origin, publicKey: deployment.publicKey, session: session),
                               signOut: auth.signOut)
                    .id(session.user.id)
            } else {
                VStack(spacing: 16) {
                    if let url = Bundle.main.url(forResource: "BrandMark", withExtension: "png"),
                       let mark = UIImage(contentsOfFile: url.path) {
                        Image(uiImage: mark).resizable().frame(width: 64, height: 64).accessibilityHidden(true)
                    }
                    Text("CommonSwarm").font(.largeTitle.bold())
                    Button("Sign in") {
                        if let deployment = Deployment.current, let window {
                            auth.start(origin: deployment.origin, publicKey: deployment.publicKey, window: window)
                        }
                    }.buttonStyle(.borderedProminent)
                        .disabled(auth.pending || window == nil || Deployment.current == nil)
                    if auth.failed { Text("Couldn’t sign in. Try again.") }
                    if Deployment.current == nil { Text("Sign-in is unavailable in this build.") }
                }
            }
        }.background(WindowAnchor { window = $0 }.frame(width: 0, height: 0))
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

@MainActor
private final class Composer: ObservableObject {
    @Published var text = ""
    @Published var sending = false
    @Published var failed = false
    var submission: Post?
}

private struct DirectoryView: View {
    let api: ConversationAPI
    let workspace: Workspace
    @ViewState private var directory: [Conversation]?
    @ViewState private var failed = false
    @ViewState private var drafts: [Conversation.Destination: Composer] = [:]

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
                                Label {
                                    VStack(alignment: .leading) {
                                        Text(item.name)
                                        if case .agent = item.id { Text("Agent").font(.caption).foregroundStyle(.secondary) }
                                    }
                                } icon: { Image(systemName: item.symbol) }
                            }
                        }
                    }
                }
            } else if !failed { ProgressView() }
        }.navigationTitle(workspace.name)
            .task { await load() }.refreshable { await load() }
            .navigationDestination(for: Conversation.self) { item in
                if let draft = drafts[item.id] {
                    HistoryView(api: api, workspace: workspace, item: item, directory: directory ?? [], draft: draft).id(item.id)
                }
            }
    }

    private func load() async {
        do {
            let rows = try await api.directory(workspace.id)
            try Task.checkCancellation()
            for row in rows where drafts[row.id] == nil { drafts[row.id] = Composer() }
            directory = rows
            failed = false
        } catch { if !Task.isCancelled { failed = true } }
    }
}

private struct HistoryView: View {
    let api: ConversationAPI
    let workspace: Workspace
    let item: Conversation
    let directory: [Conversation]
    @ObservedObject var draft: Composer
    @ViewState private var messages: [Message]?
    @ViewState private var failed = false
    @ViewState private var loadingOlder = false
    @ViewState private var hasOlder = false
    @ViewState private var requestID = UUID()
    @ViewState private var scrollToLatest = 0
    @Environment(\.colorScheme) private var appearance

    var body: some View {
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if failed { RetryView(text: "Couldn’t load messages") { await load() } }
                    if hasOlder { Button("Load earlier messages") { Task { await load(older: true) } }.disabled(loadingOlder) }
                    if let messages {
                        if messages.isEmpty { Text("No messages yet").foregroundStyle(.secondary) }
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
                            }.id(message.id)
                        }
                    } else if !failed { ProgressView() }
                }.padding()
            }.onChange(of: scrollToLatest) {
                if let id = messages?.last?.id { reader.scrollTo(id, anchor: .bottom) }
            }
            .refreshable { await load() }
        }.navigationTitle(item.name).navigationBarTitleDisplayMode(.inline)
            .task { await load() }
            .safeAreaInset(edge: .bottom) {
                VStack {
                    if draft.failed {
                        HStack { Text("Couldn’t send message"); Button("Retry") { Task { await send() } }.disabled(draft.sending) }
                    }
                    HStack(alignment: .bottom) {
                        TextField("Message " + item.name, text: $draft.text, axis: .vertical)
                            .lineLimit(1...5).textFieldStyle(.roundedBorder)
                        Button { Task { await send() } } label: {
                            Image(systemName: "arrow.up.circle.fill").font(.title).frame(minWidth: 44, minHeight: 44)
                        }.accessibilityLabel("Send message")
                            .disabled(draft.sending || draft.submission != nil || draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.text.utf16.count > 8_000)
                    }
                }.padding(.horizontal).padding(.vertical, 6).background(.bar)
            }
    }

    private func sender(_ message: Message) -> String {
        if message.from_kind == "user", message.from == api.session.user.id { return "You" }
        let key: Conversation.Destination = message.from_kind == "agent" ? .agent(message.from) : .person(message.from)
        return directory.first { $0.id == key }?.name ?? (message.from_kind == "agent" ? "Agent" : "Member")
    }

    private func load(older: Bool = false, afterSend: Bool = false) async {
        let id = UUID()
        requestID = id
        loadingOlder = older
        do {
            let page = try await api.history(workspace.id, item.id, before: older ? messages?.first : nil)
            try Task.checkCancellation()
            guard id == requestID else { return }
            let firstLoad = messages == nil
            if older {
                let existing = Set((messages ?? []).map(\.id))
                messages = page.filter { !existing.contains($0.id) } + (messages ?? [])
            } else { messages = page }
            hasOlder = page.count == 50
            failed = false
            if firstLoad || afterSend { scrollToLatest += 1 }
        } catch { if id == requestID && !Task.isCancelled { failed = true } }
        if id == requestID { loadingOlder = false }
    }

    private func send() async {
        guard !draft.sending else { return }
        if draft.submission == nil && (draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.text.utf16.count > 8_000) { return }
        let post = draft.submission ?? Post(id: UUID(), workspace: workspace.id, destination: item.id, body: draft.text)
        draft.submission = post
        draft.sending = true
        draft.failed = false
        defer { draft.sending = false }
        do {
            try await api.post(post)
            if draft.text == post.command["body"] ?? nil { draft.text = "" }
            draft.submission = nil
            await load(afterSend: true)
        } catch APIError.refused(let status) where (400..<500).contains(status) {
            draft.submission = nil
            draft.failed = true
        } catch { draft.failed = true }
    }
}
