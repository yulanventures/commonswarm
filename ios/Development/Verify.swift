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
        try expect(!general.contains { $0.body == post.command["body"] ?? nil }, "DM excluded from general")
        guard let channel = directory.first(where: { if case .channel = $0.id { true } else { false } }) else {
            throw Failure.mismatch("named channel")
        }
        try await api.post(Post(id: UUID(), workspace: ws.id, destination: channel.destination, body: "bound channel post"))
        let workspaces = try await api.workspaces()
        guard let second = workspaces.first(where: { $0.id != ws.id }) else { throw Failure.mismatch("second workspace") }
        let draft = session.composer(workspace: ws.id, conversation: dm.id)
        draft.text = "Unsent A"
        let inB = session.composer(workspace: second.id, conversation: dm.id)
        try expect(inB.text.isEmpty, "workspace switch isolates partner drafts")
        inB.text = "Unsent B"
        try expect(session.composer(workspace: ws.id, conversation: dm.id).text == "Unsent A", "return restores draft")
        draft.text = "Uncertain send"
        guard let uncertain = draft.begin(workspace: ws.id, destination: dm.destination) else { throw Failure.mismatch("begin post") }
        do {
            try await api.post(uncertain)
            throw Failure.mismatch("fixture should withhold first receipt")
        } catch let error as APIError {
            guard case .refused(503) = error else { throw error }
            draft.failed(with: error)
        }
        try expect(session.composer(workspace: second.id, conversation: dm.id).submission == nil, "pending ID isolated")
        let returnedDraft = session.composer(workspace: ws.id, conversation: dm.id)
        returnedDraft.text = "Newer typing"
        guard let replayed = returnedDraft.begin(workspace: ws.id, destination: dm.destination) else { throw Failure.mismatch("retry") }
        try expect(replayed.command_id == uncertain.command_id && replayed.body == uncertain.body, "retry preserves intent")
        do {
            try await api.post(replayed)
            throw Failure.mismatch("fixture should refuse the first receipt lookup")
        } catch let error as APIError {
            guard case .refused(403) = error else { throw error }
            returnedDraft.failed(with: error)
        }
        try expect(returnedDraft.failure == .unconfirmed, "pre-receipt 403 cannot settle an accepted post")
        guard let finalRetry = returnedDraft.begin(workspace: ws.id, destination: dm.destination) else {
            throw Failure.mismatch("retry after refusal")
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        try expect(try encoder.encode(finalRetry) == encoder.encode(uncertain), "the entire envelope survives 503 then 403")
        try await api.post(finalRetry)
        returnedDraft.accepted()
        try expect(returnedDraft.text == "Newer typing" && inB.text == "Unsent B", "accept retains newer and other workspace drafts")
        let delivered = try await api.history(ws.id, dm.destination)
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
