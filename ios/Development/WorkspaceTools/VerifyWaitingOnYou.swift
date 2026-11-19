import Foundation

@main
struct VerifyWaitingOnYou {
    static func expect(_ condition: Bool, _ message: String) {
        if !condition {
            fputs("FAIL: \(message)\n", stderr)
            exit(1)
        }
    }

    static func postFixture(_ url: URL) async throws {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        let (_, _) = try await URLSession.shared.data(for: req)
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

        // 0. Exercise real conversation directory path (POST /functions/v1/read -> HTTP 200)
        let directoryRows = try await convAPI.conversationList(mainWS.id)
        expect(directoryRows != nil, "Expected modern conversationList response from POST /functions/v1/read")
        let rows = directoryRows ?? []
        let generalRow = rows.first { $0.kind == .general }!
        let groupRows = rows.filter { $0.kind == .group }
        expect(groupRows.count == 2, "Expected two distinct group DMs in directory, got \(groupRows.count)")

        let waitingAPI = WaitingOnYouAPI(api: convAPI)
        let generalPlace = WaitingPlace(
            workspace: mainWS,
            conversation: generalRow.item(viewer: tokens.userID),
            viewerID: tokens.userID,
            directory: (generalRow.members ?? []).map(\.contact),
            channelID: generalRow.channel_id
        )
        expect(generalPlace.conversation == .general, "Directory #general must resolve to .general")

        // 1. Missing placement on #general ask + two distinct group DMs via directory:
        //    neither group DM may match the unresolved ask; broader scopes keep it; queue stays incomplete with Retry.
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/omit-location?id=30000000-0000-4000-8000-000000000001")!)
        let groupPlaceA = WaitingPlace(
            workspace: mainWS,
            conversation: groupRows[0].item(viewer: tokens.userID),
            viewerID: tokens.userID,
            directory: (groupRows[0].members ?? []).map(\.contact),
            channelID: groupRows[0].channel_id
        )
        let groupPlaceB = WaitingPlace(
            workspace: mainWS,
            conversation: groupRows[1].item(viewer: tokens.userID),
            viewerID: tokens.userID,
            directory: (groupRows[1].members ?? []).map(\.contact),
            channelID: groupRows[1].channel_id
        )
        expect(groupPlaceA.conversation != groupPlaceB.conversation, "Distinct group DMs must have distinct conversation identities")
        expect(groupPlaceA.conversation != .unknown && groupPlaceB.conversation != .unknown, "Group DMs must not collapse to .unknown")

        let groupStoreA = await MainActor.run { WaitingOnYouStore(place: groupPlaceA) }
        let groupStoreB = await MainActor.run { WaitingOnYouStore(place: groupPlaceB) }
        await groupStoreA.load(api: waitingAPI)
        await groupStoreB.load(api: waitingAPI)

        expect(await MainActor.run { groupStoreA.visibleItems.isEmpty }, "Group A must not receive ask with missing location")
        expect(await MainActor.run { groupStoreB.visibleItems.isEmpty }, "Group B must not receive ask with missing location")
        expect(await MainActor.run { groupStoreA.scopeFailed && !groupStoreA.scopeComplete }, "Missing location must mark channel scope failed/incomplete (never false empty state)")
        expect(await MainActor.run { groupStoreA.counts.all.complete == false && groupStoreA.counts.all.badgeText == "4+" }, "Incomplete cross-workspace header badge must show 4+, got \(await MainActor.run { groupStoreA.counts.all.badgeText })")

        await MainActor.run { groupStoreA.scope = .workspace }
        expect(await MainActor.run { groupStoreA.visibleItems.count == 3 }, "Unresolved ask must remain visible in All channels")
        expect(await MainActor.run { groupStoreA.scopeFailed && !groupStoreA.scopeComplete }, "All channels must also report incomplete/retry when a location is missing")

        try await postFixture(origin.appending(path: "fixture/restore-locations"))

        // 2. Failed decision_queue read for mainWS -> never false empty state
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/fail-decision-queue?ws=\(mainWS.id.uuidString.lowercased())")!)
        let failStore = await MainActor.run { WaitingOnYouStore(place: generalPlace) }
        await failStore.load(api: waitingAPI)
        expect(await MainActor.run { failStore.visibleItems.isEmpty }, "Failed workspace read should have 0 channel items")
        expect(await MainActor.run { failStore.scopeFailed && !failStore.scopeComplete }, "Failed workspace read must set scopeFailed and !scopeComplete so Retry shows instead of empty state")
        expect(await MainActor.run { failStore.counts.all.min == 1 && !failStore.counts.all.complete }, "Other workspace item still counts as 1+ when mainWS fails")
        try await postFixture(origin.appending(path: "fixture/fail-decision-queue"))

        // 3. Normal load across all workspaces; header uses counts.all (4) while sheet opens on This channel (1)
        let store = await MainActor.run { WaitingOnYouStore(place: generalPlace) }
        await store.load(api: waitingAPI)
        let initialScope = await MainActor.run { store.scope }
        expect(initialScope == .channel, "Sheet must open on This channel by default")
        let initialCounts = await MainActor.run { store.counts }
        expect(initialCounts.channel == WaitingScopeCount(min: 1, complete: true), "Expected 1 in #general, got \(initialCounts.channel)")
        expect(initialCounts.workspace == WaitingScopeCount(min: 3, complete: true), "Expected 3 in workspace, got \(initialCounts.workspace)")
        expect(initialCounts.all == WaitingScopeCount(min: 4, complete: true), "Expected 4 across all workspaces for header count, got \(initialCounts.all)")
        expect(await MainActor.run { !store.scopeFailed && store.scopeComplete }, "Healthy load must be complete and not failed")

        let generalItems = await MainActor.run { store.visibleItems }
        expect(generalItems.count == 1, "Expected 1 visible item in #general")
        let firstAsk = generalItems[0]

        // Verify recommended option comes first
        expect(firstAsk.orderedOptions.first?.id == "ship" && firstAsk.orderedOptions.first?.isRecommended == true, "Recommended option must sort first")
        expect(firstAsk.prompt.question == "Should we publish build 14 to internal testers now?", "Prompt split should extract trailing question")

        // 4. Verify failure keeps card editable & retry reuses same command_id
        try await postFixture(origin.appending(path: "fixture/fail-next"))
        await store.submitSingleOption("ship", for: firstAsk, api: waitingAPI)
        let failState = await MainActor.run { store.failuresBySignal[firstAsk.id] }
        expect(failState != nil && failState?.retryable == true, "Expected retryable failure on 503")
        expect(await MainActor.run { store.visibleItems.count } == 1, "Failed card must stay visible")

        await store.retry(for: firstAsk, api: waitingAPI)
        expect(await MainActor.run { store.visibleItems.count } == 0, "Answered card must leave list")
        let banner = await MainActor.run { store.sentBanner }
        expect(banner == "Sent", "Expected visible Sent banner, got \(String(describing: banner))")

        // 5. Verify multi-select + Other answer uses v2 wire format
        await MainActor.run { store.scope = .workspace }
        let mobileAsk = await MainActor.run { store.visibleItems.first { $0.multi }! }
        await MainActor.run {
            store.toggleOption("todos", for: mobileAsk)
            store.updateOtherText("Also check VoiceOver focus", for: mobileAsk.id)
        }
        await store.submitDraft(for: mobileAsk, api: waitingAPI)
        let remainingWorkspace = await MainActor.run { store.counts.workspace.min }
        expect(remainingWorkspace == 1, "Expected 1 remaining ask in workspace, got \(remainingWorkspace)")

        // 6. Inspect wire commands recorded by fixture: v1 single-option & stable retry command_id, v2 multi+other
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

        // 7. Placement rule unit checks (missing root -> unknown, never #general; .unknown never matches .unknown)
        let unknown = WaitingChoiceRules.classifyConversation(nil)
        expect(unknown == .unknown, "nil placement must be .unknown")
        let replyNoRoot = WaitingSignalPlacement(id: UUID(), channel_id: nil, to: nil, to_agent: nil, thread_root_id: UUID(), from: UUID(), from_kind: "agent")
        expect(WaitingChoiceRules.classifyConversation(replyNoRoot, root: nil) == .unknown, "thread reply without root must be .unknown")
        expect(WaitingChoiceRules.cleanOtherText("hello\u{0007}") == nil, "Control chars must be rejected")

        let unknownPlace = WaitingPlace(workspaceID: mainWS.id, workspaceName: mainWS.name, conversation: .unknown, label: "Unknown")
        let syntheticUnknownItem = WaitingAskItem(
            id: UUID(),
            workspaceID: mainWS.id,
            workspaceName: mainWS.name,
            conversation: .unknown,
            channelLabel: "",
            fromKind: .agent,
            fromID: UUID(),
            fromName: "Atlas",
            body: "Unresolved?",
            createdAt: "2026-11-19T14:00:00.000Z",
            until: "2026-11-20T14:00:00.000Z",
            multi: false,
            options: []
        )
        expect(WaitingChoiceRules.filterItems([syntheticUnknownItem], scope: .channel, place: unknownPlace).isEmpty, ".unknown place must never match .unknown ask")

        print("PASS: VerifyWaitingOnYou (directory read, distinct groups, missing-location retry, cross-workspace header count, v1/v2 answer_choice, stable retry, Sent banner)")
    }
}
