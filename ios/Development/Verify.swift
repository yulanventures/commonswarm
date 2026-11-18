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
            raw + "&code=y", raw + "&access_token=x", raw + "#fragment",
            raw.replacingOccurrences(of: "://auth/", with: "://user@auth/"),
            raw.replacingOccurrences(of: "://auth/", with: "://auth:443/"),
            raw.replacingOccurrences(of: "/callback?", with: "/other?")
        ]
        for text in invalid {
            try expect((try? attempt.code(from: URL(string: text)!)) == nil, "invalid callback refused")
        }
        let wrong = try? await other.exchange(code: code, at: origin, publicKey: "local-fixture")
        try expect(wrong == nil, "wrong verifier refused")
        let session = try await attempt.exchange(code: code, at: origin, publicKey: "local-fixture")
        let replay = try? await attempt.exchange(code: code, at: origin, publicKey: "local-fixture")
        try expect(replay == nil, "code consumed")
        let api = ConversationAPI(origin: origin, publicKey: "local-fixture", session: session)
        guard let ws = try await api.workspaces().first else { throw Failure.mismatch("workspace") }
        let directory = try await api.directory(ws.id)
        guard let dm = directory.first(where: { $0.isDirect }) else { throw Failure.mismatch("DM") }
        let post = Post(id: UUID(), workspace: ws.id, destination: dm.id, body: "local fixture " + UUID().uuidString)
        try await api.post(post)
        try await api.post(post)
        let messages = try await api.history(ws.id, dm.id)
        try expect(messages.filter { $0.body == post.command["body"] ?? nil }.count == 1, "one DM after retry")
        let general = try await api.history(ws.id, .general)
        try expect(!general.contains { $0.body == post.command["body"] ?? nil }, "DM excluded from general")
        if CommandLine.arguments.count == 3 {
            // Save a real native request for the served TypeScript contract test.
            let fixedID = UUID(uuidString: "abcd0000-0000-4000-8000-000000000001")!
            let sample = Post(id: fixedID, workspace: ws.id, destination: dm.id, body: "iOS contract")
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            var wire = try encoder.encode(sample)
            wire.append(0x0a)
            try wire.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        }
        print("Passed local PKCE, callback validation, workspace, DM history and idempotent post checks")
    }
}
