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
        let puts: Int
    }

    struct HeldStatus: Decodable {
        let held: Bool
    }

    static func waitUntilCreateHeld(_ origin: URL) async throws {
        for _ in 0..<200 {
            let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/create-held"))
            if try JSONDecoder().decode(HeldStatus.self, from: data).held {
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        expect(false, "Timed out waiting for file_version_create response hold")
    }

    static func recordedCommands(_ origin: URL) async throws -> [RecordedCommand] {
        let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/commands"))
        return try JSONDecoder().decode([RecordedCommand].self, from: data)
    }

    static func mutationStats(_ origin: URL) async throws -> MutationCount {
        let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/mutations"))
        return try JSONDecoder().decode(MutationCount.self, from: data)
    }

    static func commitMutations(_ origin: URL) async throws -> Int {
        try await mutationStats(origin).commits
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

        // Witness 2 (URL scheme sanitization): allow ONLY http/https with non-empty host; strip tel:, sms:, javascript:, custom, hostless
        let mixedLinks = "[call](tel:12345) [text](sms:555) [js](javascript:alert(1)) [custom](myapp://open) [hostless](https:///path) [safe](https://example.com/docs) [http](http://docs.example.com)"
        let sanitized = WikiRules.sanitizedInlineMarkdown(mixedLinks)
        let keptLinks = sanitized.runs.compactMap { $0.link?.absoluteString }
        expect(
            keptLinks == ["https://example.com/docs", "http://docs.example.com"],
            "sanitizedInlineMarkdown must keep ONLY http/https links with non-empty host; got: \(keptLinks)"
        )

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

        // Witness 1 (version switch clears activeMarkdown & activeEditSession BEFORE loading target version)
        _ = await MainActor.run { store.beginEdit(fileID: checklist.fileID) }
        await MainActor.run { bearer.holdNext(1) }
        let versionSwitchTask = Task { await store.openTopic(fileID: checklist.fileID, version: 1) }
        await bearer.waitUntilHeld()
        let clearedDuringSwitch = await MainActor.run {
            store.activeVersion == 1 && store.activeMarkdown == nil && store.activeEditSession == nil && store.isLoadingContent
        }
        await MainActor.run { bearer.release() }
        await versionSwitchTask.value
        let v1Settled = await MainActor.run {
            store.activeVersion == 1 && (store.activeMarkdown ?? "").contains("Initial checklist draft")
        }
        expect(clearedDuringSwitch && v1Settled, "Switching version on the same topic must clear activeMarkdown and activeEditSession before loading target version")
        await store.openTopic(fileID: checklist.fileID, version: 2)

        // Witness 3 (duplicate member_profiles & agent_principals rows never crash)
        try await postFixture("\(base)/fixture/duplicate-directory?on=1")
        let dupLoadOK = await store.loadTopics()
        expect(dupLoadOK, "Duplicate member_profiles/agent_principals rows must decode safely without trapping")
        try await postFixture("\(base)/fixture/duplicate-directory?on=0")

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
        //             + bound retry visibility after refresh + detail Back presentation fence
        //             + exact 1 commit + no stale replay regression
        // =========================================================================
        let listPres = WikiPresentationToken()
        let detailPres = WikiPresentationToken()
        await MainActor.run {
            store.beginPresentation(listPres)
            store.beginPresentation(detailPres)
        }
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
        let retry401 = await store.retryPendingSave(firstRetryItem!, presentation: detailPres)
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
        let retryPreRefusal = await store.retryPendingSave(firstRetryItem!, presentation: detailPres)
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

        // Detail-page retry presentation fence across Back while bearer lookup is held:
        // listPres remains active (so store is NOT retired), detailPres leaves on Back ->
        // ZERO write commands, ZERO PUTs, ZERO commits, AND frozen pending IDs stay intact!
        let frozenBeforeBack = await MainActor.run { store.pendingSaves[checklist.fileID]! }
        let cmdsBeforeBackRetry = try await recordedCommands(origin).filter { $0.kind.hasPrefix("file_version_") }.count
        let statsBeforeBackRetry = try await mutationStats(origin)
        await MainActor.run { bearer.holdNext(1) }
        let backRetryTask = Task { await store.retryPendingSave(firstRetryItem!, presentation: detailPres) }
        await bearer.waitUntilHeld()
        await MainActor.run {
            store.endPresentation(detailPres)
            bearer.release()
        }
        let backRetryResult = await backRetryTask.value
        let cmdsAfterBackRetry = try await recordedCommands(origin).filter { $0.kind.hasPrefix("file_version_") }.count
        let statsAfterBackRetry = try await mutationStats(origin)
        let frozenPreservedAfterBack = await MainActor.run {
            guard let p = store.pendingSaves[checklist.fileID] else { return false }
            return p.outcomeUnknown
                && p.versionID == frozenBeforeBack.versionID
                && p.createCommandID == frozenBeforeBack.createCommandID
                && p.commitCommandID == frozenBeforeBack.commitCommandID
                && p.slot == frozenBeforeBack.slot
                && p.uploaded == frozenBeforeBack.uploaded
        }
        expect(
            !backRetryResult
                && cmdsAfterBackRetry == cmdsBeforeBackRetry
                && statsAfterBackRetry.puts == statsBeforeBackRetry.puts
                && statsAfterBackRetry.commits == statsBeforeBackRetry.commits
                && frozenPreservedAfterBack,
            "Navigating Back from detail during held bearer must retire detail retry with ZERO sends/PUTs/commits and keep frozen pending IDs"
        )

        // 4a. Permanent presentation retirement across list leave & return:
        //     Start a list retry while bearer is held -> leave list (retire listPres) ->
        //     attempt reusing retired listPres (must be ignored!) AND enter fresh listPres2 ->
        //     release bearer -> ZERO file commands, ZERO PUTs, ZERO commits, frozen IDs preserved!
        let cmdsBeforeListLeave = try await recordedCommands(origin).filter { $0.kind.hasPrefix("file_version_") }.count
        let statsBeforeListLeave = try await mutationStats(origin)
        await MainActor.run { bearer.holdNext(1) }
        let listReturnTask = Task { await store.retryPendingSave(firstRetryItem!, presentation: listPres) }
        await bearer.waitUntilHeld()
        let listPres2 = WikiPresentationToken()
        await MainActor.run {
            store.endPresentation(listPres)
            // Even attempting to re-register the retired token must be refused permanently.
            store.beginPresentation(listPres)
            // Returning to the list mints a fresh presentation token.
            store.beginPresentation(listPres2)
            bearer.release()
        }
        let listReturnResult = await listReturnTask.value
        let cmdsAfterListLeave = try await recordedCommands(origin).filter { $0.kind.hasPrefix("file_version_") }.count
        let statsAfterListLeave = try await mutationStats(origin)
        let frozenPreservedAfterListLeave = await MainActor.run {
            guard let p = store.pendingSaves[checklist.fileID] else { return false }
            return p.outcomeUnknown
                && p.versionID == frozenBeforeBack.versionID
                && p.createCommandID == frozenBeforeBack.createCommandID
                && p.commitCommandID == frozenBeforeBack.commitCommandID
        }
        expect(
            !listReturnResult
                && cmdsAfterListLeave == cmdsBeforeListLeave
                && statsAfterListLeave.puts == statsBeforeListLeave.puts
                && statsAfterListLeave.commits == statsBeforeListLeave.commits
                && frozenPreservedAfterListLeave,
            "Leaving and returning to the list must permanently retire the earlier list presentation with ZERO file commands/PUTs/commits and keep frozen IDs"
        )

        // Advance server past committed version (v+1 -> v+3), refresh, then explicitly retry from a fresh active presentation
        // -> replays v+1 with EXACTLY 1 commit & NO version regression!
        try await postFixture("\(base)/fixture/advance-version?file_id=\(checklist.fileID.uuidString.lowercased())")
        _ = await store.loadTopics()
        let detailPres2 = WikiPresentationToken()
        await MainActor.run { store.beginPresentation(detailPres2) }
        await store.openTopic(fileID: checklist.fileID)
        let newerVer = await MainActor.run { store.activeTopic!.currentVersion }
        expect(newerVer == currentChecklistVer + 3, "Expected server advanced to currentChecklistVer + 3")

        let replayedOK = await store.retryPendingSave(firstRetryItem!, presentation: detailPres2)
        let replayClean = await MainActor.run {
            replayedOK
                && store.eligiblePendingRetries(for: checklist.fileID).isEmpty
                && store.activeTopic?.currentVersion == newerVer
                && store.activeVersion == newerVer
        }
        let commitsAfter = try await commitMutations(origin)
        expect(replayClean && commitsAfter == commitsBefore + 1, "Bound retry must replay with EXACTLY 1 commit and must NOT regress displayed version")

        // 409 file_version_precondition_failed: concurrent server update closes editor, refreshes to latest,
        // AND preserves unsent Markdown alongside the latest version so the user can compare/copy and save a merge.
        let conflictEditSess = await MainActor.run { store.beginEdit(fileID: checklist.fileID) }!
        try await postFixture("\(base)/fixture/advance-version?file_id=\(checklist.fileID.uuidString.lowercased())")
        let conflictSaveOK = await store.saveEdit(session: conflictEditSess, markdown: "# Conflicting edit\n")
        let conflictHandled = await MainActor.run {
            !conflictSaveOK
                && store.activeEditSession == nil
                && (store.actionError ?? "").contains("Someone else updated")
                && store.activeTopic?.currentVersion == newerVer + 2
                && store.conflictDraft?.fileID == checklist.fileID
                && store.conflictDraft?.unsentMarkdown == "# Conflicting edit\n"
                && store.activeMarkdown != "# Conflicting edit\n"
        }
        expect(conflictHandled, "409 file_version_precondition_failed must close stale editor, refresh to latest version, and keep unsent Markdown in conflictDraft")

        // Reopening Edit shows latest server Markdown in the editor while keeping unsent Markdown available to compare/copy.
        let reopenedAfterConflict = await MainActor.run { store.beginEdit(fileID: checklist.fileID) }!
        let reopenedKeepsBoth = await MainActor.run {
            reopenedAfterConflict.baseVersion == newerVer + 2
                && reopenedAfterConflict.initialMarkdown == store.activeMarkdown
                && store.conflictDraft?.unsentMarkdown == "# Conflicting edit\n"
        }
        expect(reopenedKeepsBoth, "Reopening Edit after conflict must keep latest Markdown in the editor AND unsent Markdown available in conflictDraft")
        let mergedWikiBody = reopenedAfterConflict.initialMarkdown + "\n# Conflicting edit\n"
        let mergedSaveOK = await store.saveEdit(session: reopenedAfterConflict, markdown: mergedWikiBody)
        let mergedDraftCleared = await MainActor.run {
            store.conflictDraft == nil
                && store.activeTopic?.currentVersion == newerVer + 3
                && store.activeMarkdown == mergedWikiBody
        }
        expect(mergedSaveOK && mergedDraftCleared, "Saving merged wiki Markdown after conflict must commit cleanly and clear conflictDraft")

        // =========================================================================
        // 5. Create new topic (`if_version: 0`) + same-name/same-version/different-UUID replacement witnesses
        //    + C1 production 403 refusal clears all state
        // =========================================================================
        let createSess = await MainActor.run { store.openCreateSheet() }!
        let createdTopic = await store.createTopic(session: createSess, rawTopic: "deploy-runbook", markdown: "# Deploy Runbook\n\nFollow release-checklist.\n")
        expect(createdTopic != nil && createdTopic?.topic == "deploy-runbook" && createdTopic?.currentVersion == 1, "Creating a new wiki topic must commit v1 cleanly")

        // 5a. Same-name, same-version, different-UUID witness on direct edit (ZERO PUTs, ZERO commits)
        await store.openTopic(fileID: createdTopic!.fileID)
        let replaceEditSess = await MainActor.run { store.beginEdit(fileID: createdTopic!.fileID) }!
        let replacementUUID1 = UUID()
        try await postFixture("\(base)/fixture/replace-topic?file_id=\(createdTopic!.fileID.uuidString.lowercased())&replacement_id=\(replacementUUID1.uuidString.lowercased())")
        let statsBeforeReplaceEdit = try await mutationStats(origin)
        let commitCmdsBeforeReplaceEdit = try await recordedCommands(origin).filter { $0.kind == "file_version_commit" }.count
        let replaceEditOK = await store.saveEdit(session: replaceEditSess, markdown: "# Stale edit must not touch replacement UUID\n")
        let statsAfterReplaceEdit = try await mutationStats(origin)
        let commitCmdsAfterReplaceEdit = try await recordedCommands(origin).filter { $0.kind == "file_version_commit" }.count
        let replaceEditClean = await MainActor.run {
            !replaceEditOK
                && store.activeEditSession == nil
                && (store.actionError ?? "").lowercased().contains("replaced")
        }
        expect(
            replaceEditClean
                && statsAfterReplaceEdit.puts == statsBeforeReplaceEdit.puts
                && statsAfterReplaceEdit.commits == statsBeforeReplaceEdit.commits
                && commitCmdsAfterReplaceEdit == commitCmdsBeforeReplaceEdit,
            "Same-name, same-version, different-UUID replacement on direct edit must execute ZERO PUTs and ZERO commits"
        )

        // 5b. Same-name, same-version, different-UUID witness on retry (ZERO PUTs, ZERO commits)
        let retryCreateSess = await MainActor.run { store.openCreateSheet() }!
        let retryTopic = await store.createTopic(session: retryCreateSess, rawTopic: "replace-retry-target", markdown: "# Retry Target\n\nOriginal v1.\n")
        expect(retryTopic != nil && retryTopic?.currentVersion == 1, "Expected created topic for replacement-retry witness")
        await store.openTopic(fileID: retryTopic!.fileID)
        let retrySeedEdit = await MainActor.run { store.beginEdit(fileID: retryTopic!.fileID) }!
        try await postFixture("\(base)/fixture/create-503-once")
        let seededUnknownOK = await store.saveEdit(session: retrySeedEdit, markdown: "# Pending edit before replacement\n")
        let replaceRetryItem = await MainActor.run { store.eligiblePendingRetries(for: retryTopic!.fileID).first }
        expect(!seededUnknownOK && replaceRetryItem != nil, "503 on file_version_create must leave pending edit retry bound to opened UUID")

        let replacementUUID2 = UUID()
        try await postFixture("\(base)/fixture/replace-topic?file_id=\(retryTopic!.fileID.uuidString.lowercased())&replacement_id=\(replacementUUID2.uuidString.lowercased())")
        let statsBeforeReplaceRetry = try await mutationStats(origin)
        let commitCmdsBeforeReplaceRetry = try await recordedCommands(origin).filter { $0.kind == "file_version_commit" }.count
        let replaceRetryOK = await store.retryPendingSave(replaceRetryItem!, presentation: detailPres2)
        let statsAfterReplaceRetry = try await mutationStats(origin)
        let commitCmdsAfterReplaceRetry = try await recordedCommands(origin).filter { $0.kind == "file_version_commit" }.count
        expect(
            !replaceRetryOK
                && statsAfterReplaceRetry.puts == statsBeforeReplaceRetry.puts
                && statsAfterReplaceRetry.commits == statsBeforeReplaceRetry.commits
                && commitCmdsAfterReplaceRetry == commitCmdsBeforeReplaceRetry,
            "Same-name, same-version, different-UUID replacement on retry must execute ZERO PUTs and ZERO commits"
        )

        // 5c. Retirement between slot creation (file_version_create) and signed PUT dispatch:
        //     Seed a fresh topic with an unknown edit whose file_version_create failed with 503 (slot == nil).
        //     Start retry on slotPres1 while fixture holds the file_version_create response after creating the slot.
        //     Retire slotPres1 BEFORE releasing the response -> putStorage's canDispatch gate cancels BEFORE upload ->
        //     ZERO PUTs, ZERO commits, slot preserved with uploaded == false.
        //     Then retry on fresh slotPres2 -> reconciles with EXACTLY 1 PUT and 1 commit using the frozen IDs!
        let putGateCreateSess = await MainActor.run { store.openCreateSheet() }!
        let putGateTopic = await store.createTopic(session: putGateCreateSess, rawTopic: "put-gate-target", markdown: "# Put Gate\n\nOriginal v1.\n")
        expect(putGateTopic != nil && putGateTopic?.currentVersion == 1, "Expected created topic for slot-to-PUT retirement witness")
        await store.openTopic(fileID: putGateTopic!.fileID)
        let putGateSeedEdit = await MainActor.run { store.beginEdit(fileID: putGateTopic!.fileID) }!
        try await postFixture("\(base)/fixture/create-503-once")
        let putGateSeedOK = await store.saveEdit(session: putGateSeedEdit, markdown: "# Put Gate v2\n\nUpdated body.\n")
        let putGateRetryItem = await MainActor.run { store.eligiblePendingRetries(for: putGateTopic!.fileID).first }
        let putGatePendingBefore = await MainActor.run { store.pendingSaves[putGateTopic!.fileID] }
        expect(
            !putGateSeedOK && putGateRetryItem != nil && putGatePendingBefore?.slot == nil,
            "503 on file_version_create must leave pending edit with slot == nil before slot-to-PUT witness"
        )

        let slotPres1 = WikiPresentationToken()
        await MainActor.run { store.beginPresentation(slotPres1) }
        try await postFixture("\(base)/fixture/hold-create-response-once")
        let statsBeforeSlotRetire = try await mutationStats(origin)
        let slotRetireTask = Task { await store.retryPendingSave(putGateRetryItem!, presentation: slotPres1) }
        try await waitUntilCreateHeld(origin)
        await MainActor.run { store.endPresentation(slotPres1) }
        try await postFixture("\(base)/fixture/release-create-response")
        let slotRetireOK = await slotRetireTask.value
        let statsAfterSlotRetire = try await mutationStats(origin)
        let pendingAfterSlotRetire = await MainActor.run { store.pendingSaves[putGateTopic!.fileID] }
        expect(
            !slotRetireOK
                && statsAfterSlotRetire.puts == statsBeforeSlotRetire.puts
                && statsAfterSlotRetire.commits == statsBeforeSlotRetire.commits
                && pendingAfterSlotRetire?.slot != nil
                && pendingAfterSlotRetire?.uploaded == false
                && pendingAfterSlotRetire?.versionID == putGatePendingBefore?.versionID
                && pendingAfterSlotRetire?.commitCommandID == putGatePendingBefore?.commitCommandID,
            "Retiring presentation between slot creation and PUT must cancel at putStorage with ZERO PUTs and ZERO commits while keeping frozen IDs and slot"
        )

        // Direct transport-level putStorage canDispatch witness: even with an active login
        // and a prepared temp file, putStorage must fail closed with CancellationError and ZERO PUTs
        // when canDispatch() returns false at final signed PUT dispatch.
        let directPutTemp = FileManager.default.temporaryDirectory
            .appendingPathComponent("commonswarm-verify-put-gate-\(UUID().uuidString.lowercased()).md")
        try Data("# Blocked PUT\n".utf8).write(to: directPutTemp, options: .atomic)
        defer { try? FileManager.default.removeItem(at: directPutTemp) }
        var blockedPutReq = URLRequest(
            url: origin.appending(path: "storage/v1/object/upload/sign/swarm-files/\(ws.id.uuidString.lowercased())/\(putGateTopic!.fileID.uuidString.lowercased())/99")
        )
        blockedPutReq.httpMethod = "PUT"
        final class DummyDelegate: NSObject, URLSessionTaskDelegate {}
        let putsBeforeDirectGate = try await mutationStats(origin).puts
        var directPutCancelled = false
        do {
            _ = try await session.putStorage(blockedPutReq, from: directPutTemp, delegate: DummyDelegate()) {
                false
            }
        } catch is CancellationError {
            directPutCancelled = true
        }
        let putsAfterDirectGate = try await mutationStats(origin).puts
        expect(
            directPutCancelled && putsAfterDirectGate == putsBeforeDirectGate,
            "HumanSession.putStorage must check canDispatch right at transport dispatch and send ZERO PUTs when retired"
        )

        let slotPres2 = WikiPresentationToken()
        await MainActor.run { store.beginPresentation(slotPres2) }
        let freshSlotRetryOK = await store.retryPendingSave(putGateRetryItem!, presentation: slotPres2)
        let statsAfterFreshSlotRetry = try await mutationStats(origin)
        let settledPutGate = await MainActor.run {
            freshSlotRetryOK
                && store.eligiblePendingRetries(for: putGateTopic!.fileID).isEmpty
                && store.topics?.first(where: { $0.fileID == putGateTopic!.fileID })?.currentVersion == 2
        }
        expect(
            settledPutGate
                && statsAfterFreshSlotRetry.puts == statsAfterSlotRetire.puts + 1
                && statsAfterFreshSlotRetry.commits == statsAfterSlotRetire.commits + 1,
            "Fresh presentation retry after slot-to-PUT retirement must complete with EXACTLY 1 PUT and 1 commit using frozen IDs"
        )

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

        print("PASS: VerifyWiki (topic/link rules, fail-closed Reader, v1 history, held-bearer zero-send, frozen edit session & deleted-link zero-download, committed-then-503+401+pre-receipt+refresh+detail-Back-presentation-fence retry, same-name/same-version/different-UUID zero-PUT/zero-commit edit & retry, create topic, 403 fail-closed)")
    }
}
