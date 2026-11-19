import Foundation

@main
struct VerifyWaitingOnYou {
    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        if !condition() {
            fputs("FAIL: \(message)\n", stderr)
            exit(1)
        }
    }

    static func main() async throws {
        guard CommandLine.arguments.count >= 2, let port = Int(CommandLine.arguments[1]) else {
            fputs("Usage: VerifyWaitingOnYou <port>\n", stderr)
            exit(2)
        }
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let publicKey = "local-fixture"

        // Sign in via real email OTP flow
        let emailAPI = EmailCodeAPI(origin: origin, publicKey: publicKey)
        try await emailAPI.send(to: "reader@example.test")
        let tokens = try await emailAPI.verify(email: "reader@example.test", code: "012345")
        let session = await MainActor.run {
            HumanSession(userID: tokens.userID) { tokens.accessToken }
        }
        let convAPI = ConversationAPI(origin: origin, publicKey: publicKey, session: session)
        let workspaces = try await convAPI.workspaces()
        expect(workspaces.count == 2, "Expected 2 workspaces")
        let mainWS = workspaces[0]

        let waitingAPI = WaitingOnYouAPI(api: convAPI)
        let generalPlace = WaitingPlace(workspaceID: mainWS.id, workspaceName: mainWS.name, conversation: .general, label: "#general")
        let store = await MainActor.run { WaitingOnYouStore(place: generalPlace) }

        // 1. Load across all workspaces; verify channel default scope & complete counts
        await store.load(api: waitingAPI)
        let initialCounts = await MainActor.run { store.counts }
        expect(initialCounts.channel == WaitingScopeCount(min: 1, complete: true), "Expected 1 in #general, got \(initialCounts.channel)")
        expect(initialCounts.workspace == WaitingScopeCount(min: 3, complete: true), "Expected 3 in workspace, got \(initialCounts.workspace)")
        expect(initialCounts.all == WaitingScopeCount(min: 4, complete: true), "Expected 4 across all workspaces, got \(initialCounts.all)")

        let generalItems = await MainActor.run { store.visibleItems }
        expect(generalItems.count == 1, "Expected 1 visible item in #general")
        let firstAsk = generalItems[0]
        // Verify recommended option ordered first
        expect(firstAsk.orderedOptions.first?.id == "ship", "Expected recommended option 'ship' first")
        expect(firstAsk.orderedOptions.first?.isRecommended == true, "Expected isRecommended == true")
        // Verify prompt splitting
        expect(firstAsk.prompt.prose == "The TestFlight build passed smoke checks.", "Unexpected prose: \(String(describing: firstAsk.prompt.prose))")
        expect(firstAsk.prompt.question == "Should we publish build 14 to internal testers now?", "Unexpected question: \(String(describing: firstAsk.prompt.question))")

        // 2. Verify DM vs #general placement (DM must never appear in #general)
        await MainActor.run { store.scope = .workspace }
        let wsItems = await MainActor.run { store.visibleItems }
        expect(wsItems.contains { if case .dm(.agent, _) = $0.conversation { return true }; return false }, "Expected DM ask classified as .dm, not .general")
        expect(wsItems.contains { if case .channel = $0.conversation { return true }; return false }, "Expected named channel ask classified as .channel")

        // 3. Failure preserves card, draft, and command_id; Retry succeeds and removes card + shows Sent banner
        var failReq = URLRequest(url: origin.appending(path: "fixture/fail-next"))
        failReq.httpMethod = "POST"
        _ = try await URLSession.shared.data(for: failReq)

        await MainActor.run { store.scope = .channel }
        await store.submitSingleOption("ship", for: firstAsk, api: waitingAPI)
        let afterFailFailure = await MainActor.run { store.failuresBySignal[firstAsk.id] }
        expect(afterFailFailure != nil && afterFailFailure?.retryable == true, "Expected retryable failure")
        let stillVisible = await MainActor.run { store.visibleItems.count }
        expect(stillVisible == 1, "Failed card must remain in list")

        await store.retry(for: firstAsk, api: waitingAPI)
        let afterRetryVisible = await MainActor.run { store.visibleItems.count }
        let banner = await MainActor.run { store.sentBanner }
        expect(afterRetryVisible == 0, "Answered card must leave list")
        expect(banner == "Sent", "Expected visible Sent banner, got \(String(describing: banner))")

        // 4. Verify multi-select + Other answer uses v2 wire format
        await MainActor.run { store.scope = .workspace }
        let mobileAsk = await MainActor.run { store.visibleItems.first { $0.multi }! }
        await MainActor.run {
            store.toggleOption("todos", for: mobileAsk)
            store.updateOtherText("Also check VoiceOver focus", for: mobileAsk.id)
        }
        await store.submitDraft(for: mobileAsk, api: waitingAPI)
        let remainingWorkspace = await MainActor.run { store.counts.workspace.min }
        expect(remainingWorkspace == 1, "Expected 1 remaining ask in workspace, got \(remainingWorkspace)")

        // 5. Inspect wire commands recorded by fixture: v1 single-option & stable retry command_id, v2 multi+other
        struct RecordedCommand: Decodable {
            struct Body: Decodable {
                let kind: String
                let signal_id: String
                let option_id: String?
                let option_ids: [String]?
                let other_text: String?
            }
            let command_id: String
            let command: Body
        }
        let (cmdData, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/commands"))
        let recorded = try JSONDecoder().decode([RecordedCommand].self, from: cmdData)
        expect(recorded.count == 3, "Expected 3 commands (1 failed + 1 retry + 1 v2), got \(recorded.count)")
        expect(recorded[0].command_id == recorded[1].command_id, "Retry must reuse original command_id")
        expect(recorded[0].command.option_id == "ship" && recorded[0].command.option_ids == nil && recorded[0].command.other_text == nil, "Single choice must use v1 exact shape")
        expect(recorded[2].command.option_id == nil && recorded[2].command.option_ids == ["todos"] && recorded[2].command.other_text == "Also check VoiceOver focus", "Multi+Other must use v2 shape")

        // 6. Placement rule unit checks (missing root -> unknown, never #general; thread destinations)
        let unknown = WaitingChoiceRules.classifyConversation(nil)
        expect(unknown == .unknown, "nil placement must be .unknown")
        let replyNoRoot = WaitingSignalPlacement(id: UUID(), channel_id: nil, to: nil, to_agent: nil, thread_root_id: UUID(), from: UUID(), from_kind: "agent")
        expect(WaitingChoiceRules.classifyConversation(replyNoRoot, root: nil) == .unknown, "thread reply without root must be .unknown")
        expect(WaitingChoiceRules.cleanOtherText("hello\u{0007}") == nil, "Control chars must be rejected")

        let threadChannelID = UUID()
        let threadGeneral = WaitingPlace(workspace: mainWS, conversation: Conversation(destination: .thread(UUID(), .general), name: "#general", symbol: "number"))
        expect(threadGeneral.conversation == .general, "Thread general must map to .general")
        let threadChannel = WaitingPlace(workspace: mainWS, conversation: Conversation(destination: .thread(UUID(), .publicChannel), name: "#mobile", symbol: "number"), channelID: threadChannelID)
        expect(threadChannel.conversation == .channel(threadChannelID), "Thread channel must map to .channel(channelID)")
        let atlasID = UUID()
        let threadDM = WaitingPlace(
            workspace: mainWS,
            conversation: Conversation(destination: .thread(UUID(), .dm), name: "Atlas", symbol: "cpu"),
            viewerID: session.userID,
            directory: [
                Conversation(destination: .person(session.userID), name: "You", symbol: "person"),
                Conversation(destination: .agent(atlasID), name: "Atlas", symbol: "cpu"),
            ]
        )
        expect(threadDM.conversation == .dm(.agent, atlasID), "Thread DM must map to .dm(.agent, atlasID)")
        let threadGroup = WaitingPlace(workspace: mainWS, conversation: Conversation(destination: .thread(UUID(), .group), name: "Team", symbol: "person.2"))
        expect(threadGroup.conversation == .unknown, "Thread group DM must map to .unknown")

        print("PASS: VerifyWaitingOnYou (scopes, complete counts, DM vs #general, thread places, recommended order, v1/v2 answer_choice, stable retry, Sent banner)")
    }
}
