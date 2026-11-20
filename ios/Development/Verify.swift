// Compile with the app's PKCE.swift and Conversations.swift, then run against mock.mjs.
import Foundation

@main
enum Verify {
    enum Failure: Error { case mismatch(String) }
    static func expect(_ pass: Bool, _ name: String) throws {
        if !pass { throw Failure.mismatch(name) }
    }

    static func main() async throws {
        guard CommandLine.arguments.count >= 2, let port = UInt16(CommandLine.arguments[1]) else {
            throw Failure.mismatch("loopback port")
        }
        let origin = URL(string: "http://127.0.0.1:" + String(port))!
        let attempt = try SignInAttempt()
        let browser = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
        defer { browser.finishTasksAndInvalidate() }
        let (_, response) = try await browser.data(from: attempt.authorize(at: origin))
        guard let raw = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Location"),
              let returned = URL(string: raw) else { throw Failure.mismatch("authorize callback") }
        let code = try attempt.code(from: returned)
        let other = try SignInAttempt()
        try expect((try? other.code(from: returned)) == nil, "wrong state refused")
        let invalid = [
            "com.commonswarm.ios://auth/callback?code=x",
            raw.replacingOccurrences(of: "://auth/", with: "://auth:/"), raw + "&code=y", raw + "&access_token=x", raw + "#fragment",
            raw.replacingOccurrences(of: "://auth/", with: "://user@auth/"),
            raw.replacingOccurrences(of: "://auth/", with: "://auth:443/"),
            raw.replacingOccurrences(of: "/callback?", with: "/other?")
        ]
        for text in invalid {
            try expect((try? attempt.code(from: URL(string: text)!)) == nil, "invalid callback refused")
        }
        let google = try SignInAttempt(provider: .google)
        let (_, googleResponse) = try await browser.data(from: google.authorize(at: origin))
        guard let location = (googleResponse as? HTTPURLResponse)?.value(forHTTPHeaderField: "Location"),
              let googleURL = URL(string: location) else { throw Failure.mismatch("Google callback") }
        let googleCode = try google.code(from: googleURL)
        let otherGoogle = try SignInAttempt(provider: .google)
        try expect((try? otherGoogle.code(from: googleURL)) == nil, "Google requires the pending state")
        let wrongScheme = URL(string: "com.commonswarm.ios://auth/callback?" + (googleURL.query ?? ""))!
        try expect((try? google.code(from: wrongScheme)) == nil, "Google refuses the GitHub return")
        let tokens = try await google.exchange(code: googleCode, at: origin, publicKey: "local-fixture")
        let googleSession = HumanSession(userID: tokens.userID) { tokens.accessToken }
        let googleAPI = ConversationAPI(origin: origin, publicKey: "local-fixture", session: googleSession)
        try expect(!(try await googleAPI.workspaces()).isEmpty, "Google PKCE opens an authenticated workspace")
        googleSession.signOut()

        let wrong = try? await other.exchange(code: code, at: origin, publicKey: "local-fixture")
        try expect(wrong == nil, "wrong verifier refused")
        let browserTokens = try await attempt.exchange(code: code, at: origin, publicKey: "local-fixture")
        let session = HumanSession(userID: browserTokens.userID) { browserTokens.accessToken }
        let replay = try? await attempt.exchange(code: code, at: origin, publicKey: "local-fixture")
        try expect(replay == nil, "code consumed")
        let api = ConversationAPI(origin: origin, publicKey: "local-fixture", session: session)
        guard let ws = try await api.workspaces().first else { throw Failure.mismatch("workspace") }
        let directory = try await api.directory(ws.id)
        guard let dm = directory.first(where: { $0.isDirect }) else { throw Failure.mismatch("DM") }
        let post = Post(id: UUID(), workspace: ws.id, destination: dm.destination, body: "local fixture " + UUID().uuidString)
        try await api.post(post)
        try await api.post(post)
        let messages = try await api.history(ws.id, dm.destination)
        try expect(messages.filter { $0.body == post.command["body"] ?? nil }.count == 1, "one DM after retry")
        let general = try await api.history(ws.id, .general)
        guard let pinned = general.flatMap({ $0.attachments ?? [] }).first else { throw Failure.mismatch("thread file") }
        let bytes = try await api.download(pinned, workspace: ws.id)
        try expect(String(decoding: bytes, as: UTF8.self) == "Workspace notes", "pinned attachment uses session only to grant access")
        try expect(!general.contains { $0.body == post.command["body"] ?? nil }, "DM excluded from general")
        guard let channel = directory.first(where: { if case .channel = $0.id { true } else { false } }) else {
            throw Failure.mismatch("named channel")
        }
        let upload = UploadIntent(file: try StagedFile(data: Data("Test file".utf8), name: "Notes.txt"))
        guard let closed = directory.first(where: { $0.symbol == "lock" }) else { throw Failure.mismatch("private channel") }
        do {
            _ = try await api.upload(upload, workspace: ws.id, destination: closed.destination)
            throw Failure.mismatch("private channel admitted an upload")
        } catch AttachmentError.placement {}
        do {
            _ = try await api.upload(upload, workspace: ws.id, destination: channel.destination)
            throw Failure.mismatch("fixture did not interrupt commitment")
        } catch APIError.refused(503) {}
        let ref = try await api.upload(upload, workspace: ws.id, destination: channel.destination)
        try expect(ref.file_id == upload.file.id && ref.version_n == 1, "lost commit retries the original upload")
        let postedID = try await api.post(Post(id: UUID(), workspace: ws.id, destination: channel.destination, body: "bound channel post"), attachments: [ref])
        let channelMessages = try await api.history(ws.id, channel.destination)
        let postedFiles = channelMessages.first { $0.id == postedID }?.attachments ?? []
        try expect(postedFiles.count == 1 && postedFiles.first?.file_id == ref.file_id &&
                   postedFiles.first?.version_n == ref.version_n && postedFiles.first?.name == upload.file.name,
                   "the retried upload appears once on the confirmed message")
        let workspaces = try await api.workspaces()
        guard let second = workspaces.first(where: { $0.id != ws.id }) else { throw Failure.mismatch("second workspace") }
        guard let modern = try await api.conversationList(ws.id), let thread = modern.first(where: { $0.kind == .dm }) else {
            throw Failure.mismatch("supported conversation read")
        }
        let legacy = try await api.conversationList(second.id)
        try expect(legacy == nil, "explicitly unsupported read uses the legacy directory")
        do {
            _ = try await api.conversationList(UUID())
            throw Failure.mismatch("permission failure selected the legacy directory")
        } catch APIError.refused(403) {}
        let probe = UUID(uuidString: "00000000-0000-4000-8000-000000000091")!
        let supported = try await api.conversationList(probe)
        try expect(supported?.isEmpty == true, "empty list is supported")
        do {
            if try await api.conversationList(probe) == nil { _ = try await api.directory(probe) }
            throw Failure.mismatch("ambiguous 404 exposed the legacy directory")
        } catch APIError.refused(404) {}
        do {
            if try await api.conversationList(probe) == nil { _ = try await api.directory(probe) }
            throw Failure.mismatch("known-supported workspace downgraded on refresh")
        } catch APIError.invalidResponse {}
        let legacyReads = try await control("probe-legacy-requests")
        try expect(legacyReads == 0, "no legacy requests after a refused supported list")
        guard let preview = modern.first(where: { !$0.joined && $0.kind == .publicChannel }) else { throw Failure.mismatch("preview") }
        _ = try await api.history(ws.id, preview.item(viewer: session.userID).destination)
        try await api.join(workspace: ws.id, conversation: preview.id, commandID: UUID())
        let updated = try await api.conversationList(ws.id)
        try expect(updated?.first(where: { $0.id == preview.id })?.joined == true, "Join changes membership for the previewed channel")
        let place = preview.item(viewer: session.userID)
        let pendingDraft = session.composer(workspace: ws.id, conversation: place.id)
        let publicHistory = MessageHistory()
        _ = await publicHistory.load(.latest, api: api, workspace: ws.id, destination: place.destination)
        pendingDraft.text = "Pending at removal"
        guard let stale = pendingDraft.begin(workspace: ws.id, destination: place.destination) else { throw Failure.mismatch("joined composer") }
        pendingDraft.failed(stale.command_id, with: APIError.refused(503))
        guard let retry = pendingDraft.retry(stale.command_id) else { throw Failure.mismatch("pending retry") }
        _ = try await control("hold-membership")
        let suspendedSend = Task { try await api.post(retry) }
        _ = try await control("membership-held")
        let beforeRemoval = try await control("lose-public")
        _ = await publicHistory.load(.latest, api: api, workspace: ws.id, destination: place.destination)
        try expect(pendingDraft.access == .preview && pendingDraft.outgoing.isEmpty && pendingDraft.retry(stale.command_id) == nil,
                   "fresh unjoined history retires the pending composer")
        do { _ = try await api.post(stale); throw Failure.mismatch("posted before explicit Join") } catch APIError.refused(403) {}
        let afterRemoval = try await control("thread-posts")
        try expect(beforeRemoval == afterRemoval, "zero post requests while unjoined")
        try await api.join(workspace: ws.id, conversation: preview.id, commandID: UUID())
        _ = try await api.conversationList(ws.id)
        try expect(pendingDraft.access == .joined && pendingDraft.outgoing.isEmpty, "explicit Join restores an empty composer")
        _ = try await control("resume-membership")
        do { _ = try await suspendedSend.value } catch is CancellationError {}
        let afterRejoin = try await control("thread-posts")
        try expect(afterRejoin == beforeRemoval, "retired Send reached the command edge after rejoin")
        pendingDraft.text = "Fresh message after rejoin"
        guard let rejoinedPost = pendingDraft.begin(workspace: ws.id, destination: place.destination) else { throw Failure.mismatch("new send after rejoin") }
        let freshID = try await api.post(rejoinedPost)
        let received = try await api.history(ws.id, place.destination)
        let afterFresh = try await control("thread-posts")
        try expect(afterFresh == beforeRemoval + 1 && received.contains { $0.id == freshID && $0.body == rejoinedPost.body },
                   "one fresh send reaches the rejoined conversation")
        guard let secret = modern.first(where: { $0.slug == "access-check" })?.item(viewer: session.userID) else { throw Failure.mismatch("private channel") }
        let privateHistory = MessageHistory()
        let secretDraft = session.composer(workspace: ws.id, conversation: secret.id)
        _ = await privateHistory.load(.latest, api: api, workspace: ws.id, destination: secret.destination)
        try expect(privateHistory.messages?.isEmpty == false && secretDraft.access == .joined, "private history is initially visible")
        secretDraft.text = "Private draft"
        _ = try await control("deny-private")
        _ = await privateHistory.load(.latest, api: api, workspace: ws.id, destination: secret.destination)
        try expect(privateHistory.messages == nil && secretDraft.access == .unavailable && secretDraft.text.isEmpty,
                   "authoritative private denial clears both history and draft")
        let choices = try await api.memberChoices(ws.id)
        guard let atlas = choices.first(where: { $0.id.kind == .agent }) else { throw Failure.mismatch("agent picker") }
        let opened = try await api.openConversation(ws.id, members: [atlas.id], newGroup: false, commandID: UUID())
        try expect(opened == thread.id, "picker opens existing server DM by member kind and ID")
        guard let other = choices.first(where: { $0.name == "Morgan" }) else { throw Failure.mismatch("person picker") }
        let group = try await api.openConversation(ws.id, members: [atlas.id, other.id], newGroup: false, commandID: UUID())
        let afterOpen = try await api.conversationList(ws.id)
        try expect(afterOpen?.contains { $0.id == group && $0.kind == .group && $0.members?.count == 3 } == true,
                   "picker opens a group containing exactly the chosen user, agent and viewer")
        let twins = choices.filter { $0.name == "Riley" }
        let labels = MemberChoice.disambiguators(choices)
        try expect(twins.count == 2 && Set(twins.compactMap { labels[$0.id] }).count == 2, "colliding names get distinct stable IDs")
        for twin in twins {
            let id = try await api.openConversation(ws.id, members: [twin.id], newGroup: false, commandID: UUID())
            let exact = try await api.conversationList(ws.id)?.first(where: { $0.id == id })
            try expect(exact?.members?.filter { $0.kind == .agent }.map(\.id) == [twin.id.id] &&
                       exact?.item(viewer: session.userID, labels: labels).name == "Riley · " + (labels[twin.id] ?? ""),
                       "picker and visible destination agree on the exact same-name recipient")
        }
        let directAccess = try await api.memberAccess(workspace: ws.id, row: thread)
        try expect(!directAccess.add && !directAccess.remove, "DM members are fixed")
        for kind in [ConversationKind.publicChannel, .privateChannel] {
            guard let channel = modern.first(where: { $0.kind == kind && $0.joined }) else { throw Failure.mismatch("joined channel") }
            let rights = try await api.memberAccess(workspace: ws.id, row: channel)
            try expect(rights.add && rights.remove, "workspace owner manages live channel")
            try await api.changeMembers(.add([atlas.id]), workspace: ws.id, row: channel, commandID: UUID())
            let invited = try await api.conversationList(ws.id)?.first(where: { $0.id == channel.id })
            try expect(invited?.members?.contains(where: { $0.id == atlas.id.id }) == true, "invite appears on the same channel")
            try await api.changeMembers(.remove(atlas.id), workspace: ws.id, row: channel, commandID: UUID())
            let removed = try await api.conversationList(ws.id)?.first(where: { $0.id == channel.id })
            try expect(removed?.members?.contains(where: { $0.id == atlas.id.id }) == false, "removed recipient disappears")
        }
        guard let target = modern.first(where: { $0.slug == "design" }) else { throw Failure.mismatch("private member test channel") }
        for (index, twin) in twins.enumerated() {
            var edit = MemberEditIntent()
            edit.toggle(twin.id)
            edit.begin(.add(edit.selected))
            let before = try await control("lose-member-reply")
            do {
                _ = try await edit.dispatchPending(api: api, workspace: ws.id, row: target)
                throw Failure.mismatch("membership fixture did not lose reply")
            } catch APIError.refused(503) {}
            let originalID = edit.commandID
            edit.begin(.add(edit.selected))
            try expect(edit.commandID == originalID, "same visible retry keeps its command ID")
            if index == 0 { edit.cancel() } else { edit.toggle(atlas.id) }
            let replayed = try await edit.dispatchPending(api: api, workspace: ws.id, row: target)
            let writes = try await control("member-writes")
            try expect(!replayed && writes == before + 1, "cancel or changed selection retires the lost grant")
            let fresh = try await api.conversationList(ws.id)?.first(where: { $0.id == target.id })
            try expect(fresh?.members?.filter({ $0.name == twin.name }).map(\.id) == [twin.id.id], "only the selected look-alike got access")
            try await api.changeMembers(.remove(twin.id), workspace: ws.id, row: target, commandID: UUID())
            let removed = try await api.conversationList(ws.id)?.first(where: { $0.id == target.id })
            try expect(removed?.members?.contains(where: { $0.id == twin.id.id }) == false, "the confirmed same-name target was removed")
        }
        guard let through = thread.last_message_id, let groupRow = afterOpen?.first(where: { $0.id == group }) else {
            throw Failure.mismatch("conversation action fixtures")
        }
        let readRow = try await api.perform(.markRead(through: through), on: thread, workspace: ws.id, commandID: UUID())
        try expect(readRow.mention_count == 0 && readRow.unread_count == 0, "Mark as read confirms the displayed DM cursor")
        for channel in [thread, target] {
            let savedStar = try await api.perform(.star(true), on: channel, workspace: ws.id, commandID: UUID())
            let muted = try await api.perform(.notify("muted"), on: savedStar, workspace: ws.id, commandID: UUID())
            try expect(muted.starred == true && muted.notify_level == "muted", "star survives mute on public and private preference routes")
            let unstarred = try await api.perform(.star(false), on: muted, workspace: ws.id, commandID: UUID())
            let restored = try await api.perform(.notify("mentions"), on: unstarred, workspace: ws.id, commandID: UUID())
            try expect(restored.starred == false && restored.notify_level == "mentions", "unstar and unmute are independent")
        }
        for leaving in [preview, target, groupRow] {
            guard let live = try await api.conversationList(ws.id)?.first(where: { $0.id == leaving.id }) else { throw Failure.mismatch("joined row") }
            let destination = live.item(viewer: session.userID)
            let leavingDraft = session.composer(workspace: ws.id, conversation: destination.id)
            _ = try await api.history(ws.id, destination.destination)
            leavingDraft.text = "Draft before Leave"
            guard let outgoing = leavingDraft.begin(workspace: ws.id, destination: destination.destination) else { throw Failure.mismatch("live send") }
            let left = try await api.perform(.leave, on: live, workspace: ws.id, commandID: UUID())
            try expect(!left.joined && leavingDraft.access == (live.kind == .publicChannel ? .preview : .unavailable) &&
                       leavingDraft.outgoing.isEmpty && !leavingDraft.canDispatch(outgoing.command_id), "Leave receipt retires the outgoing message before refreshing")
        }
        let canonical = thread.item(viewer: session.userID)
        _ = try await api.history(ws.id, canonical.destination)
        let canonicalDraft = session.composer(workspace: ws.id, conversation: canonical.id)
        canonicalDraft.text = "Canonical DM"
        guard let canonicalPost = canonicalDraft.begin(workspace: ws.id, destination: canonical.destination) else {
            throw Failure.mismatch("canonical DM composer")
        }
        let canonicalID = try await api.post(canonicalPost)
        let threadMessages = try await api.history(ws.id, canonical.destination)
        try expect(threadMessages.map(\.id) == [canonicalID] && canonical.name == "Atlas" && thread.mention_count == 103,
                   "canonical DM reads back the same conversation and mention count")
        guard let topic = threadMessages.first else { throw Failure.mismatch("thread root") }
        canonicalDraft.text = "Another root"
        guard let another = canonicalDraft.begin(workspace: ws.id, destination: canonical.destination) else { throw Failure.mismatch("second root") }
        let anotherID = try await api.post(another)
        guard let otherTopic = try await api.history(ws.id, canonical.destination).first(where: { $0.id == anotherID }) else {
            throw Failure.mismatch("read second root")
        }
        canonicalDraft.reply(to: topic)
        canonicalDraft.text = "Thread receipt lost"
        guard let threaded = canonicalDraft.begin(workspace: ws.id, destination: canonical.destination) else { throw Failure.mismatch("reply draft") }
        do { _ = try await api.post(threaded); throw Failure.mismatch("expected lost thread receipt") }
        catch APIError.refused(503) { canonicalDraft.failed(threaded.command_id, with: APIError.refused(503)) }
        canonicalDraft.reply(to: otherTopic)
        canonicalDraft.text = "Next draft"
        guard let again = canonicalDraft.retry(threaded.command_id) else { throw Failure.mismatch("retry reply") }
        let acceptedReply = try await api.post(again)
        let replies = try await api.history(ws.id, canonical.destination).filter { $0.body == threaded.body }
        try expect(again.command_id == threaded.command_id && replies.count == 1 && replies[0].id == acceptedReply &&
                   replies[0].thread_root_id == topic.id && canonicalDraft.replyTarget?.id == otherTopic.id &&
                   canonicalDraft.text == "Next draft", "send and retry preserve the original root and the independent next draft")
        let draft = session.composer(workspace: ws.id, conversation: dm.id)
        draft.text = "Unsent A"
        canonicalDraft.text = "Keep my reply"
        guard let gone = canonicalDraft.begin(workspace: ws.id, destination: canonical.destination) else { throw Failure.mismatch("selected target") }
        canonicalDraft.failed(gone.command_id, with: APIError.refused(404))
        canonicalDraft.editRefused(gone.command_id)
        try expect(canonicalDraft.text == "Keep my reply" && canonicalDraft.replyUnavailable && !canonicalDraft.canSend,
                   "Edit keeps a refused thread draft until its author chooses where to send it")
        canonicalDraft.replyTarget = nil
        try expect(canonicalDraft.text == "Keep my reply" && canonicalDraft.canSend, "explicitly clearing Reply keeps the draft")
        let inB = session.composer(workspace: second.id, conversation: dm.id)
        try expect(inB.text.isEmpty, "workspace switch isolates partner drafts")
        inB.text = "Unsent B"
        try expect(session.composer(workspace: ws.id, conversation: dm.id).text == "Unsent A", "return restores draft")
        draft.text = "Uncertain send"
        guard let uncertain = draft.begin(workspace: ws.id, destination: dm.destination) else { throw Failure.mismatch("begin post") }
        try expect(draft.text.isEmpty && draft.outgoing.first?.post.body == uncertain.body, "tap moves visible draft into pending row immediately")
        draft.text = "Second draft"
        guard let secondPost = draft.begin(workspace: ws.id, destination: dm.destination) else {
            throw Failure.mismatch("a second send can start while the first is pending")
        }
        try expect(draft.outgoing.count == 2 && secondPost.command_id != uncertain.command_id, "independent pending messages")
        let secondReceipt = try await api.post(secondPost)
        draft.accepted(secondPost.command_id, signalID: secondReceipt)
        draft.reconcile(try await api.history(ws.id, dm.destination))
        try expect(draft.outgoing.map(\.id) == [uncertain.command_id], "out-of-order confirmation clears only its own row")
        do {
            try await api.post(uncertain)
            throw Failure.mismatch("fixture should withhold first receipt")
        } catch let error as APIError {
            guard case .refused(503) = error else { throw error }
            draft.failed(uncertain.command_id, with: error)
        }
        try expect(session.composer(workspace: second.id, conversation: dm.id).outgoing.isEmpty, "pending ID isolated")
        let returnedDraft = session.composer(workspace: ws.id, conversation: dm.id)
        returnedDraft.text = "Newer typing"
        guard let replayed = returnedDraft.retry(uncertain.command_id) else { throw Failure.mismatch("retry") }
        try expect(replayed.command_id == uncertain.command_id && replayed.body == uncertain.body, "retry preserves intent")
        do {
            try await api.post(replayed)
            throw Failure.mismatch("fixture should refuse the first receipt lookup")
        } catch let error as APIError {
            guard case .refused(403) = error else { throw error }
            returnedDraft.failed(uncertain.command_id, with: error)
        }

        guard let finalRetry = returnedDraft.retry(uncertain.command_id) else {
            throw Failure.mismatch("retry after refusal")
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        try expect(try encoder.encode(finalRetry) == encoder.encode(uncertain), "the entire envelope survives 503 then 403")
        let signalID = try await api.post(finalRetry)
        returnedDraft.accepted(finalRetry.command_id, signalID: signalID)
        try expect(returnedDraft.text == "Newer typing" && inB.text == "Unsent B", "accept retains newer and other workspace drafts")
        let delivered = try await api.history(ws.id, dm.destination)
        returnedDraft.reconcile(delivered)
        try expect(returnedDraft.outgoing.isEmpty, "accepted server identity replaces pending row")
        try expect(delivered.filter { $0.body == uncertain.body }.count == 1, "one post across workspace switch")
        if case .channel(let uuid, _) = channel.destination {
            let renamed = Conversation(destination: .channel(uuid, "renamed"), name: "#renamed", symbol: "number")
            let channelDraft = session.composer(workspace: ws.id, conversation: channel.id)
            channelDraft.text = "Follow the channel"
            try expect(session.composer(workspace: ws.id, conversation: renamed.id) === channelDraft, "rename preserves channel draft")
        }

        let history = MessageHistory()
        func loadPage(_ page: MessageHistory.Page) async -> Bool {
            await history.load(page, api: api, workspace: ws.id, destination: .general)
        }
        try expect(await loadPage(.latest), "load first page")
        guard let first = history.messages?.first else { throw Failure.mismatch("first page missing") }
        try expect(await loadPage(.older(before: first)), "load second page")
        guard let nextCursor = history.messages?.first else { throw Failure.mismatch("second page missing") }
        let retained = history.messages?.map(\.id)
        try expect(retained?.count == 100, "two pages retained")
        try expect(!(await loadPage(.older(before: nextCursor))), "older page interrupted")
        try expect(history.messages?.map(\.id) == retained, "failure preserves all 100 messages")
        try await api.post(Post(id: UUID(), workspace: ws.id, destination: .general, body: "Latest while reading"))
        try expect(await loadPage(.latest), "refresh latest")
        try expect(history.messages?.prefix(100).map(\.id) == retained, "refresh preserves loaded rows and their order")
        guard case .older(let failedCursor) = history.retry, failedCursor.id == nextCursor.id else {
            throw Failure.mismatch("retry direction and cursor")
        }
        try expect(await loadPage(.older(before: failedCursor)), "retry failed third page")
        let rows = history.messages ?? []
        try expect(rows.count == 131 && Set(rows.map(\.id)).count == 131 && !history.hasOlder, "three pages plus new message")
        try expect(rows.first?.body == "History message 1" && rows.last?.body == "Latest while reading", "oldest to newest")

        // Hold an actual POST on the server while retiring the shared transport.
        let suspendedPost = Post(id: UUID(), workspace: ws.id, destination: dm.destination, body: "held during sign-out")
        let pending = Task {
            try await api.post(suspendedPost)
            _ = try await api.history(ws.id, dm.destination)
        }
        func control(_ path: String) async throws -> Int {
            let (data, _) = try await browser.data(from: origin.appending(path: "fixture/" + path))
            return try JSONDecoder().decode(Int.self, from: data)
        }
        let count = try await control("wait-for-post")
        session.signOut()
        do {
            try await pending.value
            throw Failure.mismatch("held post succeeded after sign-out")
        } catch is CancellationError {
        } catch let error as URLError where error.code == .cancelled {
        }
        _ = try await control("release")
        do {
            _ = try await api.history(ws.id, dm.destination)
            throw Failure.mismatch("retired adapter made a history request")
        } catch is CancellationError {}
        try expect(try await control("count") == count, "no retired bearer dispatched")

        let emailAPI = EmailCodeAPI(origin: origin, publicKey: "local-fixture")
        let email = "reader@example.test"
        try await emailAPI.send(to: "unknown@example.test")
        try await emailAPI.send(to: email)
        try expect((try? await emailAPI.verify(email: email, code: "999999")) == nil, "wrong email code refused")
        let emailTokens = try await emailAPI.verify(email: email, code: "012345")
        let fresh = HumanSession(userID: emailTokens.userID) { emailTokens.accessToken }
        try expect(fresh.userID == session.userID, "email signs into the existing account")
        try expect((try? await emailAPI.verify(email: email, code: "012345")) == nil, "email code consumed")
        let freshAPI = ConversationAPI(origin: origin, publicKey: "local-fixture", session: fresh)
        try expect(fresh.composer(workspace: ws.id, conversation: dm.id).text.isEmpty, "fresh session has no old draft")
        try expect(try await freshAPI.workspaces().first?.id == ws.id, "new login can read")
        if CommandLine.arguments.count == 3 {
            // Save a real native request for the served TypeScript contract test.
            let fixedID = UUID(uuidString: "abcd0000-0000-4000-8000-000000000001")!
            let sample = Post(id: fixedID, workspace: ws.id, destination: dm.destination, body: "iOS contract")
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            var wire = try encoder.encode(sample)
            wire.append(0x0a)
            try wire.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        }
        print("Passed workspace-switch draft retention, channel rename, and exactly one accepted DM after an uncertain send")
        print("Passed 100 retained rows after a failed older read, latest refresh, and retry to 131 distinct chronological rows")
        print("Passed PKCE, callback validation, sign-out cancellation, and fresh-login isolation")
    }
}
