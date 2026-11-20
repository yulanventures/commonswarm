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
    }

    static func recordedCommands(_ origin: URL) async throws -> [RecordedCommand] {
        let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/commands"))
        return try JSONDecoder().decode([RecordedCommand].self, from: data)
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

        // 1. Load list: 3 definitions with Certified, Proposal pending, Proposed statuses
        let listStore = await MainActor.run { DefinitionsListStore(workspaceID: ws.id) }
        await listStore.load(api: defsAPI)
        let items = await MainActor.run { listStore.definitions }
        expect(items.count == 3, "Expected 3 seeded definitions, got \(items.count)")
        let arr = items.first { $0.objectID == "def-arr" }!
        let nrr = items.first { $0.objectID == "def-nrr" }!
        let act = items.first { $0.objectID == "def-activation-window" }!
        expect(arr.status == .proposalPending, "ARR should be proposalPending")
        expect(nrr.status == .certified, "NRR should be certified")
        expect(act.status == .proposed, "Activation window should be proposed")

        // Search filtering
        await MainActor.run { listStore.searchQuery = "ret" }
        let filteredNone = await MainActor.run { listStore.filteredDefinitions }
        expect(filteredNone.isEmpty, "Search filters by term only")
        await MainActor.run { listStore.searchQuery = "arr" }
        let filteredARR = await MainActor.run { listStore.filteredDefinitions }
        expect(filteredARR.count == 1 && filteredARR[0].objectID == "def-arr", "Case-insensitive term search failed")
        await MainActor.run { listStore.searchQuery = "" }

        // 2. Detail read: Proposal pending exposes certified + current + attribution + canCertify
        let detailStore = await MainActor.run { DefinitionDetailStore(workspaceID: ws.id, objectID: "def-arr") }
        await detailStore.load(api: defsAPI)
        let arrDetail = await MainActor.run { detailStore.detail }!
        expect(arrDetail.status == .proposalPending && arrDetail.proposalPending, "ARR detail should be proposalPending")
        expect(arrDetail.certified?.certifiedByLabel == "Maya Chen", "Expected Maya Chen certifier")
        expect(arrDetail.current.authorLabel.contains("Atlas") && arrDetail.current.authorIsAgent, "Expected Atlas agent attribution")
        expect(await MainActor.run { detailStore.canCertify && detailStore.canEdit }, "Editor should be able to certify & edit")

        // 3. Stale certify (definition_not_current) reloads cleanly with notice, then 503 retry reuses command_id and certifies!
        try await postFixture(origin.appending(path: "fixture/stale-next-certify"))
        let staleOK = await detailStore.certify(api: defsAPI)
        expect(!staleOK, "Stale certify should return false")
        let staleErr = await MainActor.run { detailStore.errorMessage ?? "" }
        expect(staleErr.contains("newer version"), "Expected definition_not_current notice, got \(staleErr)")

        try await postFixture(origin.appending(path: "fixture/fail-next-write"))
        let failCertOK = await detailStore.certify(api: defsAPI)
        expect(!failCertOK, "503 certify must stay unconfirmed")
        let retryCertOK = await detailStore.certify(api: defsAPI)
        expect(retryCertOK, "Retry certify must succeed")
        let cmdsAfterCert = try await recordedCommands(origin).filter { $0.kind == "household_definition_certify" }
        expect(cmdsAfterCert.count == 3 && cmdsAfterCert[1].command_id == cmdsAfterCert[2].command_id, "Certify retry must reuse exact command_id")
        let certifiedDetail = await MainActor.run { detailStore.detail }!
        expect(certifiedDetail.status == .certified && !certifiedDetail.proposalPending, "ARR should now be certified")
        expect(certifiedDetail.certified?.certifiedByLabel == "You", "Viewer certifier should label You")

        // 4. Update with conflict -> reloads cleanly; update with 503 retry reuses command_id and commits -> proposalPending!
        try await postFixture(origin.appending(path: "fixture/conflict-next-update"))
        let conflictOK = await detailStore.update(term: "ARR", meaning: "Updated meaning", source: "stripe.v3", api: defsAPI)
        expect(!conflictOK, "Conflict update must return false")
        let conflictErr = await MainActor.run { detailStore.errorMessage ?? "" }
        expect(conflictErr.contains("newer version"), "Expected conflict notice")

        try await postFixture(origin.appending(path: "fixture/fail-next-write"))
        let unconfirmedUpd = await detailStore.update(term: "ARR", meaning: "Annual recurring revenue v3", source: "stripe.v3", api: defsAPI)
        expect(!unconfirmedUpd, "503 update must stay unconfirmed")
        let retryUpd = await detailStore.update(term: "ARR", meaning: "Annual recurring revenue v3", source: "stripe.v3", api: defsAPI)
        expect(retryUpd, "Retry update must succeed")
        let updCmds = try await recordedCommands(origin).filter { $0.kind == "definition_update" }
        expect(updCmds.count == 3 && updCmds[1].command_id == updCmds[2].command_id, "Update retry must reuse exact command_id")
        let updatedDetail = await MainActor.run { detailStore.detail }!
        expect(updatedDetail.status == .proposalPending && updatedDetail.current.meaning == "Annual recurring revenue v3", "Updated definition must enter proposalPending")

        // 5. Create definition with 503 retry reuses (command_id, object_id); duplicate term returns refusal notice
        try await postFixture(origin.appending(path: "fixture/fail-next-write"))
        let failCreate = await listStore.createDefinition(term: "Gross Margin", meaning: "Revenue minus COGS divided by revenue.", source: "finance.gl", api: defsAPI)
        expect(failCreate == nil, "503 create must stay unconfirmed")
        let createdID = await listStore.createDefinition(term: "Gross Margin", meaning: "Revenue minus COGS divided by revenue.", source: "finance.gl", api: defsAPI)
        expect(createdID == "def-gross-margin", "Expected def-gross-margin, got \(createdID ?? "nil")")
        let createCmds = try await recordedCommands(origin).filter { $0.kind == "definition_create" }
        expect(createCmds.count == 2 && createCmds[0].command_id == createCmds[1].command_id && createCmds[0].object_id == createCmds[1].object_id, "Create retry must reuse command_id and object_id")
        let dupCreate = await listStore.createDefinition(term: "gross margin", meaning: "Dup", source: "", api: defsAPI)
        expect(dupCreate == nil, "Duplicate term must be refused")
        let dupErr = await MainActor.run { listStore.createError ?? "" }
        expect(dupErr.contains("already exists"), "Expected definition_term_taken notice, got \(dupErr)")

        // 6. Reader gating, access revocation, consent needed, and unsupported tool fallback
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/role?role=reader")!)
        await listStore.load(api: defsAPI)
        await detailStore.load(api: defsAPI)
        expect(await MainActor.run { !listStore.canEdit && !detailStore.canEdit && !detailStore.canCertify }, "Reader must not have edit or certify capability")

        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-refused?on=1")!)
        await listStore.load(api: defsAPI)
        await detailStore.load(api: defsAPI)
        expect(await MainActor.run { listStore.definitions.isEmpty && listStore.accessError != nil && detailStore.detail == nil && detailStore.accessError != nil }, "Access refusal must wipe list and detail fail-closed")

        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-refused?on=0")!)
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/unsupported?on=1")!)
        await listStore.load(api: defsAPI)
        expect(await MainActor.run { listStore.isUnsupported && listStore.definitions.isEmpty }, "unknown_tool must surface unsupported cleanly")

        print("PASS: VerifyDefinitions (list/search, proposal comparison, certify + stale/retry idempotency, create/update + conflict/retry idempotency, reader gating, fail-closed access revocation & unsupported fallback)")
    }
}
