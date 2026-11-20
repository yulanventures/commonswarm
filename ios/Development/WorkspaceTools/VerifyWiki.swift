import Foundation

@MainActor
final class ControllableBearer {
    private let token: String
    private var remainingHolds = 0
    private var waitForHold: CheckedContinuation<Void, Never>?
    private var releaseHold: CheckedContinuation<Void, Never>?
    private(set) var isHeld = false

    init(token: String) {
        self.token = token
    }

    func holdNext(_ count: Int = 1) {
        remainingHolds = count
    }

    func nextToken() async -> String {
        if remainingHolds > 0 {
            remainingHolds -= 1
            isHeld = true
            waitForHold?.resume()
            waitForHold = nil
            await withCheckedContinuation { cont in
                releaseHold = cont
            }
            isHeld = false
        }
        return token
    }

    func waitUntilHeld() async {
        if isHeld { return }
        await withCheckedContinuation { cont in
            waitForHold = cont
        }
    }

    func release() {
        releaseHold?.resume()
        releaseHold = nil
    }
}

@main
struct VerifyWiki {
    static func expect(_ condition: Bool, _ message: String) {
        if !condition {
            fputs("FAIL: \(message)\n", stderr)
            exit(1)
        }
    }

    static func postFixture(_ urlString: String) async throws {
        var req = URLRequest(url: URL(string: urlString)!)
        req.httpMethod = "POST"
        let (_, _) = try await URLSession.shared.data(for: req)
    }

    struct RecordedCommand: Decodable {
        let command_id: String
        let kind: String
        let file_id: String?
        let version_n: Int?
        let if_version: Int?
    }

    struct MutationCount: Decodable {
        let commits: Int
    }

    static func recordedCommands(_ origin: URL) async throws -> [RecordedCommand] {
        let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/commands"))
        return try JSONDecoder().decode([RecordedCommand].self, from: data)
    }

    static func commitMutations(_ origin: URL) async throws -> Int {
        let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/mutations"))
        return try JSONDecoder().decode(MutationCount.self, from: data).commits
    }

    static func main() async throws {
        guard CommandLine.arguments.count >= 2, let port = Int(CommandLine.arguments[1]) else {
            fputs("Usage: VerifyWiki <port>\n", stderr)
            exit(2)
        }
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let base = origin.absoluteString
        let publicKey = "local-fixture"

        // =========================================================================
        // 0. Pure WikiRules topic & link-detection parity tests
        // =========================================================================
        expect(WikiRules.topicFromFileName("brain--release-checklist.md") == "release-checklist", "Expected canonical brain topic")
        expect(WikiRules.topicFromFileName("budget.pdf") == nil, "Ordinary file must not be treated as wiki topic")
        expect(WikiRules.canonicalTopic("../escape") == nil && WikiRules.canonicalTopic("Valid_Topic.1") == "valid_topic.1", "Topic canonicalization check failed")

        let knownTopics = ["release-checklist", "roadmap"]
        let proseSlug = WikiRules.linkSegments(in: "See release-checklist, then stop.", topics: knownTopics)
        expect(proseSlug.contains(where: { $0.topic == "release-checklist" && $0.text == "release-checklist" }), "Slug topic must link in prose with trailing comma trimmed")
        let proseWord = WikiRules.linkSegments(in: "Read the roadmap today.", topics: knownTopics)
        expect(proseWord.allSatisfy { $0.topic == nil }, "Bare single-word topic must NOT link in plain prose")
        let exactCodeWord = WikiRules.linkSegments(in: "roadmap", topics: knownTopics, codeSpan: "roadmap")
        expect(exactCodeWord.contains(where: { $0.topic == "roadmap" }), "Bare single-word topic must link inside exact inline code span")
        let commandCodeWord = WikiRules.linkSegments(in: "cswarm brain put roadmap", topics: knownTopics, codeSpan: "cswarm brain put roadmap")
        expect(commandCodeWord.allSatisfy { $0.topic == nil }, "Single-word topic must NOT link inside a multi-word command code span")
        let urlNoSplit = WikiRules.linkSegments(in: "See https://example.com/?topic=release-checklist for details.", topics: knownTopics)
        expect(urlNoSplit.allSatisfy { $0.topic == nil }, "URL containing topic slug must NOT split into a false link")

        let emailAPI = EmailCodeAPI(origin: origin, publicKey: publicKey)
        try await emailAPI.send(to: "reader@example.test")
        let tokens = try await emailAPI.verify(email: "reader@example.test", code: "012345")
        let bearer = await MainActor.run { ControllableBearer(token: tokens.accessToken) }
        let session = await MainActor.run { HumanSession(userID: tokens.userID) { await bearer.nextToken() } }
        let convAPI = ConversationAPI(origin: origin, publicKey: publicKey, session: session)
        let ws = try await convAPI.workspaces()[0]
        let wikiAPI = WikiAPI(api: convAPI)

        // =========================================================================
        // 1. C1: Fail-closed initial state + Fresh Reader (browse, read latest & v1, 0 writes)
        // =========================================================================
        let readerStore = await MainActor.run { WikiStore(api: wikiAPI, workspaceID: ws.id) }
        let initialFailClosed = await MainActor.run { !readerStore.canCreate && !readerStore.canUpdate }
        expect(initialFailClosed, "WikiStore must start fail-closed")

        try await postFixture("\(base)/fixture/content-role?role=reader")
        let readerLoaded = await readerStore.loadTopics()
        let readerTopics = await MainActor.run { readerStore.topics ?? [] }
        expect(readerLoaded && readerTopics.count == 2 && readerTopics.map(\.topic) == ["release-checklist", "roadmap"], "Expected only 2 live brain--*.md topics sorted alphabetically")

        let checklist = readerTopics[0]
        let roadmap = readerTopics[1]
        await readerStore.openTopic(fileID: checklist.fileID)
        let readerCheck = await MainActor.run {
            !readerStore.canCreate
                && !readerStore.canUpdate
                && !readerStore.canEditTopic(checklist.fileID)
                && readerStore.beginEdit(fileID: checklist.fileID) == nil
                && readerStore.openCreateSheet() == nil
                && (readerStore.activeMarkdown ?? "").contains("Run tests before shipping")
        }
        expect(readerCheck, "Fresh Reader must read latest version cleanly with zero write capabilities")

        // Inspect older version v1
        await readerStore.openTopic(fileID: checklist.fileID, version: 1)
        let v1Loaded = await MainActor.run {
            readerStore.activeVersion == 1 && (readerStore.activeMarkdown ?? "").contains("Initial checklist draft")
        }
        expect(v1Loaded, "Reader must be able to inspect older version v1")

        // =========================================================================
        // 2. Editor: browse, view v1 (edit hidden) -> latest (edit allowed), held-bearer canDispatch control vs dismissal/retire
        // =========================================================================
        try await postFixture("\(base)/fixture/content-role?role=editor")
        let store = await MainActor.run { WikiStore(api: wikiAPI, workspaceID: ws.id) }
        _ = await store.loadTopics()
        await store.openTopic(fileID: checklist.fileID, version: 1)
        let editHiddenOnOlder = await MainActor.run { !store.canEditTopic(checklist.fileID) && store.beginEdit(fileID: checklist.fileID) == nil }
        expect(editHiddenOnOlder, "Edit must be disabled while viewing an older version")

        await store.openTopic(fileID: checklist.fileID, version: 2)
        let editAllowedLatest = await MainActor.run { store.canEditTopic(checklist.fileID) }
        expect(editAllowedLatest, "Editor must be allowed to edit latest version")

        // Held-bearer + edit sheet dismissed before transport -> ZERO write commands
        let dismissedEdit = await MainActor.run { store.beginEdit(fileID: checklist.fileID) }!
        let cmdsBeforeDismissed = try await recordedCommands(origin).filter { $0.kind.hasPrefix("file_version_") }.count
        await MainActor.run { bearer.holdNext(1) }
        let dismissedTask = Task { await store.saveEdit(session: dismissedEdit, markdown: "# Should not send\n") }
        await bearer.waitUntilHeld()
        await MainActor.run {
            store.dismissEditSession(dismissedEdit.id)
            bearer.release()
        }
        let dismissedOK = await dismissedTask.value
        let cmdsAfterDismissed = try await recordedCommands(origin).filter { $0.kind.hasPrefix("file_version_") }.count
        expect(!dismissedOK && cmdsBeforeDismissed == cmdsAfterDismissed, "Dismissing edit sheet while bearer is held must send ZERO write commands")

        // =========================================================================
        // 3. C2: Frozen WikiEditSession retires on version change (0 sends) + fresh topic link check
        // =========================================================================
        let staleEdit = await MainActor.run { store.beginEdit(fileID: checklist.fileID) }!
        try await postFixture("\(base)/fixture/advance-version?file_id=\(checklist.fileID.uuidString.lowercased())")
        _ = await store.loadTopics()
        let editRetiredOnAdvance = await MainActor.run { store.activeEditSession == nil }
        expect(editRetiredOnAdvance, "Open edit session must retire when topic version advances on refresh")
        let cmdsBeforeStale = try await recordedCommands(origin).filter { $0.kind.hasPrefix("file_version_") }.count
        let staleOK = await store.saveEdit(session: staleEdit, markdown: "# Stale clobber attempt\n")
        let cmdsAfterStale = try await recordedCommands(origin).filter { $0.kind.hasPrefix("file_version_") }.count
        expect(!staleOK && cmdsBeforeStale == cmdsAfterStale, "Stale edit session must send ZERO network calls")

        // Fresh topic link: live link opens roadmap; deleted topic shows notice and sends ZERO download requests
        let followedLive = await store.followTopicLink("roadmap")
        let openedRoadmap = await MainActor.run { followedLive?.fileID == roadmap.fileID && store.activeFileID == roadmap.fileID && (store.activeMarkdown ?? "").contains("Roadmap") }
        expect(openedRoadmap, "Following a live topic link must refresh and open roadmap")

        try await postFixture("\(base)/fixture/delete-topic?file_id=\(roadmap.fileID.uuidString.lowercased())")
        let dlBeforeDeletedLink = try await recordedCommands(origin).filter { $0.kind == "file_download_url" }.count
        let followedDeleted = await store.followTopicLink("roadmap")
        let dlAfterDeletedLink = try await recordedCommands(origin).filter { $0.kind == "file_download_url" }.count
        let deletedNoticeOK = await MainActor.run { followedDeleted == nil && (store.linkNotice ?? "").contains("no longer in this workspace") }
        expect(deletedNoticeOK && dlBeforeDeletedLink == dlAfterDeletedLink, "Following a deleted topic link must refuse after fresh list check with ZERO download requests")

        // =========================================================================
        // 4. C3 + C4: Committed-then-503 + same-login 401 + inconclusive refresh + pre-receipt refusal
        //             + bound retry visibility after refresh + exact 1 commit + no stale replay regression
        // =========================================================================
        await store.openTopic(fileID: checklist.fileID)
        let currentChecklistVer = await MainActor.run { store.activeTopic!.currentVersion }
        let commitsBefore = try await commitMutations(origin)
        let editSess = await MainActor.run { store.beginEdit(fileID: checklist.fileID) }!
        try await postFixture("\(base)/fixture/commit-then-503")
        let firstSave = await store.saveEdit(session: editSess, markdown: "# Release Checklist vNext\n\nCommitted before 503.\n")
        let firstRetryItem = await MainActor.run { store.eligiblePendingRetries(for: checklist.fileID).first }
        expect(!firstSave && firstRetryItem != nil, "Committed-then-503 save must remain pending with bound retry item")
        expect(try await commitMutations(origin) == commitsBefore + 1, "Fixture must have committed once before 503")

        // Same-login 401 on retry preserves pending save & commandID (and hides retry button until access returns)
        try await postFixture("\(base)/fixture/edge-401?on=1")
        let retry401 = await store.retryPendingSave(firstRetryItem!)
        let preserved401 = await MainActor.run {
            !retry401
                && store.pendingSaves[checklist.fileID]?.commitCommandID == firstRetryItem?.commandID
                && store.pendingSaves[checklist.fileID]?.outcomeUnknown == true
                && store.eligiblePendingRetries(for: checklist.fileID).isEmpty
        }
        expect(preserved401, "Same-login 401 on retry must preserve pending save and commandID while hiding retry until access returns")
        try await postFixture("\(base)/fixture/edge-401?on=0")

        // Normal refresh clears actionError, yet bound retry MUST stay visible!
        _ = await store.loadTopics()
        let visibleAfterRefresh = await MainActor.run {
            store.actionError == nil && store.eligiblePendingRetries(for: checklist.fileID).first?.commandID == firstRetryItem?.commandID
        }
        expect(visibleAfterRefresh, "Normal refresh clearing actionError must keep bound retry visible")

        // Unclassified pre-receipt refusal preserves pending save
        try await postFixture("\(base)/fixture/pre-receipt-refusal?reason=rate_limited")
        let retryPreRefusal = await store.retryPendingSave(firstRetryItem!)
        let preservedPreRefusal = await MainActor.run {
            !retryPreRefusal && store.eligiblePendingRetries(for: checklist.fileID).first?.commandID == firstRetryItem?.commandID
        }
        expect(preservedPreRefusal, "Unclassified pre-receipt refusal must preserve pending save")

        // Attempting a different edit while an earlier save is unknown must be blocked with ZERO sends
        await store.openTopic(fileID: checklist.fileID)
        let cmdsBeforeDiffEdit = try await recordedCommands(origin).filter { $0.kind.hasPrefix("file_version_") }.count
        let diffEditSess = await MainActor.run { store.beginEdit(fileID: checklist.fileID) }!
        let diffEditOK = await store.saveEdit(session: diffEditSess, markdown: "# Completely different edit\n")
        let cmdsAfterDiffEdit = try await recordedCommands(origin).filter { $0.kind.hasPrefix("file_version_") }.count
        expect(!diffEditOK && cmdsBeforeDiffEdit == cmdsAfterDiffEdit, "Different edit while save outcome is unknown must send ZERO commands")
        await MainActor.run { store.dismissEditSession(diffEditSess.id) }

        // Advance server past committed version (v+1 -> v+3), refresh, then retry -> replays v+1 with EXACTLY 1 commit & NO version regression!
        try await postFixture("\(base)/fixture/advance-version?file_id=\(checklist.fileID.uuidString.lowercased())")
        _ = await store.loadTopics()
        await store.openTopic(fileID: checklist.fileID)
        let newerVer = await MainActor.run { store.activeTopic!.currentVersion }
        expect(newerVer == currentChecklistVer + 3, "Expected server advanced to currentChecklistVer + 3")

        let replayedOK = await store.retryPendingSave(firstRetryItem!)
        let replayClean = await MainActor.run {
            replayedOK
                && store.eligiblePendingRetries(for: checklist.fileID).isEmpty
                && store.activeTopic?.currentVersion == newerVer
                && store.activeVersion == newerVer
        }
        let commitsAfter = try await commitMutations(origin)
        expect(replayClean && commitsAfter == commitsBefore + 1, "Bound retry must replay with EXACTLY 1 commit and must NOT regress displayed version")

        // 409 file_version_precondition_failed: concurrent server update closes editor and refreshes to latest
        let conflictEditSess = await MainActor.run { store.beginEdit(fileID: checklist.fileID) }!
        try await postFixture("\(base)/fixture/advance-version?file_id=\(checklist.fileID.uuidString.lowercased())")
        let conflictSaveOK = await store.saveEdit(session: conflictEditSess, markdown: "# Conflicting edit\n")
        let conflictHandled = await MainActor.run {
            !conflictSaveOK
                && store.activeEditSession == nil
                && (store.actionError ?? "").contains("Someone else updated")
                && store.activeTopic?.currentVersion == newerVer + 2
        }
        expect(conflictHandled, "409 file_version_precondition_failed must close stale editor and refresh to latest version")

        // =========================================================================
        // 5. Create new topic (`if_version: 0`) + C1 production 403 refusal clears all state
        // =========================================================================
        let createSess = await MainActor.run { store.openCreateSheet() }!
        let createdTopic = await store.createTopic(session: createSess, rawTopic: "deploy-runbook", markdown: "# Deploy Runbook\n\nFollow release-checklist.\n")
        expect(createdTopic != nil && createdTopic?.topic == "deploy-runbook" && createdTopic?.currentVersion == 1, "Creating a new wiki topic must commit v1 cleanly")

        try await postFixture("\(base)/fixture/edge-403?on=1")
        _ = await store.loadTopics()
        let clearedOn403 = await MainActor.run {
            store.topics == nil
                && store.activeFileID == nil
                && store.activeMarkdown == nil
                && store.activeEditSession == nil
                && store.activeCreateSession == nil
                && store.loadFailure == .refused("forbidden")
        }
        expect(clearedOn403, "Production 403 {\"error\":\"forbidden\"} must clear wiki topics, open page, and edit sheets fail-closed")

        print("PASS: VerifyWiki (topic/link rules, fail-closed Reader, v1 history, held-bearer zero-send, frozen edit session & deleted-link zero-download, committed-then-503+401+pre-receipt+refresh retry with exact 1 commit & no version regression, create topic, 403 fail-closed)")
    }
}
