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

        // Create a new doc with initial Markdown
        let createdDoc = await listStore.createObject(title: "Cabin notes", kind: .doc, initialMarkdown: "# Cabin\n\nKey under mat.", api: objectsAPI)
        expect(createdDoc?.kind == .doc, "Expected newly created doc")

        struct RecordedCreate: Decodable {
            struct Args: Decodable { let seat: String; let request_id: String; let object_id: String }
            let command_id: String
            let arguments: Args
        }
        let (createData, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/creates"))
        let creates = try JSONDecoder().decode([RecordedCreate].self, from: createData)
        expect(creates.count == 3, "Expected 3 create calls (1 failed + 1 retry + 1 doc), got \(creates.count)")
        expect(creates[0].command_id == creates[1].command_id && creates[0].arguments.object_id == creates[1].arguments.object_id, "Create retry must reuse command_id and object_id")
        expect(creates.allSatisfy { $0.arguments.seat == "seat_0000000000000000000000" && $0.arguments.request_id == $0.command_id }, "Every create must carry seat and request_id == command_id")

        // 4. Read shared doc -> edit doc -> verify history pagination & opening earlier revision
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/history-page-size?n=1")!)
        let docStore = await MainActor.run {
            SharedObjectDetailStore(workspaceID: ws.id, objectID: docSummary.objectID, expectedKind: .doc, access: access)
        }
        await docStore.load(api: objectsAPI)
        let docDetail = await MainActor.run { docStore.detail }!
        expect(docDetail.authorLabel == "Atlas, your agent" && docDetail.authorIsAgent, "Expected Atlas agent attribution, got \(docDetail.authorLabel)")
        expect(await MainActor.run { docStore.history.count == 1 && docStore.nextHistoryOffset == 1 }, "Expected 1-item paged history with next_offset == 1")

        await docStore.loadMoreHistory(api: objectsAPI)
        let docHistory = await MainActor.run { docStore.history }
        let docNextOffsetNil = await MainActor.run { docStore.nextHistoryOffset == nil }
        expect(docHistory.count == 2 && docNextOffsetNil, "Expected 2 total history entries after loadMoreHistory")
        try await postFixture(origin.appending(path: "fixture/history-page-size"))

        // Open earlier revision -> pauses editing, shows older content -> Back to current resumes editing
        await docStore.openRevision(docHistory[1], api: objectsAPI)
        expect(await MainActor.run { docStore.isViewingEarlierRevision && !docStore.canEditDoc }, "Viewing earlier revision must pause doc editing")
        let displayedOldContent = await MainActor.run { docStore.displayedDetail?.content }
        if case .doc(let oldMd) = displayedOldContent {
            expect(oldMd.contains("Initial draft"), "Expected earlier doc revision content")
        } else {
            expect(false, "Expected historical doc content")
        }
        await MainActor.run { docStore.backToCurrent() }
        expect(await MainActor.run { !docStore.isViewingEarlierRevision && docStore.canEditDoc }, "Back to current must restore editing")

        // Edit and save doc
        await MainActor.run {
            docStore.beginEditingDoc()
            docStore.docDraftText += "\n\nVerified on iOS 26."
        }
        await docStore.saveDoc(api: objectsAPI)
        let updatedDoc = await MainActor.run { docStore.detail }!
        if case .doc(let newMd) = updatedDoc.content {
            expect(newMd.contains("Verified on iOS 26."), "Expected saved doc edit to reload")
        } else {
            expect(false, "Expected updated doc content")
        }
        expect(await MainActor.run { !docStore.isEditingDoc && docStore.history.count == 3 }, "Saving doc must exit editor and prepend revision to history")

        // 5. Read shared list -> 503 non-displaced retry -> post-save read-only retry -> remove
        let detailStore = await MainActor.run {
            SharedObjectDetailStore(workspaceID: ws.id, objectID: listSummary.objectID, expectedKind: .list, access: access)
        }
        await detailStore.load(api: objectsAPI)
        let initialList = await MainActor.run { detailStore.detail }!
        expect(initialList.authorLabel == "Maya Chen" && !initialList.authorIsAgent, "Expected Maya Chen attribution")

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

        // Post-save read failure -> "Saved. Couldn’t refresh the list." + read-only Retry
        await MainActor.run { detailStore.newItemText = "Wood glue" }
        try await postFixture(origin.appending(path: "fixture/fail-next-read"))
        await detailStore.addItem(api: objectsAPI)
        expect(await MainActor.run { detailStore.saveBanner == nil && detailStore.postSaveRefreshMessage == "Saved. Couldn’t refresh the list." && !detailStore.canEditList }, "Post-save read 503 must show refresh notice and block editing")
        let updatesBeforeRetry = try await fetchUpdateCount(origin)
        await detailStore.retryPostSaveRefresh(api: objectsAPI)
        expect(try await fetchUpdateCount(origin) == updatesBeforeRetry, "Post-save retry must be read-only")
        let afterAdd = await MainActor.run { detailStore.detail }!
        let canEditAfterRetry = await MainActor.run { detailStore.canEditList }
        expect(afterAdd.sortedListItems.last?.text == "Wood glue" && canEditAfterRetry, "Post-save retry must load fresh revision and resume editing")

        // 6. 409 conflict -> fail-closed wrong owner check -> 3-way draft recovery -> confirmed reviewed save
        try await postFixture(origin.appending(path: "fixture/conflict-next-update"))
        await detailStore.toggleItem(afterAdd.sortedListItems[2], api: objectsAPI)
        let draftID = await MainActor.run { detailStore.conflictDraftID }
        let hasConflictMsg = await MainActor.run { detailStore.conflictMessage != nil }
        expect(draftID != nil && hasConflictMsg, "409 conflict must record draft_id for recovery")

        // Wrong owner must fail closed
        try await postFixture(origin.appending(path: "fixture/wrong-draft-owner"))
        await detailStore.recoverDraft(api: objectsAPI)
        expect(await MainActor.run { detailStore.recoveredConflict == nil && detailStore.saveError != nil }, "Mismatched draft owner_user_id must fail closed")

        // Matching owner recovers full 3-way draft (base, current by Maya, proposed)
        await detailStore.recoverDraft(api: objectsAPI)
        let recovered = await MainActor.run { detailStore.recoveredConflict }
        expect(recovered != nil, "Expected recovered 3-way conflict draft")
        expect(recovered?.current.authorLabel == "Maya Chen", "Expected competing current revision attributed to Maya Chen")
        expect(recovered?.current.sortedListItems.contains(where: { $0.item_id == "item_maya_competing" }) == true, "Expected competing item in current snapshot")

        // Cannot save before confirming review
        let updatesBeforeConfirm = try await fetchUpdateCount(origin)
        await detailStore.saveReviewedConflict(api: objectsAPI)
        expect(try await fetchUpdateCount(origin) == updatesBeforeConfirm, "Must require explicit review confirmation before saving conflict")

        await MainActor.run { detailStore.reviewedConflictConfirmed = true }
        await detailStore.saveReviewedConflict(api: objectsAPI)
        expect(await MainActor.run { detailStore.recoveredConflict == nil && detailStore.conflictDraftID == nil && detailStore.saveBanner == "Saved" }, "Confirmed conflict save must commit and clear conflict review")

        // 7. Access drop to Reader & explicit workspace_access_refused clears open items
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-mode?mode=reader")!)
        await detailStore.load(api: objectsAPI)
        expect(await MainActor.run { detailStore.detail != nil && detailStore.access?.role == .reader && !detailStore.canEditList }, "Reader demotion keeps content readable without edit controls")
        await docStore.load(api: objectsAPI)
        expect(await MainActor.run { docStore.detail != nil && docStore.access?.role == .reader && !docStore.canEditDoc }, "Reader demotion keeps doc readable without edit controls")

        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-mode?mode=editor")!)
        await detailStore.load(api: objectsAPI)
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/refuse-next-read?reason=workspace_access_refused")!)
        await detailStore.load(api: objectsAPI)
        expect(await MainActor.run { detailStore.detail == nil && !detailStore.canEditList }, "Explicit workspace_access_refused clears open list")

        await docStore.load(api: objectsAPI)
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/refuse-next-read?reason=workspace_access_refused")!)
        await docStore.load(api: objectsAPI)
        expect(await MainActor.run { docStore.detail == nil && !docStore.canEditDoc }, "Explicit workspace_access_refused clears open doc")

        print("PASS: VerifySharedObjects PR 2 (create list/doc + idempotent retry, doc edit/save, history paging & earlier revision, 3-way conflict draft recovery + owner fail-closed, access revocation/demotion, non-displaced & post-save retry)")
    }
}
