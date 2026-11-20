import Foundation

@main
struct VerifyPeopleDirectory {
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
            fputs("Usage: VerifyPeopleDirectory <port>\n", stderr)
            exit(2)
        }
        let origin = URL(string: "http://127.0.0.1:\(port)")!
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
        let session = await MainActor.run {
            HumanSession(userID: tokens.userID) { tokens.accessToken }
        }
        let convAPI = ConversationAPI(origin: origin, publicKey: publicKey, session: session)
        let workspaces = try await convAPI.workspaces()
        expect(workspaces.count == 1, "Expected 1 workspace")
        let ws = workspaces[0]
        let directoryAPI = PeopleDirectoryAPI(api: convAPI)

        // 1. Full load: People (3), Agents (2), Invites (1 waiting), Admins (2 managers + 1 grant = 3)
        let store = await MainActor.run { PeopleDirectoryStore(workspaceID: ws.id) }
        expect(await MainActor.run { store.selectedTab == .agents }, "Default tab must be Agents")
        await store.load(api: directoryAPI)

        let tabs = await MainActor.run { store.tabs }
        expect(tabs.first(where: { $0.tab == .people })?.count == 3, "Expected 3 people")
        expect(tabs.first(where: { $0.tab == .agents })?.count == 2, "Expected 2 agents")
        let invitesTab = tabs.first(where: { $0.tab == .invites })!
        expect(invitesTab.count == 1 && invitesTab.accessibilityLabel == "Invites, 1 waiting", "Expected Invites, 1 waiting")
        expect(tabs.first(where: { $0.tab == .admins })?.count == 3, "Expected 3 admins (2 people + 1 agent grant)")

        let agents = await MainActor.run { store.agents }
        let atlas = agents.first { $0.name == "Atlas" }!
        let beacon = agents.first { $0.name == "Beacon" }!
        expect(atlas.isOwnedByViewer && atlas.activityStatus() == .active && atlas.hostLabel == "Local", "Expected Atlas active local owned by viewer")
        expect(!beacon.isOwnedByViewer && beacon.ownerName == "Maya Chen" && beacon.hostLabel == "Hosted MCP", "Expected Beacon hosted MCP owned by Maya Chen")

        // 2. Search filtering across tabs
        await MainActor.run { store.query = "beacon" }
        expect(await MainActor.run { store.filteredAgents.count == 1 && store.filteredAgents[0].name == "Beacon" }, "Search must filter agents")
        await MainActor.run { store.query = "maya" }
        expect(await MainActor.run { store.filteredPeople.count == 1 && store.filteredPeople[0].name == "Maya Chen" }, "Search must filter people")
        await MainActor.run { store.query = "" }

        // 3. Partial failure: Invites 503 omits Invites count (never shows 0) while People & Agents stay usable
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/fail-invites?on=1")!)
        await store.load(api: directoryAPI)
        let partialTabs = await MainActor.run { store.tabs }
        expect(partialTabs.first(where: { $0.tab == .people })?.count == 3, "People must stay loaded when Invites fails")
        expect(partialTabs.first(where: { $0.tab == .invites })?.count == nil, "Failed Invites read must keep count nil, never 0")
        expect(await MainActor.run { store.invitesFailed }, "Expected invitesFailed == true")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/fail-invites?on=0")!)

        // 4. Admins grant 503 omits Admins count while managers list still renders
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/fail-admin-grants?on=1")!)
        await store.load(api: directoryAPI)
        let adminPartialTabs = await MainActor.run { store.tabs }
        expect(adminPartialTabs.first(where: { $0.tab == .admins })?.count == nil, "Admins count must stay nil when admin grants read fails")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/fail-admin-grants?on=0")!)

        // 5. Explicit 403 access refusal clears stale roster completely
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-refused?on=1")!)
        await store.load(api: directoryAPI)
        expect(await MainActor.run { store.accessUnavailable && store.people.isEmpty && store.agents.isEmpty && store.invites.isEmpty }, "403 must clear stale roster and set accessUnavailable")

        print("PASS: VerifyPeopleDirectory (tabs + counts + a11y labels, agent presence & ownership, search, partial failure never shows false 0, 403 clears stale roster)")
    }
}
