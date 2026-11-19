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
        expect(access?.canUpdate == true, "Expected editor update permission")

        // 3. Read shared doc -> verify agent attribution ("Atlas, your agent") and inert Markdown parsing
        let docStore = await MainActor.run {
            SharedObjectDetailStore(workspaceID: ws.id, objectID: docSummary.objectID, expectedKind: .doc, access: access)
        }
        await docStore.load(api: objectsAPI)
        let docDetail = await MainActor.run { docStore.detail }!
        expect(docDetail.authorLabel == "Atlas, your agent" && docDetail.authorIsAgent, "Expected Atlas agent attribution, got \(docDetail.authorLabel)")
        guard case .doc(let md) = docDetail.content else {
            expect(false, "Expected doc content")
            return
        }
        let blocks = SharedObjectsRules.parseInertMarkdown(md)
        expect(blocks.contains(where: { if case .heading(_, 1, "Pre-flight checklist") = $0 { return true }; return false }), "Expected H1 block")
        expect(blocks.contains(where: { if case .paragraph(_, let t) = $0 { return t.contains("release checklist") && !t.contains("https://") }; return false }), "Links must be rendered as inert text without URLs")
        expect(blocks.contains(where: { if case .codeBlock(_, let t) = $0 { return t.contains("verify.sh") }; return false }), "Expected code block")

        // 4. Read shared list -> toggle item with 503 failure -> idempotent Retry reusing exact command_id -> committed + reloaded
        let detailStore = await MainActor.run {
            SharedObjectDetailStore(workspaceID: ws.id, objectID: listSummary.objectID, expectedKind: .list, access: access)
        }
        await detailStore.load(api: objectsAPI)
        let initialList = await MainActor.run { detailStore.detail }!
        expect(initialList.authorLabel == "Maya Chen" && !initialList.authorIsAgent, "Expected Maya Chen attribution, got \(initialList.authorLabel)")
        expect(initialList.sortedListItems.count == 3, "Expected 3 initial list items")

        try await postFixture(origin.appending(path: "fixture/fail-next-update"))
        await detailStore.toggleItem(initialList.sortedListItems[0], api: objectsAPI)
        expect(await MainActor.run { detailStore.saveError != nil && detailStore.pendingEdit != nil }, "503 must keep pending edit and show unconfirmed error")

        await detailStore.retryPendingEdit(api: objectsAPI)
        let afterToggle = await MainActor.run { detailStore.detail }!
        expect(afterToggle.sortedListItems[0].checked == true, "Retried toggle must commit and reload checked == true")
        expect(afterToggle.revision.token != initialList.revision.token, "Committed edit must reload new revision token")
        expect(await MainActor.run { detailStore.saveBanner == "Saved" }, "Expected Saved banner")

        // 5. Add new item + Remove item
        await MainActor.run { detailStore.newItemText = "Wood glue" }
        await detailStore.addItem(api: objectsAPI)
        let afterAdd = await MainActor.run { detailStore.detail }!
        expect(afterAdd.sortedListItems.count == 4 && afterAdd.sortedListItems.last?.text == "Wood glue", "Expected Wood glue appended at end")
        expect(await MainActor.run { detailStore.newItemText.isEmpty }, "Add field should clear on committed save")

        await detailStore.removeItem(afterAdd.sortedListItems[1], api: objectsAPI)
        let afterRemove = await MainActor.run { detailStore.detail }!
        expect(afterRemove.sortedListItems.count == 3, "Expected 3 items after remove")

        // 6. Conflict handling: 409 conflict surfaces conflict banner and Reload recovers fresh revision
        try await postFixture(origin.appending(path: "fixture/conflict-next-update"))
        await detailStore.toggleItem(afterRemove.sortedListItems[0], api: objectsAPI)
        expect(await MainActor.run { detailStore.conflictMessage != nil }, "409 conflict must set conflictMessage")
        await detailStore.load(api: objectsAPI)
        expect(await MainActor.run { detailStore.conflictMessage == nil }, "Reload must clear conflict and load current revision")

        // 7. Verify wire updates (retry reused exact command_id, seat + request_id == command_id)
        struct RecordedUpdate: Decodable {
            struct Args: Decodable {
                let seat: String
                let request_id: String
                let object_id: String
            }
            let command_id: String
            let arguments: Args
        }
        let (updData, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/updates"))
        let updates = try JSONDecoder().decode([RecordedUpdate].self, from: updData)
        expect(updates.count == 5, "Expected 5 update calls (1 failed + 1 retry + 1 add + 1 remove + 1 conflict), got \(updates.count)")
        expect(updates[0].command_id == updates[1].command_id, "Retry must reuse original command_id")
        expect(updates.allSatisfy { $0.arguments.seat == "seat_0000000000000000000000" && $0.arguments.request_id == $0.command_id }, "Every update must carry seat and request_id == command_id")

        // 8. Reader access disables editing
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-mode?mode=reader")!)
        let readerStore = await MainActor.run { SharedObjectsListStore(workspaceID: ws.id) }
        await readerStore.load(api: objectsAPI)
        let readerAccess = await MainActor.run { readerStore.access }
        expect(readerAccess?.role == .reader && readerAccess?.canRead == true && readerAccess?.canUpdate == false, "Reader access must allow read and disallow update")

        print("PASS: VerifySharedObjects (access consent/reader/editor, paginated object_list filtering files, inert doc Markdown, list toggle/add/remove, 503 idempotent retry, 409 conflict reload)")
    }
}
