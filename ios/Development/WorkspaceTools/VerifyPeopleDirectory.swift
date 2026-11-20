import Foundation

@MainActor
final class ControllableBearer {
    private let token: String
    private var holding = false
    private var waitForHold: CheckedContinuation<Void, Never>?
    private var releaseHolds: [CheckedContinuation<Void, Never>] = []
    private(set) var isHeld = false

    init(token: String) {
        self.token = token
    }

    func holdAll() {
        holding = true
    }

    func nextToken() async -> String {
        if holding {
            isHeld = true
            waitForHold?.resume()
            waitForHold = nil
            await withCheckedContinuation { cont in
                releaseHolds.append(cont)
            }
        }
        return token
    }

    func waitUntilHeld() async {
        if isHeld { return }
        await withCheckedContinuation { cont in
            waitForHold = cont
        }
    }

    func releaseAll() {
        holding = false
        isHeld = false
        let waiting = releaseHolds
        releaseHolds.removeAll()
        for cont in waiting {
            cont.resume()
        }
    }
}

@main
struct VerifyPeopleDirectory {
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

    struct RequestCount: Decodable {
        let reads: Int
    }

    static func readCount(_ origin: URL) async throws -> Int {
        let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/requests"))
        return try JSONDecoder().decode(RequestCount.self, from: data).reads
    }

    static func main() async throws {
        guard CommandLine.arguments.count >= 2, let port = Int(CommandLine.arguments[1]) else {
            fputs("Usage: VerifyPeopleDirectory <port>\n", stderr)
            exit(2)
        }
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let base = origin.absoluteString
        let publicKey = "local-fixture"

        // 0. Tab rules: never report 0 when read is pending or failed
        let pendingTabs = PeopleDirectoryRules.tabSummaries(
            selected: .agents,
            peopleCount: 0,
            agentsCount: 0,
            invitesCount: 0,
            managersCount: 0,
            adminGrantsCount: 0,
            coreReady: false,
            invitesReady: false,
            adminGrantsReady: false
        )
        expect(pendingTabs.allSatisfy { $0.count == nil }, "Pending reads must keep tab counts nil, never 0")

        let emailAPI = EmailCodeAPI(origin: origin, publicKey: publicKey)
        try await emailAPI.send(to: "reader@example.test")
        let tokens = try await emailAPI.verify(email: "reader@example.test", code: "012345")
        let bearer = await MainActor.run { ControllableBearer(token: tokens.accessToken) }
        let session = await MainActor.run {
            HumanSession(userID: tokens.userID) { await bearer.nextToken() }
        }
        let convAPI = ConversationAPI(origin: origin, publicKey: publicKey, session: session)
        let workspaces = try await convAPI.workspaces()
        expect(workspaces.count == 1, "Expected 1 workspace")
        let ws = workspaces[0]
        let directoryAPI = PeopleDirectoryAPI(api: convAPI)

        // 1. Full load via production POST rest/v1/rpc/workspace_seat_admin_grants (owner shape: { grants: [...] })
        let store = await MainActor.run { PeopleDirectoryStore(workspaceID: ws.id) }
        let defaultTabIsAgents = await MainActor.run { store.selectedTab == .agents }
        expect(defaultTabIsAgents, "Default tab must be Agents")
        await store.load(api: directoryAPI)

        let tabs = await MainActor.run { store.tabs }
        expect(tabs.first(where: { $0.tab == .people })?.count == 3, "Expected 3 people")
        expect(tabs.first(where: { $0.tab == .agents })?.count == 2, "Expected 2 agents")
        let invitesTab = tabs.first(where: { $0.tab == .invites })!
        expect(invitesTab.count == 1 && invitesTab.accessibilityLabel == "Invites, 1 waiting", "Expected Invites, 1 waiting")
        expect(tabs.first(where: { $0.tab == .admins })?.count == 3, "Expected 3 admins (2 people + 1 agent grant via RPC)")

        let grant = await MainActor.run { store.adminGrants.first }!
        expect(
            grant.agentName == "Atlas" && grant.level == "scoped" && grant.levelLabel == "Scoped admin" && grant.ownerDisplay == "Alex Rivera" && grant.mayEnd,
            "Admin grant must decode real RPC shape (agent_name, owner_display, level, may_end)"
        )

        let agents = await MainActor.run { store.agents }
        let atlas = agents.first { $0.name == "Atlas" }!
        let beacon = agents.first { $0.name == "Beacon" }!
        expect(atlas.isOwnedByViewer && atlas.activityStatus() == .active && atlas.hostLabel == "Local", "Expected Atlas active local owned by viewer")
        expect(!beacon.isOwnedByViewer && beacon.ownerName == "Maya Chen" && beacon.hostLabel == "Hosted MCP", "Expected Beacon hosted MCP owned by Maya Chen")

        // 2. Non-owner RPC returning JSON null must still complete Admins cleanly (count == 2 managers, grants == [])
        try await postFixture("\(base)/fixture/non-owner-grants?on=1")
        await store.load(api: directoryAPI)
        let nonOwnerOK = await MainActor.run {
            store.adminGrantsReady && store.adminGrants.isEmpty && store.tabs.first(where: { $0.tab == .admins })?.count == 2
        }
        expect(nonOwnerOK, "Non-owner RPC returning null must yield adminGrantsReady == true with human managers count (2)")
        try await postFixture("\(base)/fixture/non-owner-grants?on=0")

        // 3. Duplicate user_id / principal_id rows must NOT crash (Dictionary uniquingKeysWith:)
        try await postFixture("\(base)/fixture/duplicate-rows?on=1")
        await store.load(api: directoryAPI)
        let dupReady = await MainActor.run { store.coreReady && !store.people.isEmpty && !store.agents.isEmpty }
        expect(dupReady, "Duplicate member/agent/presence rows must decode safely without trapping")
        try await postFixture("\(base)/fixture/duplicate-rows?on=0")
        await store.load(api: directoryAPI)

        // 4. Search filtering across tabs
        await MainActor.run { store.query = "beacon" }
        let filteredAgentsOK = await MainActor.run { store.filteredAgents.count == 1 && store.filteredAgents[0].name == "Beacon" }
        expect(filteredAgentsOK, "Search must filter agents")
        await MainActor.run { store.query = "scoped" }
        let filteredGrantsOK = await MainActor.run { store.filteredAdminGrants.count == 1 && store.filteredAdminGrants[0].agentName == "Atlas" }
        expect(filteredGrantsOK, "Search must filter admin grants by level/agent/giver")
        await MainActor.run { store.query = "" }

        // 5. Partial failure: Invites 503 omits Invites count (never shows 0) while People & Agents stay usable
        try await postFixture("\(base)/fixture/fail-invites?on=1")
        await store.load(api: directoryAPI)
        let partialTabs = await MainActor.run { store.tabs }
        let invitesFailedNow = await MainActor.run { store.invitesFailed }
        expect(partialTabs.first(where: { $0.tab == .people })?.count == 3, "People must stay loaded when Invites fails")
        expect(partialTabs.first(where: { $0.tab == .invites })?.count == nil && invitesFailedNow, "Failed Invites read must keep count nil, never 0")
        try await postFixture("\(base)/fixture/fail-invites?on=0")

        // 6. Admins RPC 503 omits Admins count while managers list still renders
        try await postFixture("\(base)/fixture/fail-admin-grants?on=1")
        await store.load(api: directoryAPI)
        let adminPartialTabs = await MainActor.run { store.tabs }
        expect(adminPartialTabs.first(where: { $0.tab == .admins })?.count == nil, "Admins count must stay nil when admin grants RPC fails")
        try await postFixture("\(base)/fixture/fail-admin-grants?on=0")
        await store.load(api: directoryAPI)

        // 7. C1 lifecycle & held-bearer canDispatch zero-send witness
        let readsBeforeRetired = try await readCount(origin)
        await MainActor.run { store.retire() }
        await store.load(api: directoryAPI)
        let readsAfterRetired = try await readCount(origin)
        expect(readsBeforeRetired == readsAfterRetired, "Already-retired store must send ZERO network requests")

        await MainActor.run {
            store.activate()
            bearer.holdAll()
        }
        let readsBeforeHeld = try await readCount(origin)
        let heldTask = Task { await store.load(api: directoryAPI) }
        await bearer.waitUntilHeld()
        await MainActor.run {
            store.retire()
            bearer.releaseAll()
        }
        await heldTask.value
        let readsAfterHeld = try await readCount(origin)
        expect(readsBeforeHeld == readsAfterHeld, "Retiring store while bearer is held must cancel via canDispatch with ZERO network requests")
        await MainActor.run { store.activate() }
        await store.load(api: directoryAPI)
        let restoredAfterActivate = await MainActor.run { store.coreReady && store.people.count == 3 }
        expect(restoredAfterActivate, "activate() must restore clean directory loading")

        // 8. C1 access-loss retirement on 401, 404, and 403 clears stale roster completely
        try await postFixture("\(base)/fixture/edge-401?on=1")
        await store.load(api: directoryAPI)
        let cleared401 = await MainActor.run { store.accessUnavailable && store.people.isEmpty && store.agents.isEmpty && store.invites.isEmpty && store.adminGrants.isEmpty }
        expect(cleared401, "401 must clear stale roster and set accessUnavailable")
        try await postFixture("\(base)/fixture/edge-401?on=0")
        await store.load(api: directoryAPI)

        try await postFixture("\(base)/fixture/edge-404?on=1")
        await store.load(api: directoryAPI)
        let cleared404 = await MainActor.run { store.accessUnavailable && store.people.isEmpty && store.agents.isEmpty && store.invites.isEmpty && store.adminGrants.isEmpty }
        expect(cleared404, "404 must clear stale roster and set accessUnavailable")
        try await postFixture("\(base)/fixture/edge-404?on=0")
        await store.load(api: directoryAPI)

        try await postFixture("\(base)/fixture/access-refused?on=1")
        await store.load(api: directoryAPI)
        let cleared403 = await MainActor.run { store.accessUnavailable && store.people.isEmpty && store.agents.isEmpty && store.invites.isEmpty && store.adminGrants.isEmpty }
        expect(cleared403, "403 must clear stale roster and set accessUnavailable")
        try await postFixture("\(base)/fixture/access-refused?on=0")

        // 9. Mixed read outcome precedence: member_profiles 503 + invites/grants 403 must
        //    NOT take generic error path or retain stale privileged rows (invites & owner grants).
        await MainActor.run { store.enterList() }
        await store.load(api: directoryAPI)
        let hadPrivilegedBeforeMixed = await MainActor.run {
            store.coreReady && store.invites.count == 1 && store.adminGrants.count == 1 && !store.accessUnavailable
        }
        expect(hadPrivilegedBeforeMixed, "Expected populated invite email and owner grant before mixed-outcome witness")

        // 9a. members 503 + invites 403
        try await postFixture("\(base)/fixture/fail-members?on=1")
        try await postFixture("\(base)/fixture/refuse-invites?on=1")
        await store.load(api: directoryAPI)
        let clearedOnMembers503Invites403 = await MainActor.run {
            store.accessUnavailable
                && !store.loadFailed
                && store.people.isEmpty
                && store.agents.isEmpty
                && store.invites.isEmpty
                && store.adminGrants.isEmpty
        }
        expect(clearedOnMembers503Invites403, "Core 503 + invites 403 must refuse and clear stale invite emails and owner grants")
        try await postFixture("\(base)/fixture/fail-members?on=0")
        try await postFixture("\(base)/fixture/refuse-invites?on=0")

        // 9b. members 503 + admin grants RPC 403
        await store.load(api: directoryAPI)
        let reloadedBeforeGrants403 = await MainActor.run { store.invites.count == 1 && store.adminGrants.count == 1 }
        expect(reloadedBeforeGrants403, "Expected reloaded privileged rows before grants 403 witness")
        try await postFixture("\(base)/fixture/fail-members?on=1")
        try await postFixture("\(base)/fixture/refuse-admin-grants?on=1")
        await store.load(api: directoryAPI)
        let clearedOnMembers503Grants403 = await MainActor.run {
            store.accessUnavailable
                && !store.loadFailed
                && store.people.isEmpty
                && store.agents.isEmpty
                && store.invites.isEmpty
                && store.adminGrants.isEmpty
        }
        expect(clearedOnMembers503Grants403, "Core 503 + admin grants 403 must refuse and clear stale privileged rows")
        try await postFixture("\(base)/fixture/fail-members?on=0")
        try await postFixture("\(base)/fixture/refuse-admin-grants?on=0")

        // 10. Detail routes bound to authorized directory IDs:
        //     live-member control, omission clearing, and opening detail across a held refusal.
        await store.load(api: directoryAPI)
        let mayaID = await MainActor.run { store.people.first(where: { $0.name == "Maya Chen" })!.userID }
        let beaconID = await MainActor.run { store.agents.first(where: { $0.name == "Beacon" })!.principalID }
        let routePerson = PeopleDetailDestination.person(mayaID)
        let routeAgent = PeopleDetailDestination.agent(beaconID)
        expect(routePerson != routeAgent, "Detail routes carry IDs, not snapshots")

        // 10a. Live-member control: pushing detail + rechecking keeps live person & agent resolved
        let controlToken = UUID()
        await MainActor.run {
            store.enterDetail(controlToken)
            store.leaveList()
        }
        await store.load(api: directoryAPI)
        let liveControlOK = await MainActor.run {
            !store.accessUnavailable
                && store.authorizedPerson(id: mayaID)?.name == "Maya Chen"
                && store.authorizedAgent(id: beaconID)?.name == "Beacon"
                && store.agentsOwned(by: mayaID).count == 1
        }
        expect(liveControlOK, "Live-member control: detail route must stay resolved after detail recheck")

        // 10b. Omission witness: if Maya / Beacon disappear from refreshed roster, detail clears immediately
        try await postFixture("\(base)/fixture/omit-maya?on=1")
        await store.load(api: directoryAPI)
        let omittedClearedOK = await MainActor.run {
            !store.accessUnavailable
                && store.authorizedPerson(id: mayaID) == nil
                && store.authorizedAgent(id: beaconID) == nil
                && store.agentsOwned(by: mayaID).isEmpty
                && store.authorizedPerson(id: tokens.userID)?.name == "Alex Rivera"
        }
        expect(omittedClearedOK, "Omitted person/agent must clear detail resolution immediately while remaining rows stay authorized")
        try await postFixture("\(base)/fixture/omit-maya?on=0")
        await MainActor.run {
            store.enterList()
            store.leaveDetail(controlToken)
        }
        await store.load(api: directoryAPI)

        // 10c. Held refusal across detail push (ordering 1: enterDetail before leaveList)
        try await postFixture("\(base)/fixture/access-refused?on=1")
        await MainActor.run { bearer.holdAll() }
        let heldRefusalTask1 = Task { await store.load(api: directoryAPI) }
        await bearer.waitUntilHeld()
        let detailToken1 = UUID()
        await MainActor.run {
            store.enterDetail(detailToken1)
            store.leaveList()
            bearer.releaseAll()
        }
        await heldRefusalTask1.value
        let clearedAcrossHeldPush1 = await MainActor.run {
            store.accessUnavailable
                && store.authorizedPerson(id: mayaID) == nil
                && store.authorizedAgent(id: beaconID) == nil
                && store.agentsOwned(by: mayaID).isEmpty
        }
        expect(clearedAcrossHeldPush1, "Pushing detail across a held list refusal must NOT drop the refusal or keep stale detail rows")
        await MainActor.run { store.leaveDetail(detailToken1) }

        // 10d. Held refusal across detail push (ordering 2: leaveList retires list refresh, then detail .task rechecks)
        try await postFixture("\(base)/fixture/access-refused?on=0")
        await MainActor.run { store.enterList() }
        await store.load(api: directoryAPI)
        try await postFixture("\(base)/fixture/access-refused?on=1")
        await MainActor.run { bearer.holdAll() }
        let heldRefusalTask2 = Task { await store.load(api: directoryAPI) }
        await bearer.waitUntilHeld()
        await MainActor.run {
            store.leaveList()
            bearer.releaseAll()
        }
        await heldRefusalTask2.value
        let detailToken2 = UUID()
        await MainActor.run { store.enterDetail(detailToken2) }
        await store.load(api: directoryAPI)
        let clearedAcrossHeldPush2 = await MainActor.run {
            store.accessUnavailable
                && store.authorizedPerson(id: mayaID) == nil
                && store.authorizedAgent(id: beaconID) == nil
                && store.agentsOwned(by: mayaID).isEmpty
        }
        expect(clearedAcrossHeldPush2, "Detail recheck must clear person/agent detail even if list disappearance retired the earlier refresh")

        // Leaving detail when list is already gone must retire the store (0 sends on held bearer)
        try await postFixture("\(base)/fixture/access-refused?on=0")
        await MainActor.run { bearer.holdAll() }
        let readsBeforeLeaveAll = try await readCount(origin)
        let leaveAllTask = Task { await store.load(api: directoryAPI) }
        await bearer.waitUntilHeld()
        await MainActor.run {
            store.leaveDetail(detailToken2)
            bearer.releaseAll()
        }
        await leaveAllTask.value
        let readsAfterLeaveAll = try await readCount(origin)
        expect(readsBeforeLeaveAll == readsAfterLeaveAll, "Leaving detail with no visible list must retire store with ZERO sends")

        print("PASS: VerifyPeopleDirectory (production POST workspace_seat_admin_grants RPC owner & null non-owner, duplicate-key safety, C1 held-bearer canDispatch & retire/activate zero-send, mixed 503+403 refusal precedence, ID-bound detail routes with held-refusal/omission/live-control)")
    }
}
