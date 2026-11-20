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

    struct HeldStatus: Decodable {
        let held: Bool
    }

    static func waitUntilParallelDemotionHeld(_ origin: URL) async throws {
        for _ in 0..<200 {
            let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/parallel-demotion-held"))
            if try JSONDecoder().decode(HeldStatus.self, from: data).held {
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        expect(false, "Timed out waiting for parallel owner-RPC + members hold")
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
        let atlasSeat = atlas.seatStatus()
        let beaconSeat = beacon.seatStatus()
        expect(
            atlas.isOwnedByViewer
                && atlasSeat.kind == .working
                && atlasSeat.indicator == .dot
                && atlasSeat.line == "Working · 3 min"
                && !atlasSeat.line.contains("SECRET PRIVATE TITLE")
                && atlas.hostLabel == "Local",
            "Expected Atlas C2 status 'Working · 3 min' with live dot and zero private title leakage; got '\(atlasSeat.line)'"
        )
        expect(
            !beacon.isOwnedByViewer
                && beacon.ownerName == "Maya Chen"
                && beacon.hostLabel == "Hosted MCP"
                && beaconSeat.kind == .turnOnly
                && beaconSeat.indicator == .ring
                && beaconSeat.line == "Turn-only, checks when opened · 5 min ago",
            "Expected Beacon hosted MCP C2 status 'Turn-only, checks when opened · 5 min ago' with ring (never live dot); got '\(beaconSeat.line)'"
        )

        // 1b. C2 SeatStatusClassifier pure truth rules (fixed clock & UTC calendar)
        var utcCal = Calendar(identifier: .gregorian)
        utcCal.timeZone = TimeZone(secondsFromGMT: 0)!
        let fixedNow = PeopleDirectoryRules.parseISO8601("2026-11-20T10:50:00Z")!
        let wait1042 = PeopleDirectoryRules.parseISO8601("2026-11-20T10:42:00Z")!
        let staleWaitingStatus = SeatStatusClassifier.classify(
            transport: "local",
            turnOnly: false,
            connection: "live",
            presenceProvided: true,
            wake: SeatWakeTimestamps(watcherAt: fixedNow.addingTimeInterval(-600), channelAt: nil, listenerAt: nil, turnAt: nil),
            lastCommandAt: fixedNow.addingTimeInterval(-600),
            lastActivityAt: fixedNow.addingTimeInterval(-600),
            workingOnSince: nil,
            workingOnUntil: nil,
            doingSince: nil,
            serverWork: "idle",
            waitingSince: wait1042,
            unseenCount: 2,
            now: fixedNow,
            calendar: utcCal
        )
        expect(
            staleWaitingStatus.kind == .waiting
                && staleWaitingStatus.line == "Waiting since 10:42 · 2 unseen"
                && staleWaitingStatus.indicator == .diamond
                && staleWaitingStatus.attention
                && staleWaitingStatus.staleWaiting,
            "Stale waiting must format 'Waiting since 10:42 · 2 unseen' with diamond & attention; got '\(staleWaitingStatus.line)'"
        )

        let freshTurnOnly = SeatStatusClassifier.classify(
            transport: "hosted_mcp",
            turnOnly: true,
            connection: "live",
            presenceProvided: true,
            wake: nil,
            lastCommandAt: nil,
            lastActivityAt: nil,
            workingOnSince: nil,
            workingOnUntil: nil,
            doingSince: nil,
            serverWork: "idle",
            waitingSince: nil,
            unseenCount: 0,
            now: fixedNow,
            calendar: utcCal
        )
        expect(
            freshTurnOnly.kind == .turnOnly
                && freshTurnOnly.line == "Turn-only, checks when opened"
                && freshTurnOnly.indicator == .ring,
            "Never-active hosted MCP seat must say 'Turn-only, checks when opened' with ring (never dot)"
        )

        let liveListening = SeatStatusClassifier.classify(
            transport: "local",
            turnOnly: false,
            connection: "live",
            presenceProvided: true,
            wake: SeatWakeTimestamps(watcherAt: fixedNow.addingTimeInterval(-60), channelAt: nil, listenerAt: nil, turnAt: nil),
            lastCommandAt: fixedNow.addingTimeInterval(-240),
            lastActivityAt: fixedNow.addingTimeInterval(-240),
            workingOnSince: nil,
            workingOnUntil: nil,
            doingSince: nil,
            serverWork: "idle",
            waitingSince: fixedNow.addingTimeInterval(-30), // < 3 min tolerated on live push listener
            unseenCount: 1,
            now: fixedNow,
            calendar: utcCal
        )
        expect(
            liveListening.kind == .listening
                && liveListening.line == "Listening · 4 min ago"
                && liveListening.indicator == .dot,
            "Live push listener with < 3 min waiting must stay 'Listening · 4 min ago' with dot; got '\(liveListening.line)'"
        )

        // 1c. Live loopback scenarios: waiting_stale, not_listening, fault, legacy fallback, and 403 refusal precedence
        try await postFixture("\(base)/fixture/seat-scenario?mode=waiting_stale")
        await store.load(api: directoryAPI)
        let atlasWaiting = await MainActor.run { store.agents.first { $0.name == "Atlas" }!.seatStatus() }
        expect(
            atlasWaiting.kind == .waiting
                && atlasWaiting.indicator == .diamond
                && atlasWaiting.attention
                && atlasWaiting.line.hasPrefix("Waiting since ")
                && atlasWaiting.line.hasSuffix(" · 2 unseen"),
            "Loopback waiting_stale must surface 'Waiting since HH:MM · 2 unseen' with diamond; got '\(atlasWaiting.line)'"
        )

        try await postFixture("\(base)/fixture/seat-scenario?mode=not_listening")
        await store.load(api: directoryAPI)
        let atlasNotListening = await MainActor.run { store.agents.first { $0.name == "Atlas" }!.seatStatus() }
        expect(
            atlasNotListening.kind == .notListening
                && atlasNotListening.indicator == .ring
                && atlasNotListening.line == "Not listening · 2 h ago",
            "Loopback not_listening must surface 'Not listening · 2 h ago' with ring (never live dot); got '\(atlasNotListening.line)'"
        )

        try await postFixture("\(base)/fixture/seat-scenario?mode=fault")
        await store.load(api: directoryAPI)
        let atlasFault = await MainActor.run { store.agents.first { $0.name == "Atlas" }!.seatStatus() }
        expect(
            atlasFault.kind == .keyOff && atlasFault.indicator == .diamond && atlasFault.attention && atlasFault.line == "Key turned off",
            "Connection/key fault must outrank live watcher with diamond + attention; got '\(atlasFault.line)'"
        )

        // Legacy server fallback: agent_wake_path rejects unseen_count (400 -> retries without it) + home_overview 404
        try await postFixture("\(base)/fixture/seat-scenario?mode=waiting_stale")
        try await postFixture("\(base)/fixture/legacy-wake-path?on=1")
        try await postFixture("\(base)/fixture/omit-home-overview?on=1")
        await store.load(api: directoryAPI)
        let atlasLegacy = await MainActor.run { store.agents.first { $0.name == "Atlas" }!.seatStatus() }
        expect(
            atlasLegacy.kind == .waiting
                && atlasLegacy.indicator == .diamond
                && atlasLegacy.line.hasPrefix("Waiting since ")
                && !atlasLegacy.line.contains("unseen"),
            "Legacy fallback (no unseen_count, no home_overview) must still classify stale waiting cleanly without crashing; got '\(atlasLegacy.line)'"
        )
        try await postFixture("\(base)/fixture/legacy-wake-path?on=0")
        try await postFixture("\(base)/fixture/omit-home-overview?on=0")
        try await postFixture("\(base)/fixture/seat-scenario?mode=default")

        // Secondary refusal precedence: member_profiles 503 + home_overview 403 must refuse and clear roster
        await store.load(api: directoryAPI)
        try await postFixture("\(base)/fixture/fail-members?on=1")
        try await postFixture("\(base)/fixture/refuse-home-overview?on=1")
        await store.load(api: directoryAPI)
        let overviewRefusalCleared = await MainActor.run {
            store.accessUnavailable && store.people.isEmpty && store.agents.isEmpty && store.adminGrants.isEmpty
        }
        expect(overviewRefusalCleared, "Core 503 + home_overview 403 must refuse and clear cached roster")
        try await postFixture("\(base)/fixture/fail-members?on=0")
        try await postFixture("\(base)/fixture/refuse-home-overview?on=0")
        await store.load(api: directoryAPI)

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

        // 9c. Demoted viewer mixed HTTP 200 empty responses alongside core 503:
        //     member_profiles 503 + pending_invitations 200 [] + workspace_seat_admin_grants 200 null
        //     must CLEAR cached invite emails and cached owner grants immediately.
        await store.load(api: directoryAPI)
        let hadCachedPrivileged = await MainActor.run {
            store.invites.count == 1 && store.adminGrants.count == 1 && !store.accessUnavailable
        }
        expect(hadCachedPrivileged, "Expected cached invite email and owner grant before demoted-empty-with-503 witness")
        try await postFixture("\(base)/fixture/fail-members?on=1")
        try await postFixture("\(base)/fixture/empty-invites?on=1")
        try await postFixture("\(base)/fixture/non-owner-grants?on=1")
        await store.load(api: directoryAPI)
        let demotedEmptyCleared = await MainActor.run {
            store.invites.isEmpty
                && store.invitesReady
                && !store.invitesFailed
                && store.adminGrants.isEmpty
                && store.adminGrantsReady
                && store.loadFailed
                && !store.accessUnavailable
        }
        expect(demotedEmptyCleared, "Authoritative 200 [] invites and 200 null grants must clear cached privileged rows even when member_profiles returns 503")
        try await postFixture("\(base)/fixture/fail-members?on=0")
        try await postFixture("\(base)/fixture/empty-invites?on=0")
        try await postFixture("\(base)/fixture/non-owner-grants?on=0")

        // 9d. Fresh role-loss in member_profiles (200) while agent_principals (503) AND
        //     workspace_seat_admin_grants (503) both fail:
        //     - Live-owner control keeps cached owner grant details (with Admins count nil).
        //     - Demoted viewer (admin or member) clears/hides cached owner-only grant rows immediately.
        await store.load(api: directoryAPI)
        let ownerLoadedBefore9d = await MainActor.run {
            store.viewerIsOwner && store.adminGrants.count == 1 && store.filteredAdminGrants.count == 1
        }
        expect(ownerLoadedBefore9d, "Expected live owner with cached admin grant before 9d mixed role-loss witness")

        // 9d-i. Live-owner control: member_profiles 200 (still owner) + agents 503 + grants 503
        try await postFixture("\(base)/fixture/viewer-role?role=owner")
        try await postFixture("\(base)/fixture/fail-agents?on=1")
        try await postFixture("\(base)/fixture/fail-admin-grants?on=1")
        await store.load(api: directoryAPI)
        let liveOwnerControl9d = await MainActor.run {
            !store.accessUnavailable
                && store.loadFailed
                && store.viewerIsOwner
                && !store.adminGrantsReady
                && store.tabs.first(where: { $0.tab == .admins })?.count == nil
                && store.adminGrants.count == 1
                && store.filteredAdminGrants.count == 1
        }
        expect(liveOwnerControl9d, "Live-owner control: transient agents+grants 503 while still owner must keep cached grants with Admins count nil")

        // 9d-ii. Demoted to admin: member_profiles 200 (admin) + agents 503 + grants 503
        try await postFixture("\(base)/fixture/viewer-role?role=admin")
        await store.load(api: directoryAPI)
        let demotedAdminCleared = await MainActor.run {
            !store.accessUnavailable
                && store.loadFailed
                && store.viewerRole == .admin
                && !store.viewerIsOwner
                && !store.adminGrantsReady
                && store.tabs.first(where: { $0.tab == .admins })?.count == nil
                && store.adminGrants.isEmpty
                && store.filteredAdminGrants.isEmpty
        }
        expect(demotedAdminCleared, "Fresh role demotion to admin must clear/hide cached owner-only grants even when agents and grants RPC both return 503")

        // 9d-iii. Demoted to member: reload cached owner grants first, then member_profiles 200 (member) + agents 503 + grants 503
        try await postFixture("\(base)/fixture/viewer-role?role=owner")
        try await postFixture("\(base)/fixture/fail-agents?on=0")
        try await postFixture("\(base)/fixture/fail-admin-grants?on=0")
        await store.load(api: directoryAPI)
        let ownerReloadedBeforeMemberDemotion = await MainActor.run {
            store.viewerIsOwner && store.adminGrants.count == 1 && store.filteredAdminGrants.count == 1
        }
        expect(ownerReloadedBeforeMemberDemotion, "Expected cached owner grant before member-demotion 9d witness")
        try await postFixture("\(base)/fixture/viewer-role?role=member")
        try await postFixture("\(base)/fixture/fail-agents?on=1")
        try await postFixture("\(base)/fixture/fail-admin-grants?on=1")
        await store.load(api: directoryAPI)
        let demotedMemberCleared = await MainActor.run {
            !store.accessUnavailable
                && store.loadFailed
                && store.viewerRole == .member
                && !store.viewerIsOwner
                && !store.adminGrantsReady
                && store.adminGrants.isEmpty
                && store.filteredAdminGrants.isEmpty
        }
        expect(demotedMemberCleared, "Fresh role demotion to member must clear/hide cached owner-only grants even when agents and grants RPC both return 503")
        try await postFixture("\(base)/fixture/viewer-role?role=owner")
        try await postFixture("\(base)/fixture/fail-agents?on=0")
        try await postFixture("\(base)/fixture/fail-admin-grants?on=0")

        // 9e. Parallel mixed-snapshot race: successful pre-demotion owner grant RPC (HTTP 200 { grants: [...] })
        //     paired with a fresh demoted member_profiles response (admin or member) must clear cached grants
        //     AND exclude owner-only grant counts from the Admins tab badge & accessibility label
        //     in BOTH complete and partial (.coreFailed) settlement.
        // 9e-i. Complete settlement (agents 200): held successful owner RPC + fresh demoted member roster
        await store.load(api: directoryAPI)
        let ownerReadyBefore9e = await MainActor.run {
            store.viewerIsOwner
                && store.adminGrants.count == 1
                && store.tabs.first(where: { $0.tab == .admins })?.count == 3
        }
        expect(ownerReadyBefore9e, "Expected live owner with Admins count 3 before 9e parallel mixed-snapshot witness")

        try await postFixture("\(base)/fixture/hold-parallel-demotion")
        let raceCompleteTask = Task { await store.load(api: directoryAPI) }
        try await waitUntilParallelDemotionHeld(origin)
        // Demote viewer mid-flight after owner RPC already captured its pre-demotion { grants: [Atlas] } snapshot!
        try await postFixture("\(base)/fixture/viewer-role?role=member")
        try await postFixture("\(base)/fixture/release-parallel-demotion")
        await raceCompleteTask.value
        let raceCompleteCleared = await MainActor.run {
            let adminsTab = store.tabs.first(where: { $0.tab == .admins })
            return !store.accessUnavailable
                && !store.loadFailed
                && store.viewerRole == .member
                && !store.viewerIsOwner
                && store.adminGrants.isEmpty
                && store.visibleAdminGrants.isEmpty
                && store.filteredAdminGrants.isEmpty
                && store.managers.count == 1
                && adminsTab?.count == 1
                && adminsTab?.accessibilityLabel == "Admins, 1"
        }
        expect(raceCompleteCleared, "Parallel pre-demotion owner grant RPC + fresh demoted member roster (complete) must clear cached grants and report Admins count == 1 (managers only)")

        // 9e-ii. Partial settlement (agents 503): held successful owner RPC + fresh demoted admin roster
        try await postFixture("\(base)/fixture/viewer-role?role=owner")
        await store.load(api: directoryAPI)
        let ownerReadyBefore9ePartial = await MainActor.run {
            store.viewerIsOwner && store.adminGrants.count == 1 && store.tabs.first(where: { $0.tab == .admins })?.count == 3
        }
        expect(ownerReadyBefore9ePartial, "Expected reloaded live owner before 9e partial mixed-snapshot witness")

        try await postFixture("\(base)/fixture/fail-agents?on=1")
        try await postFixture("\(base)/fixture/hold-parallel-demotion")
        let racePartialTask = Task { await store.load(api: directoryAPI) }
        try await waitUntilParallelDemotionHeld(origin)
        try await postFixture("\(base)/fixture/viewer-role?role=admin")
        try await postFixture("\(base)/fixture/release-parallel-demotion")
        await racePartialTask.value
        let racePartialCleared = await MainActor.run {
            let adminsTab = store.tabs.first(where: { $0.tab == .admins })
            return !store.accessUnavailable
                && store.loadFailed
                && store.viewerRole == .admin
                && !store.viewerIsOwner
                && store.adminGrants.isEmpty
                && store.visibleAdminGrants.isEmpty
                && store.filteredAdminGrants.isEmpty
                && store.managers.count == 2
                && adminsTab?.count == 2
                && adminsTab?.accessibilityLabel == "Admins, 2"
        }
        expect(racePartialCleared, "Parallel pre-demotion owner grant RPC + fresh demoted admin roster (partial) must clear cached grants and report Admins count == 2 (managers only)")
        try await postFixture("\(base)/fixture/viewer-role?role=owner")
        try await postFixture("\(base)/fixture/fail-agents?on=0")

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

        // 10e. Removed viewer empty member_profiles (200 []) alongside agent_principals 503:
        //      must treat empty member_profiles as access loss and clear shared roster + both person and agent detail IDs.
        try await postFixture("\(base)/fixture/access-refused?on=0")
        await store.load(api: directoryAPI)
        let detailResolvedBeforeRemoval = await MainActor.run {
            store.authorizedPerson(id: mayaID)?.name == "Maya Chen"
                && store.authorizedAgent(id: beaconID)?.name == "Beacon"
        }
        expect(detailResolvedBeforeRemoval, "Expected Maya and Beacon resolved before removed-viewer 200 [] + 503 witness")
        try await postFixture("\(base)/fixture/empty-members?on=1")
        try await postFixture("\(base)/fixture/fail-agents?on=1")
        await store.load(api: directoryAPI)
        let clearedOnEmptyMembersWithAgents503 = await MainActor.run {
            store.accessUnavailable
                && store.people.isEmpty
                && store.agents.isEmpty
                && store.invites.isEmpty
                && store.adminGrants.isEmpty
                && store.authorizedPerson(id: mayaID) == nil
                && store.authorizedAgent(id: beaconID) == nil
                && store.agentsOwned(by: mayaID).isEmpty
        }
        expect(clearedOnEmptyMembersWithAgents503, "HTTP 200 [] member_profiles + 503 agent_principals must clear roster and detail resolution as access loss")
        try await postFixture("\(base)/fixture/empty-members?on=0")
        try await postFixture("\(base)/fixture/fail-agents?on=0")

        // 10f. Omitted target person alongside peer 503 (member_profiles 200 without Maya + agent_principals 503)
        await store.load(api: directoryAPI)
        try await postFixture("\(base)/fixture/omit-maya?on=1")
        try await postFixture("\(base)/fixture/fail-agents?on=1")
        await store.load(api: directoryAPI)
        let omittedPersonWithAgents503Cleared = await MainActor.run {
            !store.accessUnavailable
                && store.loadFailed
                && store.authorizedPerson(id: mayaID) == nil
                && store.authorizedPerson(id: tokens.userID)?.name == "Alex Rivera"
        }
        expect(omittedPersonWithAgents503Cleared, "Authoritative member_profiles omitting target person must clear person detail even when agent_principals returns 503")
        try await postFixture("\(base)/fixture/omit-maya?on=0")
        try await postFixture("\(base)/fixture/fail-agents?on=0")

        // Leaving detail when list is already gone must retire the store (0 sends on held bearer)
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

        print("PASS: VerifyPeopleDirectory (production POST workspace_seat_admin_grants RPC owner & null non-owner, duplicate-key safety, C1 held-bearer canDispatch & retire/activate zero-send, mixed 503+403 refusal precedence, authoritative empty 200 []/null clearing under peer 503, ID-bound detail routes with held-refusal/omission/live-control)")
    }
}
