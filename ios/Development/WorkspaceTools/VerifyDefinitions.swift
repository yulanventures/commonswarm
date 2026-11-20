import Foundation

@main
struct VerifyDefinitions {
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

    struct RecordedCommand: Decodable {
        let command_id: String
        let kind: String
        let object_id: String
        let request_id: String?
        let base_token: String?
    }

    struct MutationCount: Decodable {
        let count: Int
    }

    static func recordedCommands(_ origin: URL) async throws -> [RecordedCommand] {
        let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/commands"))
        return try JSONDecoder().decode([RecordedCommand].self, from: data)
    }

    static func mutationCount(_ origin: URL) async throws -> Int {
        let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/mutations"))
        return try JSONDecoder().decode(MutationCount.self, from: data).count
    }

    static func waitForHeldList(_ origin: URL) async throws -> Bool {
        struct HeldState: Decodable { let held: Bool }
        for _ in 0..<50 {
            let (hData, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/list-held"))
            if let st = try? JSONDecoder().decode(HeldState.self, from: hData), st.held {
                return true
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        return false
    }

    static func main() async throws {
        guard CommandLine.arguments.count >= 2, let port = Int(CommandLine.arguments[1]) else {
            fputs("Usage: VerifyDefinitions <port>\n", stderr)
            exit(2)
        }
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let publicKey = "local-fixture"

        // 0. Pure validation & slug rules
        expect(DefinitionsRules.normalizeTerm("  Net\nRetention  ") == "Net Retention", "Term must collapse newlines")
        let tooLong = String(repeating: "a", count: 81)
        if case .failure(.lengthExceeded) = DefinitionsRules.validateFields(term: tooLong, meaning: "ok", source: "") {
            // pass
        } else {
            expect(false, "81-char term must fail validation")
        }
        if case .failure(.missingRequired) = DefinitionsRules.validateFields(term: "ARR", meaning: "   ", source: "") {
            // pass
        } else {
            expect(false, "Blank meaning must fail validation")
        }
        let slug1 = DefinitionsRules.makeObjectID(term: "Net Retention!", existingIDs: ["def-net-retention"])
        expect(slug1 == "def-net-retention-2", "Duplicate slug must append -2, got \(slug1)")

        // Sign in
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
        let defsAPI = DefinitionsAPI(api: convAPI)

        // 1. Load list & detail
        let listStore = await MainActor.run { DefinitionsListStore(workspaceID: ws.id) }
        await listStore.load(api: defsAPI)
        let items = await MainActor.run { listStore.definitions }
        expect(items.count == 3, "Expected 3 seeded definitions, got \(items.count)")

        let detailStore = await MainActor.run { DefinitionDetailStore(workspaceID: ws.id, objectID: "def-arr") }
        await detailStore.load(api: defsAPI)
        let arrDetail = await MainActor.run { detailStore.detail }!
        expect(arrDetail.status == .proposalPending && arrDetail.certified?.certifiedByLabel == "Maya Chen", "ARR proposalPending expected")

        // 2. HezSec C2 Witness: Edit session binds strictly to the opened revision; conflict retires open editor and stale editor sends ZERO writes!
        let staleSession = await MainActor.run { detailStore.beginEdit() }!
        let openedToken = staleSession.baseRevision.token
        expect(await MainActor.run { detailStore.activeEditSession?.id == staleSession.id }, "Edit session must be open")

        try await postFixture(origin.appending(path: "fixture/conflict-next-update"))
        let conflictOK = await detailStore.update(session: staleSession, term: "ARR", meaning: "Stale draft", source: "stripe.v3", api: defsAPI)
        expect(!conflictOK, "Conflict update must return false")
        let afterConflict = await MainActor.run {
            (detailStore.activeEditSession == nil, detailStore.detail?.current.revision.token ?? "", detailStore.errorMessage ?? "")
        }
        expect(afterConflict.0, "Conflict must retire/close the stale open editor")
        expect(afterConflict.1 != openedToken, "Conflict must reload the newer server revision")
        expect(afterConflict.2.contains("newer version"), "Expected conflict notice")

        // Attempting to submit again from the stale editor session MUST fail closed locally and send ZERO network calls!
        let cmdsBeforeStaleRetry = try await recordedCommands(origin).count
        let staleResubmitOK = await detailStore.update(session: staleSession, term: "ARR", meaning: "Stale draft", source: "stripe.v3", api: defsAPI)
        let cmdsAfterStaleRetry = try await recordedCommands(origin).count
        expect(!staleResubmitOK, "Stale editor session must be refused locally")
        expect(cmdsBeforeStaleRetry == cmdsAfterStaleRetry, "Stale editor session must send ZERO network requests (never rebase onto refreshed revision)")

        // User explicitly opens a fresh editor from the refreshed revision -> binds to newer token and commits!
        let freshSession = await MainActor.run { detailStore.beginEdit() }!
        expect(freshSession.baseRevision.token == afterConflict.1, "Fresh edit session must bind to refreshed revision token")
        let freshUpdateOK = await detailStore.update(session: freshSession, term: "ARR", meaning: "Reviewed ARR v4", source: "stripe.v4", api: defsAPI)
        expect(freshUpdateOK, "Explicit fresh edit must commit")
        let lastUpdateCmd = try await recordedCommands(origin).last { $0.kind == "definition_update" }!
        expect(lastUpdateCmd.base_token == freshSession.baseRevision.token, "Committed update must carry fresh session base token")

        // 3. HezSec C3 Witness A (Certify): committed-but-unacknowledged 503 -> pre-receipt refusal preserves unknown outcome & commandID -> replay executes AT MOST ONE mutation!
        let mutsBeforeCert = try await mutationCount(origin)
        try await postFixture(origin.appending(path: "fixture/commit-then-503"))
        let unconfirmedCert = await detailStore.certify(api: defsAPI)
        expect(!unconfirmedCert, "Committed-then-503 certify must surface unconfirmed")
        let mutsAfterCommit503 = try await mutationCount(origin)
        expect(mutsAfterCommit503 == mutsBeforeCert + 1, "Server committed the write before returning 503")
        let pendingCertID = await MainActor.run { detailStore.pendingCertify?.commandID }!
        expect(await MainActor.run { detailStore.hasUnknownPendingCertify }, "Certify must track unknown outcome")

        // Pre-receipt refusal on retry (e.g. rate_limited before receipt lookup) MUST NOT clear pendingCertID or claim failure!
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/pre-receipt-refusal?reason=rate_limited")!)
        let refusedCertRetry = await detailStore.certify(api: defsAPI)
        expect(!refusedCertRetry, "Pre-receipt refused retry must return false")
        let certAfterRefusal = await MainActor.run {
            (detailStore.pendingCertify?.commandID, detailStore.hasUnknownPendingCertify, detailStore.errorMessage ?? "")
        }
        expect(certAfterRefusal.0 == pendingCertID && certAfterRefusal.1, "Pre-receipt refusal must preserve original commandID and unknown outcome")
        expect(certAfterRefusal.2.contains("unknown") && certAfterRefusal.2.contains("may already have"), "Refused retry must preserve unknown-outcome warning, got: \(certAfterRefusal.2)")

        // Authorized replay sends exact same commandID -> receipt replayed, ZERO duplicate server mutations!
        let replayedCert = await detailStore.certify(api: defsAPI)
        expect(replayedCert, "Authorized replay of committed certify must succeed via receipt")
        let mutsAfterCertReplay = try await mutationCount(origin)
        expect(mutsAfterCertReplay == mutsAfterCommit503, "Replay must execute AT MOST ONE write on server")
        let certCmds = try await recordedCommands(origin).filter { $0.kind == "household_definition_certify" }
        expect(certCmds.count == 3 && Set(certCmds.map(\.command_id)).count == 1, "All 3 certify attempts must carry the exact same command_id")

        // 4. HezSec C3 Witness B (Create): committed-but-unacknowledged 503 -> reopen New sheet preserves pending -> pre-receipt refusal preserves unknown outcome -> different payload blocked -> authorized read reconciles!
        let mutsBeforeCreate = try await mutationCount(origin)
        try await postFixture(origin.appending(path: "fixture/commit-then-503"))
        let unconfirmedCreate = await listStore.createDefinition(term: "Gross Margin", meaning: "Revenue minus COGS.", source: "finance.gl", api: defsAPI)
        expect(unconfirmedCreate == nil, "Committed-then-503 create must surface unconfirmed")
        let mutsAfterCreate503 = try await mutationCount(origin)
        expect(mutsAfterCreate503 == mutsBeforeCreate + 1, "Server committed create before 503")
        let pendingCreateID = await MainActor.run { listStore.pendingCreate?.commandID }!

        // Reopening New definition sheet MUST NOT wipe pendingCreate!
        await MainActor.run { listStore.openCreateSheet() }
        expect(await MainActor.run { listStore.pendingCreate?.commandID == pendingCreateID && listStore.hasUnknownPendingCreate }, "Reopening New definition must preserve pending unknown create")

        // Attempting a DIFFERENT create payload while unknown outcome is pending MUST be blocked locally (0 network calls)!
        let cmdsBeforeDiffCreate = try await recordedCommands(origin).count
        let diffCreateBlocked = await listStore.createDefinition(term: "Different Term", meaning: "Other", source: "", api: defsAPI)
        let cmdsAfterDiffCreate = try await recordedCommands(origin).count
        expect(diffCreateBlocked == nil && cmdsBeforeDiffCreate == cmdsAfterDiffCreate, "Different payload while unknown create pending must send ZERO requests")

        // Pre-receipt refusal on retry (production-shaped 403 {"error":"forbidden"}) retires access AND preserves unknown outcome!
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-403?on=1")!)
        let refusedCreateRetry = await listStore.createDefinition(term: "Gross Margin", meaning: "Revenue minus COGS.", source: "finance.gl", api: defsAPI)
        expect(refusedCreateRetry == nil, "403 refused retry must return nil")
        let createAfter403 = await MainActor.run {
            (listStore.definitions.isEmpty, listStore.access == nil, !listStore.showingCreateSheet, listStore.pendingCreate?.commandID == pendingCreateID, listStore.createError ?? "")
        }
        expect(createAfter403.0 && createAfter403.1 && createAfter403.2, "Production-shaped 403 must retire list, access, and open create sheet")
        expect(createAfter403.3 && createAfter403.4.contains("unknown"), "403 refusal on retry must preserve pendingCreate and unknown-outcome warning")

        // Restore access and run authorized read -> reconciles the committed Gross Margin with AT MOST ONE mutation!
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-403?on=0")!)
        await listStore.load(api: defsAPI)
        let afterReconcile = await MainActor.run {
            (listStore.definitions.contains { $0.objectID == "def-gross-margin" }, listStore.pendingCreate == nil, listStore.statusMessage ?? "")
        }
        expect(afterReconcile.0 && afterReconcile.1 && afterReconcile.2.contains("already saved"), "Authorized read must reconcile previously committed create")
        expect(try await mutationCount(origin) == mutsAfterCreate503, "Reconciliation must execute ZERO additional server writes")

        // 5. HezSec C1 Witness A: Production-shaped 403 {"error":"forbidden"}, 401 {"message":"JWT expired"}, 404 {"error":"not_found"} retire list, detail, and open editors!
        await detailStore.load(api: defsAPI)
        let openEditorBefore403 = await MainActor.run { detailStore.beginEdit() }
        expect(openEditorBefore403 != nil, "Editor should open before 403")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-403?on=1")!)
        await detailStore.load(api: defsAPI)
        let detailAfterEdge403 = await MainActor.run {
            detailStore.detail == nil && detailStore.access == nil && detailStore.activeEditSession == nil && detailStore.accessError != nil
        }
        expect(detailAfterEdge403, "Production-shaped HTTP 403 {\"error\":\"forbidden\"} must wipe detail, access, and close open editor")

        // Attempting write after editor retired sends ZERO network calls
        let cmdsBeforeRetiredWrite = try await recordedCommands(origin).count
        let retiredWrite = await detailStore.update(session: openEditorBefore403!, term: "ARR", meaning: "Blocked", source: "", api: defsAPI)
        let cmdsAfterRetiredWrite = try await recordedCommands(origin).count
        expect(!retiredWrite && cmdsAfterRetiredWrite == cmdsBeforeRetiredWrite, "Retired editor must send ZERO writes")

        // Production-shaped HTTP 401 retires list & detail
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-403?on=0")!)
        await listStore.load(api: defsAPI)
        await MainActor.run { listStore.openCreateSheet() }
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-401?on=1")!)
        await listStore.load(api: defsAPI)
        let listAfterEdge401 = await MainActor.run {
            listStore.definitions.isEmpty && listStore.access == nil && !listStore.showingCreateSheet && (listStore.accessError ?? "").contains("Sign in")
        }
        expect(listAfterEdge401, "Production-shaped HTTP 401 must retire list, access, and open create sheet")

        // Production-shaped HTTP 404 retires detail & open editor
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-401?on=0")!)
        await detailStore.load(api: defsAPI)
        _ = await MainActor.run { detailStore.beginEdit() }
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-404?on=1")!)
        await detailStore.load(api: defsAPI)
        let detailAfterEdge404 = await MainActor.run {
            detailStore.detail == nil && detailStore.activeEditSession == nil && detailStore.accessError != nil
        }
        expect(detailAfterEdge404, "Production-shaped HTTP 404 must retire detail and open editor")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-404?on=0")!)

        // 6. HezSec C1 Witness B: Held pre-refusal 200 list across a newer production-shaped 403 refusal stays retired!
        await listStore.load(api: defsAPI)
        try await postFixture(origin.appending(path: "fixture/hold-next-list"))
        let heldLoadTask = Task { await listStore.load(api: defsAPI) }
        expect(try await waitForHeldList(origin), "Expected definitions list load to be held")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-403?on=1")!)
        await listStore.load(api: defsAPI) // newer load observes production-shaped 403 {"error":"forbidden"}
        try await postFixture(origin.appending(path: "fixture/release-held-list"))
        await heldLoadTask.value
        let listAfterHeldRace = await MainActor.run { listStore.definitions.isEmpty && listStore.access == nil && listStore.accessError != nil && !listStore.isLoading }
        expect(listAfterHeldRace, "Held pre-refusal list response released after newer 403 must NOT restore definitions or access")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-403?on=0")!)

        // 7. HezSec C1 Witness C: Reader downgrade keeps readable content, closes open editor, and sends ZERO writes!
        await listStore.load(api: defsAPI)
        await detailStore.load(api: defsAPI)
        let editorBeforeDowngrade = await MainActor.run { detailStore.beginEdit() }!
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/role?role=reader")!)
        let downgradedSave = await detailStore.update(session: editorBeforeDowngrade, term: "ARR", meaning: "Downgraded", source: "", api: defsAPI)
        expect(!downgradedSave, "Reader downgrade must refuse write")
        let afterDowngrade = await MainActor.run {
            detailStore.detail != nil && !detailStore.canEdit && detailStore.activeEditSession == nil
        }
        expect(afterDowngrade, "Reader downgrade must keep readable detail while closing editor and retiring write controls")
        let cmdsBeforeReaderAttempts = try await recordedCommands(origin).count
        let readerUpdate = await detailStore.update(session: editorBeforeDowngrade, term: "ARR", meaning: "Blocked", source: "", api: defsAPI)
        let readerCertify = await detailStore.certify(api: defsAPI)
        await listStore.load(api: defsAPI)
        let readerCreate = await listStore.createDefinition(term: "Blocked", meaning: "Blocked", source: "", api: defsAPI)
        let cmdsAfterReaderAttempts = try await recordedCommands(origin).count
        expect(!readerUpdate && !readerCertify && readerCreate == nil && cmdsBeforeReaderAttempts == cmdsAfterReaderAttempts, "Reader must send ZERO create/update/certify requests")

        // Unsupported fallback still works
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/unsupported?on=1")!)
        await listStore.load(api: defsAPI)
        expect(await MainActor.run { listStore.isUnsupported && listStore.definitions.isEmpty }, "unknown_tool must surface unsupported cleanly")

        print("PASS: VerifyDefinitions (C1 prod 401/403/404 retirement + held-list-across-403 + reader downgrade zero-send, C2 frozen edit session prevents stale rebase, C3 committed-but-unacknowledged 503 + pre-receipt refusal preserves unknown outcome & commandID with at-most-one write)")
    }
}
