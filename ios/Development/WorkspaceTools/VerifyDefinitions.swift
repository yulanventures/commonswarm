import Foundation

@MainActor
final class ControllableBearer {
    private let token: String
    private var holdNext = false
    private var waitingContinuation: CheckedContinuation<Void, Never>?
    private var arrivedContinuation: CheckedContinuation<Void, Never>?
    private var arrived = false

    init(token: String) {
        self.token = token
    }

    func armHold() {
        holdNext = true
        arrived = false
    }

    func waitUntilHeld() async {
        if arrived { return }
        await withCheckedContinuation { cont in
            arrivedContinuation = cont
        }
    }

    func release() {
        holdNext = false
        let cont = waitingContinuation
        waitingContinuation = nil
        cont?.resume()
    }

    func fetch() async -> String {
        if holdNext {
            holdNext = false
            arrived = true
            let waiter = arrivedContinuation
            arrivedContinuation = nil
            waiter?.resume()
            await withCheckedContinuation { cont in
                waitingContinuation = cont
            }
        }
        return token
    }
}

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

    static func waitForHeld(_ origin: URL, path: String) async throws -> Bool {
        struct HeldState: Decodable { let held: Bool }
        for _ in 0..<60 {
            let (hData, _) = try await URLSession.shared.data(from: origin.appending(path: path))
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

        // Sign in with controllable bearer for held-bearer canDispatch witnesses
        let emailAPI = EmailCodeAPI(origin: origin, publicKey: publicKey)
        try await emailAPI.send(to: "reader@example.test")
        let tokens = try await emailAPI.verify(email: "reader@example.test", code: "012345")
        let bearerGate = await MainActor.run { ControllableBearer(token: tokens.accessToken) }
        let session = await MainActor.run {
            HumanSession(userID: tokens.userID) {
                await bearerGate.fetch()
            }
        }
        // Secondary instant session (same user, non-blocked bearer) for interleaving refreshes while bearerGate is held
        let fastSession = await MainActor.run {
            HumanSession(userID: tokens.userID) { tokens.accessToken }
        }
        let convAPI = ConversationAPI(origin: origin, publicKey: publicKey, session: session)
        let workspaces = try await convAPI.workspaces()
        expect(workspaces.count == 1, "Expected 1 workspace")
        let ws = workspaces[0]
        let defsAPI = DefinitionsAPI(api: convAPI)
        let fastDefsAPI = DefinitionsAPI(api: ConversationAPI(origin: origin, publicKey: publicKey, session: fastSession))

        // 1. Load list & detail
        let listStore = await MainActor.run { DefinitionsListStore(workspaceID: ws.id) }
        await listStore.load(api: defsAPI)
        let items = await MainActor.run { listStore.definitions }
        expect(items.count == 3, "Expected 3 seeded definitions, got \(items.count)")

        let detailStore = await MainActor.run { DefinitionDetailStore(workspaceID: ws.id, objectID: "def-arr") }
        await detailStore.load(api: defsAPI)
        let arrDetail = await MainActor.run { detailStore.detail }!
        expect(arrDetail.status == .proposalPending && arrDetail.certified?.certifiedByLabel == "Maya Chen", "ARR proposalPending expected")

        // 2. HezSec C1 Held-Bearer Dispatch Witness (control + retire + editor-closed + Editor->Reader refresh)
        // 2a. Control: held bearer without retirement dispatches & commits cleanly
        let cmdsBeforeControl = try await recordedCommands(origin).count
        await MainActor.run { bearerGate.armHold() }
        let controlTask = Task {
            await listStore.createDefinition(term: "Payback Period", meaning: "Months to recover CAC.", source: "finance.cac", api: defsAPI)
        }
        await bearerGate.waitUntilHeld()
        await MainActor.run { bearerGate.release() }
        let controlCreated = await controlTask.value
        let cmdsAfterControl = try await recordedCommands(origin).count
        expect(controlCreated == "def-payback-period" && cmdsAfterControl == cmdsBeforeControl + 1, "Control held-bearer create must dispatch and commit")

        // 2b. Retire store while bearer is held -> ZERO command requests hit the wire!
        let cmdsBeforeRetiredDispatch = try await recordedCommands(origin).count
        await MainActor.run { bearerGate.armHold() }
        let retiredCreateTask = Task {
            await listStore.createDefinition(term: "Should Not Send", meaning: "Retired during bearer fetch.", source: "", api: defsAPI)
        }
        await bearerGate.waitUntilHeld()
        await MainActor.run { listStore.retire() }
        await MainActor.run { bearerGate.release() }
        let retiredCreateRes = await retiredCreateTask.value
        let cmdsAfterRetiredDispatch = try await recordedCommands(origin).count
        expect(retiredCreateRes == nil && cmdsAfterRetiredDispatch == cmdsBeforeRetiredDispatch, "Retiring store while bearer is held must send ZERO command requests")
        expect(await MainActor.run { listStore.pendingCreate == nil }, "Never-dispatched write must not leave stale pendingCreate")
        await listStore.load(api: defsAPI)

        // 2c. Close open editor while bearer is held -> ZERO command requests hit the wire!
        let editBeforeClose = await MainActor.run { detailStore.beginEdit() }!
        let cmdsBeforeClosedEdit = try await recordedCommands(origin).count
        await MainActor.run { bearerGate.armHold() }
        let closedEditTask = Task {
            await detailStore.update(session: editBeforeClose, term: "ARR", meaning: "Closed mid-bearer", source: "", api: defsAPI)
        }
        await bearerGate.waitUntilHeld()
        await MainActor.run { detailStore.activeEditSession = nil }
        await MainActor.run { bearerGate.release() }
        let closedEditRes = await closedEditTask.value
        let cmdsAfterClosedEdit = try await recordedCommands(origin).count
        expect(!closedEditRes && cmdsAfterClosedEdit == cmdsBeforeClosedEdit, "Closing editor while bearer is held must send ZERO command requests")

        // 2d. Successful Editor -> Reader refresh advances write fence while bearer is held -> ZERO command requests!
        let readerRaceStore = await MainActor.run { DefinitionDetailStore(workspaceID: ws.id, objectID: "def-arr") }
        let dualBearer = await MainActor.run { ControllableBearer(token: tokens.accessToken) }
        let readerRaceSession = await MainActor.run {
            HumanSession(userID: tokens.userID) { await dualBearer.fetch() }
        }
        let readerRaceAPI = DefinitionsAPI(api: ConversationAPI(origin: origin, publicKey: publicKey, session: readerRaceSession))
        await readerRaceStore.load(api: readerRaceAPI)
        let cmdsBeforeReaderRefreshRace = try await recordedCommands(origin).count
        await MainActor.run { dualBearer.armHold() }
        let heldCertForReaderRace = Task { await readerRaceStore.certify(api: readerRaceAPI) }
        await dualBearer.waitUntilHeld()
        // While certify is waiting on bearer, refresh access as Reader (without blocking bearer!)
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/role?role=reader")!)
        await readerRaceStore.load(api: readerRaceAPI)
        await MainActor.run { dualBearer.release() }
        let certAfterReaderRefresh = await heldCertForReaderRace.value
        let cmdsAfterReaderRefreshRace = try await recordedCommands(origin).count
        expect(!certAfterReaderRefresh && cmdsAfterReaderRefreshRace == cmdsBeforeReaderRefreshRace, "Editor -> Reader refresh must advance write fence and block held certify before transport")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/role?role=editor")!)

        // 3. HezSec C2 Witness: Frozen edit session binds strictly to opened revision; conflict closes editor and stale editor sends 0 writes
        let staleSession = await MainActor.run { detailStore.beginEdit() }!
        let openedToken = staleSession.baseRevision.token
        try await postFixture(origin.appending(path: "fixture/conflict-next-update"))
        let conflictOK = await detailStore.update(session: staleSession, term: "ARR", meaning: "Stale draft", source: "stripe.v3", api: defsAPI)
        expect(!conflictOK, "Conflict update must return false")
        let afterConflict = await MainActor.run {
            (detailStore.activeEditSession == nil, detailStore.detail?.current.revision.token ?? "", detailStore.errorMessage ?? "")
        }
        expect(afterConflict.0 && afterConflict.1 != openedToken && afterConflict.2.contains("newer version"), "Conflict must close stale editor and reload newer revision")
        let cmdsBeforeStaleRetry = try await recordedCommands(origin).count
        let staleResubmitOK = await detailStore.update(session: staleSession, term: "ARR", meaning: "Stale draft", source: "stripe.v3", api: defsAPI)
        let cmdsAfterStaleRetry = try await recordedCommands(origin).count
        expect(!staleResubmitOK && cmdsBeforeStaleRetry == cmdsAfterStaleRetry, "Stale editor session must send ZERO network requests")

        // 4. HezSec C3 Witness 1 (Update): Held first write across a newer refusal before 503 response arrives ->
        //    outcomeUnknown was recorded BEFORE transport, so stale settlement drop preserves commandID, blocks different payload,
        //    inconclusive detail read preserves pending, and retryPendingUpdate replays receipt with AT MOST ONE write!
        let freshEditForHold = await MainActor.run { detailStore.beginEdit() }!
        let mutsBeforeHeldUpdate = try await mutationCount(origin)
        try await postFixture(origin.appending(path: "fixture/hold-next-write"))
        try await postFixture(origin.appending(path: "fixture/commit-then-503"))
        let heldFirstUpdateTask = Task {
            await detailStore.update(session: freshEditForHold, term: "ARR", meaning: "Committed ARR v4", source: "stripe.v4", api: defsAPI)
        }
        expect(try await waitForHeld(origin, path: "fixture/write-held"), "Expected first update write to be held on server after dispatch")
        let heldUpdateCmdID = await MainActor.run { detailStore.pendingUpdate?.commandID }!
        expect(await MainActor.run { detailStore.hasUnknownPendingUpdate }, "outcomeUnknown must already be true as soon as write entered transport")

        // Newer 403 refusal wins while first write is still held!
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-403?on=1")!)
        await detailStore.load(api: defsAPI)
        try await postFixture(origin.appending(path: "fixture/release-held-write"))
        _ = await heldFirstUpdateTask.value
        let mutsAfterHeldUpdate = try await mutationCount(origin)
        expect(mutsAfterHeldUpdate == mutsBeforeHeldUpdate + 1, "First update committed once on server")
        expect(await MainActor.run { detailStore.pendingUpdate?.commandID == heldUpdateCmdID && detailStore.hasUnknownPendingUpdate }, "Retired first response must NOT lose original commandID or outcomeUnknown")

        // Restore access & run generic detail read -> inconclusive read MUST NOT clear pendingUpdate!
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-403?on=0")!)
        await detailStore.load(api: defsAPI)
        expect(await MainActor.run { detailStore.pendingUpdate?.commandID == heldUpdateCmdID && detailStore.hasUnknownPendingUpdate }, "Generic detail read must NOT clear unresolved pendingUpdate")

        // Attempting a DIFFERENT edit payload while pendingUpdate is unresolved stays BLOCKED (0 requests)!
        let diffEditSession = await MainActor.run { detailStore.beginEdit() }!
        let cmdsBeforeDiffUpdate = try await recordedCommands(origin).count
        let diffUpdateRes = await detailStore.update(session: diffEditSession, term: "ARR", meaning: "Different payload", source: "", api: defsAPI)
        let cmdsAfterDiffUpdate = try await recordedCommands(origin).count
        expect(!diffUpdateRes && cmdsBeforeDiffUpdate == cmdsAfterDiffUpdate, "Different edit payload while pendingUpdate unresolved must send ZERO requests")

        // Same-login pre-receipt HTTP 401 on retry preserves pendingUpdate & commandID while retiring display state!
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-401?on=1")!)
        let retry401Update = await detailStore.retryPendingUpdate(api: defsAPI)
        expect(!retry401Update, "401 retry must return false")
        let after401Update = await MainActor.run {
            (detailStore.detail == nil, detailStore.pendingUpdate?.commandID == heldUpdateCmdID, detailStore.hasUnknownPendingUpdate, detailStore.errorMessage ?? "")
        }
        expect(after401Update.0 && after401Update.1 && after401Update.2 && after401Update.3.contains("unknown"), "Same-login 401 must retire display state while preserving pendingUpdate commandID & unknown warning")

        // Restore token -> reload -> retryPendingUpdate hits receipt lookup with exact same commandID -> ZERO duplicate writes!
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-401?on=0")!)
        await detailStore.load(api: defsAPI)
        let replayedUpdate = await detailStore.retryPendingUpdate(api: defsAPI)
        expect(replayedUpdate, "Authorized retryPendingUpdate must confirm committed receipt")
        expect(try await mutationCount(origin) == mutsAfterHeldUpdate, "Update replay must execute AT MOST ONE write on server")
        expect(await MainActor.run { detailStore.pendingUpdate == nil }, "Confirmed receipt clears pendingUpdate")
        let updCmdsForID = try await recordedCommands(origin).filter { $0.command_id == heldUpdateCmdID.uuidString.lowercased() }
        expect(updCmdsForID.count == 2, "Expected original + final replay with exact same command_id (401 blocked at edge before recorder)")

        // 5. HezSec C3 Witness 2 (Certify): committed-then-503 -> same-login 401 -> inconclusive read -> pre-receipt rate_limited -> receipt replay (AT MOST ONE write)!
        let mutsBeforeCert = try await mutationCount(origin)
        try await postFixture(origin.appending(path: "fixture/commit-then-503"))
        let unconfirmedCert = await detailStore.certify(api: defsAPI)
        expect(!unconfirmedCert, "Committed-then-503 certify must surface unconfirmed")
        let mutsAfterCert503 = try await mutationCount(origin)
        expect(mutsAfterCert503 == mutsBeforeCert + 1, "Certify committed once on server")
        let certCmdID = await MainActor.run { detailStore.pendingCertify?.commandID }!

        // Same-login 401 preserves pendingCertify
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-401?on=1")!)
        let cert401 = await detailStore.certify(api: defsAPI)
        expect(!cert401, "401 certify retry must fail")
        expect(await MainActor.run { detailStore.detail == nil && detailStore.pendingCertify?.commandID == certCmdID && detailStore.hasUnknownPendingCertify }, "Same-login 401 must preserve pendingCertify")

        // Restore & inconclusive detail read MUST NOT clear pendingCertify
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-401?on=0")!)
        await detailStore.load(api: defsAPI)
        expect(await MainActor.run { detailStore.pendingCertify?.commandID == certCmdID && detailStore.hasUnknownPendingCertify }, "Detail read must NOT clear unresolved pendingCertify")

        // Pre-receipt rate_limited refusal preserves pendingCertify
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/pre-receipt-refusal?reason=rate_limited")!)
        let certRateLimited = await detailStore.retryPendingCertify(api: defsAPI)
        let certStillPending = await MainActor.run { detailStore.pendingCertify?.commandID == certCmdID && detailStore.hasUnknownPendingCertify }
        expect(!certRateLimited && certStillPending, "rate_limited refusal must preserve pendingCertify")

        // Definite receipt replay confirms certify with AT MOST ONE write!
        let certReplayed = await detailStore.retryPendingCertify(api: defsAPI)
        let certCleared = await MainActor.run { detailStore.pendingCertify == nil }
        expect(certReplayed && certCleared, "Receipt replay must confirm & clear pendingCertify")
        expect(try await mutationCount(origin) == mutsAfterCert503, "Certify replay must execute AT MOST ONE write on server")

        // 6. HezSec C3 Witness 3 (Create): committed-then-503 -> reopen New sheet -> inconclusive bounded search omitting target ->
        //    same-login 401 -> different payload blocked -> unchanged retry replays receipt with AT MOST ONE write!
        let mutsBeforeCreate = try await mutationCount(origin)
        try await postFixture(origin.appending(path: "fixture/commit-then-503"))
        let unconfirmedCreate = await listStore.createDefinition(term: "Gross Margin", meaning: "Revenue minus COGS.", source: "finance.gl", api: defsAPI)
        expect(unconfirmedCreate == nil, "Committed-then-503 create must surface unconfirmed")
        let mutsAfterCreate503 = try await mutationCount(origin)
        expect(mutsAfterCreate503 == mutsBeforeCreate + 1, "Create committed once on server")
        let createCmdID = await MainActor.run { listStore.pendingCreate?.commandID }!

        // Reopening New sheet preserves pendingCreate
        await MainActor.run { listStore.openCreateSheet() }
        expect(await MainActor.run { listStore.pendingCreate?.commandID == createCmdID && listStore.hasUnknownPendingCreate }, "Reopening New sheet must preserve pendingCreate")

        // Inconclusive bounded search (omitting created item, then including it) MUST NOT clear pendingCreate!
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/omit-in-search?object_id=def-gross-margin")!)
        await listStore.load(api: defsAPI)
        expect(await MainActor.run { listStore.pendingCreate?.commandID == createCmdID && listStore.hasUnknownPendingCreate }, "Omitted-item list read must NOT clear pendingCreate")
        await listStore.load(api: defsAPI)
        expect(await MainActor.run { listStore.pendingCreate?.commandID == createCmdID && listStore.hasUnknownPendingCreate }, "Even matching list read must NOT clear unresolved pendingCreate before receipt lookup")

        // Same-login 401 preserves pendingCreate while retiring list
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-401?on=1")!)
        let create401 = await listStore.retryPendingCreate(api: defsAPI)
        expect(create401 == nil, "401 create retry must return nil")
        expect(await MainActor.run { listStore.definitions.isEmpty && listStore.pendingCreate?.commandID == createCmdID && listStore.hasUnknownPendingCreate }, "Same-login 401 must retire list while preserving pendingCreate")

        // Restore access -> different create payload stays blocked -> unchanged retry hits receipt lookup with exact same commandID!
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-401?on=0")!)
        await listStore.load(api: defsAPI)
        let cmdsBeforeDiffCreate = try await recordedCommands(origin).count
        let diffCreate = await listStore.createDefinition(term: "Other Term", meaning: "Other", source: "", api: defsAPI)
        let cmdsAfterDiffCreate = try await recordedCommands(origin).count
        expect(diffCreate == nil && cmdsBeforeDiffCreate == cmdsAfterDiffCreate, "Different create payload while pendingCreate unresolved must send ZERO requests")

        let replayedCreate = await listStore.retryPendingCreate(api: defsAPI)
        let createCleared = await MainActor.run { listStore.pendingCreate == nil }
        expect(replayedCreate == "def-gross-margin" && createCleared, "Create receipt replay must confirm & clear pendingCreate")
        expect(try await mutationCount(origin) == mutsAfterCreate503, "Create replay must execute AT MOST ONE write on server")

        // 7. HezSec C1 Witness: Held pre-refusal 200 list across newer 403 stays retired + 404 retirement + sign-out clears pending!
        try await postFixture(origin.appending(path: "fixture/hold-next-list"))
        let heldLoadTask = Task { await listStore.load(api: defsAPI) }
        expect(try await waitForHeld(origin, path: "fixture/list-held"), "Expected list load to be held")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-403?on=1")!)
        await listStore.load(api: defsAPI)
        try await postFixture(origin.appending(path: "fixture/release-held-list"))
        await heldLoadTask.value
        expect(await MainActor.run { listStore.definitions.isEmpty && listStore.access == nil && listStore.accessError != nil }, "Held list released after 403 must stay retired")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/edge-403?on=0")!)

        // Actual sign-out clears unresolved intent cleanly
        await listStore.load(api: defsAPI)
        try await postFixture(origin.appending(path: "fixture/commit-then-503"))
        _ = await listStore.createDefinition(term: "Sign Out Term", meaning: "Cleared on real sign-out.", source: "", api: defsAPI)
        expect(await MainActor.run { listStore.hasUnknownPendingCreate }, "Pending create should be tracked before sign-out")
        await MainActor.run { session.signOut() }
        await listStore.load(api: defsAPI)
        expect(await MainActor.run { listStore.pendingCreate == nil && listStore.definitions.isEmpty }, "Actual sign-out must clear unresolved intent and content")

        // Unsupported fallback still works via active fastSession
        let unsupStore = await MainActor.run { DefinitionsListStore(workspaceID: ws.id) }
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/unsupported?on=1")!)
        await unsupStore.load(api: fastDefsAPI)
        expect(await MainActor.run { unsupStore.isUnsupported && unsupStore.definitions.isEmpty }, "unknown_tool must surface unsupported cleanly")

        print("PASS: VerifyDefinitions (C1 canDispatch held-bearer zero-send across retire/editor-close/Editor->Reader + prod 401/403/404 + held-list, C2 frozen edit session, C3 held-write-across-refusal + same-login 401 + inconclusive-read preservation + definite receipt replay with at-most-one write + sign-out cleanup)")
    }
}
