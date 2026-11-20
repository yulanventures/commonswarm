import Foundation

@main
struct VerifySharedObjects {
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

    static func fetchUpdateCount(_ origin: URL) async throws -> Int {
        struct AnyUpdate: Decodable {}
        let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/updates"))
        return try JSONDecoder().decode([AnyUpdate].self, from: data).count
    }

    static func waitForHeldRead(_ origin: URL) async throws -> Bool {
        struct HeldState: Decodable { let held: Bool }
        for _ in 0..<50 {
            let (hData, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/read-held"))
            if let st = try? JSONDecoder().decode(HeldState.self, from: hData), st.held {
                return true
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        return false
    }

    static func main() async throws {
        guard CommandLine.arguments.count >= 2, let port = Int(CommandLine.arguments[1]) else {
            fputs("Usage: VerifySharedObjects <port>\n", stderr)
            exit(2)
        }
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let publicKey = "local-fixture"

        let emailAPI = EmailCodeAPI(origin: origin, publicKey: publicKey)
        try await emailAPI.send(to: "reader@example.test")
        let tokens = try await emailAPI.verify(email: "reader@example.test", code: "012345")
        let session = await MainActor.run {
            HumanSession(userID: tokens.userID) { tokens.accessToken }
        }
        let convAPI = ConversationAPI(origin: origin, publicKey: publicKey, session: session)
        let workspaces = try await convAPI.workspaces()
        expect(workspaces.count == 1, "Expected 1 workspace")
        let ws = workspaces[0]
        let objectsAPI = SharedObjectsAPI(api: convAPI)

        // 1. Access consent-required state
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-mode?mode=consent")!)
        let consentStore = await MainActor.run { SharedObjectsListStore(workspaceID: ws.id) }
        await consentStore.load(api: objectsAPI)
        let consentStatus = await MainActor.run { consentStore.accessStatus }
        if case .needsConfirmation = consentStatus {
            // ok
        } else {
            expect(false, "Expected needsConfirmation when content_consent_required")
        }
        expect(await MainActor.run { consentStore.objects.isEmpty }, "No objects should load without consent")

        // 2. Editor access + 1-item page pagination through object_list (filtering out kind == file)
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-mode?mode=editor")!)
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/list-page-size?n=1")!)
        let listStore = await MainActor.run { SharedObjectsListStore(workspaceID: ws.id) }
        await listStore.load(api: objectsAPI)
        let allObjects = await MainActor.run { listStore.objects }
        expect(allObjects.count == 2, "Expected 2 list/doc objects (file excluded), got \(allObjects.count)")
        expect(allObjects.allSatisfy { $0.kind.isListOrDoc }, "Only list and doc kinds may appear")
        try await postFixture(origin.appending(path: "fixture/list-page-size"))

        let listSummary = allObjects.first { $0.kind == .list }!
        let docSummary = allObjects.first { $0.kind == .doc }!
        let access = await MainActor.run { listStore.access }
        expect(access?.canUpdate == true && access?.canCreate == true, "Expected editor create + update permission")

        // 3. Create new list with 503 failure -> idempotent retry reusing command_id and object_id
        try await postFixture(origin.appending(path: "fixture/fail-next-create"))
        let failedCreate = await listStore.createObject(title: "Camping packing list", kind: .list, api: objectsAPI)
        expect(failedCreate == nil, "503 create must not return created summary")
        let pendingCreate = await MainActor.run { listStore.pendingCreate }
        let hasCreateError = await MainActor.run { listStore.createError != nil }
        expect(pendingCreate != nil && hasCreateError, "503 create must keep pendingCreate for idempotent retry")

        let createdList = await listStore.createObject(title: "Camping packing list", kind: .list, api: objectsAPI)
        expect(createdList?.objectID == pendingCreate?.objectID, "Retried create must reuse exact object_id")
        expect(await MainActor.run { listStore.objects.contains(where: { $0.objectID == createdList?.objectID }) }, "Created list must appear in collection")

        let createdDoc = await listStore.createObject(title: "Cabin notes", kind: .doc, initialMarkdown: "# Cabin\n\nKey under mat.", api: objectsAPI)
        expect(createdDoc?.kind == .doc, "Expected newly created doc")

        // 4. Two editors on same doc: Editor 2 saves, Editor 1 refreshes while editing, then saves -> MUST conflict (never silently overwrite Editor 2!)
        let docStore1 = await MainActor.run {
            SharedObjectDetailStore(workspaceID: ws.id, objectID: docSummary.objectID, expectedKind: .doc, access: access)
        }
        let docStore2 = await MainActor.run {
            SharedObjectDetailStore(workspaceID: ws.id, objectID: docSummary.objectID, expectedKind: .doc, access: access)
        }
        await docStore1.load(api: objectsAPI)
        await docStore2.load(api: objectsAPI)

        await MainActor.run {
            docStore1.beginEditingDoc()
            docStore1.docDraftText += "\n\nParagraph from Editor 1."
            docStore2.beginEditingDoc()
            docStore2.docDraftText += "\n\nParagraph from Editor 2."
        }
        await docStore2.saveDoc(api: objectsAPI)
        expect(await MainActor.run { docStore2.saveBanner == "Saved" }, "Editor 2 doc save should commit")

        // Editor 1 refreshes while still editing
        await docStore1.load(api: objectsAPI)
        expect(await MainActor.run { docStore1.isEditingDoc && docStore1.docDraftText.contains("Paragraph from Editor 1.") }, "Refresh while editing must preserve Editor 1 draft")
        expect(await MainActor.run { docStore1.newerRevisionAvailableWhileEditing }, "Refresh must flag that a newer revision arrived while editing")

        // Editor 1 saves -> bound to starting revision -> server returns 409 conflict (Editor 2's paragraph is NOT overwritten!)
        await docStore1.saveDoc(api: objectsAPI)
        expect(await MainActor.run { docStore1.conflictDraftID != nil && docStore1.saveBanner == nil }, "Saving after refresh while editing must conflict instead of silently overwriting")
        await docStore1.recoverDraft(api: objectsAPI)
        let docConflict = await MainActor.run { docStore1.recoveredConflict }
        expect(docConflict != nil, "Expected recovered doc conflict draft")
        if case .doc(let currentMd) = docConflict?.current.content,
           case .doc(let proposedMd) = docConflict?.proposed {
            expect(currentMd.contains("Paragraph from Editor 2."), "Current snapshot must preserve Editor 2 paragraph")
            expect(proposedMd.contains("Paragraph from Editor 1."), "Proposed snapshot must preserve Editor 1 paragraph")
            expect(currentMd.contains("https://example.test/checklist"), "Raw Markdown in comparison must retain exact link destination")
        } else {
            expect(false, "Expected doc content in conflict comparison")
        }
        // Reload current to clear docStore1 conflict for history + held-read tests
        await docStore1.load(api: objectsAPI)

        // 5. History paging + opening earlier revision + held confirming read lock on doc save
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/history-page-size?n=1")!)
        await docStore1.load(api: objectsAPI)
        expect(await MainActor.run { docStore1.history.count == 1 && docStore1.nextHistoryOffset == 1 }, "Expected 1-item paged history")
        await docStore1.loadMoreHistory(api: objectsAPI)
        let docHistory = await MainActor.run { docStore1.history }
        expect(docHistory.count == 2, "Expected 2 entries after loadMoreHistory")
        try await postFixture(origin.appending(path: "fixture/history-page-size"))

        await docStore1.openRevision(docHistory[1], api: objectsAPI)
        expect(await MainActor.run { docStore1.isViewingEarlierRevision && !docStore1.canEditDoc }, "Viewing earlier revision must pause doc editing")
        await MainActor.run { docStore1.backToCurrent() }
        expect(await MainActor.run { !docStore1.isViewingEarlierRevision && docStore1.canEditDoc }, "Back to current must restore doc editing")

        // Hold confirming read on doc save -> editing stays disabled until read releases
        await MainActor.run {
            docStore1.beginEditingDoc()
            docStore1.docDraftText += "\n\nHeld-read doc check."
        }
        try await postFixture(origin.appending(path: "fixture/hold-next-read"))
        let heldDocTask = Task { await docStore1.saveDoc(api: objectsAPI) }
        expect(try await waitForHeldRead(origin), "Expected confirming doc read to be held")
        expect(await MainActor.run { docStore1.isSaving && !docStore1.canEditDoc }, "Doc editing must stay disabled while confirming read is held")
        try await postFixture(origin.appending(path: "fixture/release-held-read"))
        await heldDocTask.value
        expect(await MainActor.run { !docStore1.isSaving && docStore1.canEditDoc }, "Doc editing must resume once confirming read completes")

        // 6. List edits: 503 non-displaced retry + held confirming read + post-save read-only retry
        let detailStore = await MainActor.run {
            SharedObjectDetailStore(workspaceID: ws.id, objectID: listSummary.objectID, expectedKind: .list, access: access)
        }
        await detailStore.load(api: objectsAPI)
        let initialList = await MainActor.run { detailStore.detail }!

        try await postFixture(origin.appending(path: "fixture/fail-next-update"))
        await detailStore.toggleItem(initialList.sortedListItems[0], api: objectsAPI)
        let firstPending = await MainActor.run { detailStore.pendingEdit }
        let lockedOnPending = await MainActor.run { !detailStore.canEditList }
        expect(firstPending != nil && lockedOnPending, "503 must keep pendingEdit and lock list editing")
        await detailStore.toggleItem(initialList.sortedListItems[2], api: objectsAPI)
        expect(await MainActor.run { detailStore.pendingEdit == firstPending }, "Second tap must not displace pending retry")
        await detailStore.retryPendingEdit(api: objectsAPI)
        let afterToggle = await MainActor.run { detailStore.detail }!
        expect(afterToggle.sortedListItems[0].checked == true, "Retried toggle must commit")

        // Hold confirming read after list Add -> second row tap sends zero updates
        await MainActor.run { detailStore.newItemText = "Drop cloth" }
        try await postFixture(origin.appending(path: "fixture/hold-next-read"))
        let heldListTask = Task { await detailStore.addItem(api: objectsAPI) }
        expect(try await waitForHeldRead(origin), "Expected confirming list read to be held")
        expect(await MainActor.run { detailStore.isSaving && !detailStore.canEditList }, "List editing must stay disabled while confirming read is held")
        let updatesHeldBefore = try await fetchUpdateCount(origin)
        await detailStore.toggleItem(afterToggle.sortedListItems[1], api: objectsAPI)
        expect(try await fetchUpdateCount(origin) == updatesHeldBefore, "Tapping second row during held read must send zero updates")
        try await postFixture(origin.appending(path: "fixture/release-held-read"))
        await heldListTask.value
        let afterHeldAdd = await MainActor.run { detailStore.detail }!
        expect(afterHeldAdd.sortedListItems.last?.text == "Drop cloth", "Expected Drop cloth visible after held read releases")

        // 7. 409 conflict -> wrong owner fail-closed -> 3-way recovery -> 503 on Save reviewed changes -> Retry preserves original command_id -> subsequent 409 forces fresh review -> final save commits
        try await postFixture(origin.appending(path: "fixture/conflict-next-update"))
        await detailStore.toggleItem(afterHeldAdd.sortedListItems[2], api: objectsAPI)
        expect(await MainActor.run { detailStore.conflictDraftID != nil }, "409 must set conflictDraftID")

        try await postFixture(origin.appending(path: "fixture/wrong-draft-owner"))
        await detailStore.recoverDraft(api: objectsAPI)
        expect(await MainActor.run { detailStore.recoveredConflict == nil && detailStore.saveError != nil }, "Wrong draft owner must fail closed")

        await detailStore.recoverDraft(api: objectsAPI)
        expect(await MainActor.run { detailStore.recoveredConflict != nil }, "Matching owner must recover 3-way draft")
        await MainActor.run { detailStore.reviewedConflictConfirmed = true }

        // Return 503 on Save reviewed changes -> keeps comparison, confirmation, saveError, and pendingEdit for Retry
        try await postFixture(origin.appending(path: "fixture/fail-next-update"))
        await detailStore.saveReviewedConflict(api: objectsAPI)
        let failedConflictPending = await MainActor.run { detailStore.pendingEdit }
        let keptComparison = await MainActor.run { detailStore.recoveredConflict != nil && detailStore.reviewedConflictConfirmed && detailStore.saveError != nil }
        expect(failedConflictPending != nil && keptComparison, "503 on Save reviewed changes must keep comparison, confirmation, error, and pendingEdit")

        // Retry with original command_id hitting a subsequent 409 -> forces fresh review (clears recoveredConflict & confirmation)
        struct RecordedUpdate: Decodable { let command_id: String }
        try await postFixture(origin.appending(path: "fixture/conflict-next-update"))
        await detailStore.saveReviewedConflict(api: objectsAPI) // also routes to pendingEdit retry!
        let (updData, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/updates"))
        let recorded = try JSONDecoder().decode([RecordedUpdate].self, from: updData)
        expect(recorded.count >= 2 && recorded[recorded.count - 1].command_id == recorded[recorded.count - 2].command_id, "Conflict Retry must reuse original command_id")
        expect(await MainActor.run { detailStore.recoveredConflict == nil && !detailStore.reviewedConflictConfirmed && detailStore.conflictDraftID != nil }, "Subsequent 409 during conflict retry must require fresh review")

        // Recover fresh conflict, confirm, and save cleanly
        await detailStore.recoverDraft(api: objectsAPI)
        await MainActor.run { detailStore.reviewedConflictConfirmed = true }
        await detailStore.saveReviewedConflict(api: objectsAPI)
        expect(await MainActor.run { detailStore.recoveredConflict == nil && detailStore.conflictDraftID == nil && detailStore.saveBanner == "Saved" }, "Fresh reviewed save must commit cleanly")

        // 8. Access drop to Reader & explicit workspace_access_refused
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-mode?mode=reader")!)
        await detailStore.load(api: objectsAPI)
        expect(await MainActor.run { detailStore.detail != nil && detailStore.access?.role == .reader && !detailStore.canEditList }, "Reader demotion keeps content readable without edit controls")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-mode?mode=editor")!)
        await detailStore.load(api: objectsAPI)
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/refuse-next-read?reason=workspace_access_refused")!)
        await detailStore.load(api: objectsAPI)
        expect(await MainActor.run { detailStore.detail == nil && !detailStore.canEditList }, "Explicit workspace_access_refused clears open list")

        print("PASS: VerifySharedObjects PR 2 (edit-start revision binding across refresh, failed reviewed save Retry + subsequent 409 fresh review, raw Markdown comparison, held confirming read on list & doc, create idempotent retry, access revocation)")
    }
}
