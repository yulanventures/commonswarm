import Foundation

struct PeopleDirectorySnapshot: Sendable {
    let people: [WorkspacePerson]
    let agents: [WorkspaceAgent]
    let invites: [WorkspacePendingInvite]
    let invitesLoaded: Bool
    let adminGrants: [WorkspaceAgentAdminGrant]
    let adminGrantsLoaded: Bool
}

struct PeopleDirectoryPartialUpdate: Sendable {
    let people: [WorkspacePerson]?
    let agents: [WorkspaceAgent]?
    let invites: [WorkspacePendingInvite]?
    let adminGrants: [WorkspaceAgentAdminGrant]?
}

enum PeopleDirectoryLoadResult: Sendable {
    case complete(PeopleDirectorySnapshot)
    case coreFailed(PeopleDirectoryPartialUpdate)
}

struct PeopleDirectoryAPI: Sendable {
    let api: ConversationAPI

    var session: HumanSession { api.session }

    private struct MemberWire: Decodable {
        let user_id: UUID?
        let display_name: String?
        let role: String?
    }

    private struct AgentWire: Decodable {
        let principal_id: UUID?
        let name: String?
        let model: String?
        let transport: String?
        let turn_only: Bool?
        let owner_user_id: UUID?
        let revoked_at: String?
    }

    private struct PresenceWire: Decodable {
        let principal_id: UUID?
        let last_command_at: String?
        let client_build: String?
        let watcher_at: String?
        let channel_at: String?
        let listener_at: String?
        let turn_at: String?
        let last_ack_via: String?
        let last_ack_at: String?
        let current_client_build: String?
    }

    private struct WakePathWire: Decodable {
        let principal_id: UUID?
        let oldest_unobserved_at: String?
        let unseen_count: Int?
    }

    private struct HomeOverviewWire: Decodable {
        let workspaces: [HomeOverviewWorkspaceWire]?
    }

    private struct HomeOverviewWorkspaceWire: Decodable {
        let workspace_id: UUID?
        let people: [HomeOverviewPersonWire]?
    }

    private struct HomeOverviewPersonWire: Decodable {
        let agents: [HomeOverviewAgentWire]?
    }

    private struct HomeOverviewAgentWire: Decodable {
        let principal_id: UUID?
        let status: HomeOverviewAgentStatusWire?
    }

    private struct HomeOverviewAgentStatusWire: Decodable {
        let work: String?
        let facts: HomeOverviewAgentFactsWire?
    }

    private struct HomeOverviewWakeWire: Decodable {
        let watcher_at: String?
        let channel_at: String?
        let listener_at: String?
        let turn_at: String?
    }

    private struct HomeOverviewDoingWire: Decodable {
        let since: String?
    }

    private struct HomeOverviewWorkingOnWire: Decodable {
        let at: String?
        let until: String?
    }

    /// Deliberately omits private work titles (`doing.title` / `working_on.body`) so People & agents
    /// never holds or renders private titles across audiences.
    private struct HomeOverviewAgentFactsWire: Decodable {
        let connection: String?
        let last_activity_at: String?
        let messages_waiting_since: String?
        let messages_waiting_count: Int?
        let wake: HomeOverviewWakeWire?
        let doing: HomeOverviewDoingWire?
        let working_on: HomeOverviewWorkingOnWire?
    }

    private struct InviteWire: Decodable {
        let invitation_id: String?
        let email: String?
        let created_by: UUID?
        let created_at: String?
        let expires_at: String?
    }

    private struct AdminGrantsRPCBody: Encodable {
        let p_workspace_id: String
    }

    private struct AdminGrantsRPCResponse: Decodable {
        let grants: [AdminGrantWire]?
    }

    private struct AdminGrantWire: Decodable {
        let grant_id: String?
        let principal_id: UUID?
        let agent_name: String?
        let owner_user_id: UUID?
        let owner_display: String?
        let level: String?
        let expires_at: String?
        let created_at: String?
        let may_end: Bool?
    }

    private struct PostgrestErrorWire: Decodable {
        let code: String?
    }

    private func fetchView<Row: Decodable>(
        _ path: String,
        query: [String: String],
        canDispatch: @escaping @MainActor @Sendable () -> Bool
    ) async throws -> [Row] {
        var request = api.request("rest/v1/" + path, query)
        request.setValue("swarm_read", forHTTPHeaderField: "Accept-Profile")
        let (data, response) = try await api.session.data(for: request, canDispatch: canDispatch)
        guard let status = (response as? HTTPURLResponse)?.statusCode else {
            throw APIError.invalidResponse
        }
        if status == 401 || status == 403 || status == 404 {
            throw PeopleDirectoryError.accessRefused
        }
        guard status == 200 else {
            throw APIError.refused(status)
        }
        return try JSONDecoder().decode([Row].self, from: data)
    }

    /// Calls `POST rest/v1/rpc/workspace_seat_admin_grants` with `{"p_workspace_id": "<uuid>"}`.
    /// Returns `nil` when the server returns JSON `null` (viewer is not a live workspace owner) or
    /// when the RPC is not yet deployed (`404` / `PGRST202` / `42883`), matching `site/src/lib/seat-admin.ts`.
    private func fetchAdminGrantsRPC(
        workspaceID: UUID,
        canDispatch: @escaping @MainActor @Sendable () -> Bool
    ) async throws -> [AdminGrantWire]? {
        var request = api.request("rest/v1/rpc/workspace_seat_admin_grants")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("swarm_read", forHTTPHeaderField: "Accept-Profile")
        request.setValue("swarm_read", forHTTPHeaderField: "Content-Profile")
        request.httpBody = try JSONEncoder().encode(
            AdminGrantsRPCBody(p_workspace_id: workspaceID.uuidString.lowercased())
        )
        let (data, response) = try await api.session.data(for: request, canDispatch: canDispatch)
        guard let status = (response as? HTTPURLResponse)?.statusCode else {
            throw APIError.invalidResponse
        }
        if status == 401 || status == 403 {
            throw PeopleDirectoryError.accessRefused
        }
        if status != 200 {
            let errWire = try? JSONDecoder().decode(PostgrestErrorWire.self, from: data)
            if status == 404 || errWire?.code == "PGRST202" || errWire?.code == "42883" {
                return nil
            }
            throw APIError.refused(status)
        }
        let trimmed = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == "null" {
            return nil
        }
        let decoded = try JSONDecoder().decode(AdminGrantsRPCResponse.self, from: data)
        guard let grants = decoded.grants else {
            throw APIError.invalidResponse
        }
        return grants
    }

    /// Reads `swarm_read.agent_wake_path` with `unseen_count`, falling back to `oldest_unobserved_at`
    /// only when an older server returns HTTP 400 (column not yet deployed).
    private func fetchWakePath(
        wsFilter: String,
        canDispatch: @escaping @MainActor @Sendable () -> Bool
    ) async throws -> [WakePathWire] {
        do {
            return try await fetchView(
                "agent_wake_path",
                query: [
                    "select": "principal_id,oldest_unobserved_at,unseen_count",
                    "workspace_id": wsFilter,
                    "limit": "500",
                ],
                canDispatch: canDispatch
            )
        } catch APIError.refused(400) {
            return try await fetchView(
                "agent_wake_path",
                query: [
                    "select": "principal_id,oldest_unobserved_at",
                    "workspace_id": wsFilter,
                    "limit": "500",
                ],
                canDispatch: canDispatch
            )
        }
    }

    /// Calls `POST rest/v1/rpc/home_overview` for C2 live seat status facts (`work`, `connection`,
    /// `last_activity_at`, `messages_waiting_*`, `wake`, `doing.since`, `working_on`).
    /// Returns `nil` when not deployed (`404`/`PGRST202`/`42883`); throws `accessRefused` on `401`/`403`.
    private func fetchHomeOverviewAgents(
        workspaceID: UUID,
        canDispatch: @escaping @MainActor @Sendable () -> Bool
    ) async throws -> [UUID: HomeOverviewAgentStatusWire]? {
        var request = api.request("rest/v1/rpc/home_overview")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("swarm_read", forHTTPHeaderField: "Accept-Profile")
        request.setValue("swarm_read", forHTTPHeaderField: "Content-Profile")
        request.httpBody = Data("{}".utf8)
        let (data, response) = try await api.session.data(for: request, canDispatch: canDispatch)
        guard let status = (response as? HTTPURLResponse)?.statusCode else {
            throw APIError.invalidResponse
        }
        if status == 401 || status == 403 {
            throw PeopleDirectoryError.accessRefused
        }
        if status != 200 {
            let errWire = try? JSONDecoder().decode(PostgrestErrorWire.self, from: data)
            if status == 404 || errWire?.code == "PGRST202" || errWire?.code == "42883" {
                return nil
            }
            throw APIError.refused(status)
        }
        let trimmed = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == "null" {
            return nil
        }
        let overview = try JSONDecoder().decode(HomeOverviewWire.self, from: data)
        guard let workspace = overview.workspaces?.first(where: { $0.workspace_id == workspaceID }) else {
            return nil
        }
        var byAgent: [UUID: HomeOverviewAgentStatusWire] = [:]
        for person in workspace.people ?? [] {
            for agent in person.agents ?? [] {
                guard let id = agent.principal_id, let agentStatus = agent.status else { continue }
                if byAgent[id] == nil {
                    byAgent[id] = agentStatus
                }
            }
        }
        return byAgent
    }

    func loadDirectory(
        workspaceID: UUID,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async throws -> PeopleDirectoryLoadResult {
        let wsFilter = "eq." + workspaceID.uuidString.lowercased()
        let viewerID = await MainActor.run { api.session.userID }

        async let membersTask: Result<[MemberWire], Error> = {
            do {
                let rows: [MemberWire] = try await fetchView(
                    "member_profiles",
                    query: [
                        "select": "user_id,display_name,role",
                        "workspace_id": wsFilter,
                        "limit": "1000",
                    ],
                    canDispatch: canDispatch
                )
                return .success(rows)
            } catch {
                return .failure(error)
            }
        }()
        async let agentsTask: Result<[AgentWire], Error> = {
            do {
                let rows: [AgentWire] = try await fetchView(
                    "agent_principals",
                    query: [
                        "select": "principal_id,name,model,transport,turn_only,owner_user_id,revoked_at,workspace_id",
                        "workspace_id": wsFilter,
                        "revoked_at": "is.null",
                        "order": "name.asc,principal_id.asc",
                        "limit": "500",
                    ],
                    canDispatch: canDispatch
                )
                return .success(rows)
            } catch {
                return .failure(error)
            }
        }()
        async let presenceTask: Result<[PresenceWire], Error> = {
            do {
                let rows: [PresenceWire] = try await fetchView(
                    "agent_presence",
                    query: [
                        "select": "principal_id,last_command_at,client_build,watcher_at,channel_at,listener_at,turn_at,last_ack_via,last_ack_at,current_client_build",
                        "workspace_id": wsFilter,
                        "limit": "500",
                    ],
                    canDispatch: canDispatch
                )
                return .success(rows)
            } catch {
                return .failure(error)
            }
        }()
        async let wakePathTask: Result<[WakePathWire], Error> = {
            do {
                return .success(try await fetchWakePath(wsFilter: wsFilter, canDispatch: canDispatch))
            } catch {
                return .failure(error)
            }
        }()
        async let overviewTask: Result<[UUID: HomeOverviewAgentStatusWire]?, Error> = {
            do {
                return .success(try await fetchHomeOverviewAgents(workspaceID: workspaceID, canDispatch: canDispatch))
            } catch {
                return .failure(error)
            }
        }()
        async let invitesTask: Result<[InviteWire], Error> = {
            do {
                let rows: [InviteWire] = try await fetchView(
                    "pending_invitations",
                    query: [
                        "select": "workspace_id,invitation_id,email,created_by,created_at,expires_at",
                        "workspace_id": wsFilter,
                        "order": "created_at.desc",
                        "limit": "50",
                    ],
                    canDispatch: canDispatch
                )
                return .success(rows)
            } catch {
                return .failure(error)
            }
        }()
        async let adminGrantsTask: Result<[AdminGrantWire]?, Error> = {
            do {
                return .success(try await fetchAdminGrantsRPC(workspaceID: workspaceID, canDispatch: canDispatch))
            } catch {
                return .failure(error)
            }
        }()

        let membersResult = await membersTask
        let agentsResult = await agentsTask
        let presenceResult = await presenceTask
        let wakePathResult = await wakePathTask
        let overviewResult = await overviewTask
        let invitesResult = await invitesTask
        let grantsResult = await adminGrantsTask

        // Access refusal (401/403/404) from ANY read takes precedence over simultaneous transient errors
        // so a core 503 cannot mask a secondary 403 and leave stale privileged rows on screen.
        if case .failure(PeopleDirectoryError.accessRefused) = membersResult {
            throw PeopleDirectoryError.accessRefused
        }
        if case .failure(PeopleDirectoryError.accessRefused) = agentsResult {
            throw PeopleDirectoryError.accessRefused
        }
        if case .failure(PeopleDirectoryError.accessRefused) = presenceResult {
            throw PeopleDirectoryError.accessRefused
        }
        if case .failure(PeopleDirectoryError.accessRefused) = wakePathResult {
            throw PeopleDirectoryError.accessRefused
        }
        if case .failure(PeopleDirectoryError.accessRefused) = overviewResult {
            throw PeopleDirectoryError.accessRefused
        }
        if case .failure(PeopleDirectoryError.accessRefused) = invitesResult {
            throw PeopleDirectoryError.accessRefused
        }
        if case .failure(PeopleDirectoryError.accessRefused) = grantsResult {
            throw PeopleDirectoryError.accessRefused
        }

        // `swarm_read.member_profiles` is gated by live workspace membership, so a removed viewer
        // receives an authoritative HTTP 200 `[]`. Treat that as access loss before checking peer
        // transient failures (e.g. `agent_principals` 503) so stale rows and detail IDs clear.
        let decodedPeople: [WorkspacePerson]?
        switch membersResult {
        case .success(let memberRows):
            let parsed: [WorkspacePerson] = memberRows.compactMap { row in
                guard let userID = row.user_id,
                      let rawName = row.display_name?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !rawName.isEmpty,
                      let rawRole = row.role,
                      let role = WorkspaceMemberRole(rawValue: rawRole) else {
                    return nil
                }
                return WorkspacePerson(
                    userID: userID,
                    name: rawName,
                    role: role,
                    isViewer: userID == viewerID
                )
            }.sorted { lhs, rhs in
                if lhs.role.sortOrder != rhs.role.sortOrder {
                    return lhs.role.sortOrder < rhs.role.sortOrder
                }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
            if memberRows.isEmpty || parsed.isEmpty {
                throw PeopleDirectoryError.accessRefused
            }
            decodedPeople = parsed
        case .failure(let error):
            if error is CancellationError {
                throw error
            }
            decodedPeople = nil
        }

        if case .failure(let error) = agentsResult, error is CancellationError {
            throw error
        }

        let presenceRows: [PresenceWire]?
        if case .success(let rows) = presenceResult {
            presenceRows = rows
        } else {
            presenceRows = nil
        }

        let wakePathRows: [WakePathWire]?
        if case .success(let rows) = wakePathResult {
            wakePathRows = rows
        } else {
            wakePathRows = nil
        }

        let overviewByAgent: [UUID: HomeOverviewAgentStatusWire]?
        if case .success(let map) = overviewResult {
            overviewByAgent = map
        } else {
            overviewByAgent = nil
        }

        let namesByUserID = Dictionary((decodedPeople ?? []).map { ($0.userID, $0.name) }, uniquingKeysWith: { first, _ in first })
        let presenceByAgentID: [UUID: PresenceWire] = Dictionary(
            (presenceRows ?? []).compactMap { row in
                guard let id = row.principal_id else { return nil }
                return (id, row)
            },
            uniquingKeysWith: { first, _ in first }
        )
        let wakePathByAgentID: [UUID: WakePathWire] = Dictionary(
            (wakePathRows ?? []).compactMap { row in
                guard let id = row.principal_id else { return nil }
                return (id, row)
            },
            uniquingKeysWith: { first, _ in first }
        )
        let presenceAvailable = presenceRows != nil || overviewByAgent != nil

        let decodedAgents: [WorkspaceAgent]?
        switch agentsResult {
        case .success(let agentRows):
            decodedAgents = agentRows.compactMap { row in
                guard row.revoked_at == nil,
                      let principalID = row.principal_id,
                      let ownerUserID = row.owner_user_id else {
                    return nil
                }
                let rawName = row.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let displayName = rawName.isEmpty ? "Agent" : rawName
                let model = row.model?.trimmingCharacters(in: .whitespacesAndNewlines)
                let presence = presenceByAgentID[principalID]
                let wakeRow = wakePathByAgentID[principalID]
                let overview = overviewByAgent?[principalID]
                let overviewFacts = overview?.facts

                let watcherAt = PeopleDirectoryRules.parseISO8601(presence?.watcher_at ?? overviewFacts?.wake?.watcher_at)
                let channelAt = PeopleDirectoryRules.parseISO8601(presence?.channel_at ?? overviewFacts?.wake?.channel_at)
                let listenerAt = PeopleDirectoryRules.parseISO8601(presence?.listener_at ?? overviewFacts?.wake?.listener_at)
                let turnAt = PeopleDirectoryRules.parseISO8601(presence?.turn_at ?? overviewFacts?.wake?.turn_at)
                let wakeTimestamps = SeatWakeTimestamps(
                    watcherAt: watcherAt,
                    channelAt: channelAt,
                    listenerAt: listenerAt,
                    turnAt: turnAt
                )

                let waitingSince = PeopleDirectoryRules.parseISO8601(
                    overviewFacts?.messages_waiting_since ?? wakeRow?.oldest_unobserved_at
                )
                let unseenCount = overviewFacts?.messages_waiting_count ?? wakeRow?.unseen_count

                return WorkspaceAgent(
                    principalID: principalID,
                    name: displayName,
                    model: (model?.isEmpty == false) ? model : nil,
                    transport: row.transport,
                    turnOnly: row.turn_only ?? false,
                    ownerUserID: ownerUserID,
                    ownerName: ownerUserID == viewerID ? "You" : namesByUserID[ownerUserID],
                    isOwnedByViewer: ownerUserID == viewerID,
                    presenceAvailable: presenceAvailable,
                    lastCommandAt: PeopleDirectoryRules.parseISO8601(presence?.last_command_at),
                    clientBuild: presence?.client_build,
                    lastAckVia: presence?.last_ack_via,
                    connection: overviewFacts?.connection,
                    wake: presenceAvailable ? wakeTimestamps : nil,
                    lastActivityAt: PeopleDirectoryRules.parseISO8601(overviewFacts?.last_activity_at),
                    workingOnSince: PeopleDirectoryRules.parseISO8601(overviewFacts?.working_on?.at),
                    workingOnUntil: PeopleDirectoryRules.parseISO8601(overviewFacts?.working_on?.until),
                    doingSince: PeopleDirectoryRules.parseISO8601(overviewFacts?.doing?.since),
                    serverWork: overview?.work,
                    waitingSince: waitingSince,
                    unseenCount: unseenCount
                )
            }
        case .failure:
            decodedAgents = nil
        }

        let agentNamesByID = Dictionary((decodedAgents ?? []).map { ($0.principalID, $0.name) }, uniquingKeysWith: { first, _ in first })

        let decodedInvites: [WorkspacePendingInvite]?
        switch invitesResult {
        case .success(let rows):
            decodedInvites = rows.compactMap { row in
                guard let id = row.invitation_id, !id.isEmpty else { return nil }
                let email = row.email?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Teammate"
                let creatorName: String? = row.created_by.map { uid in
                    uid == viewerID ? "You" : (namesByUserID[uid] ?? "Member")
                }
                return WorkspacePendingInvite(
                    invitationID: id,
                    email: email.isEmpty ? "Teammate" : email,
                    createdBy: row.created_by,
                    createdByName: creatorName,
                    createdAt: PeopleDirectoryRules.parseISO8601(row.created_at),
                    expiresAt: PeopleDirectoryRules.parseISO8601(row.expires_at)
                )
            }
        case .failure:
            decodedInvites = nil
        }

        let decodedAdminGrants: [WorkspaceAgentAdminGrant]?
        switch grantsResult {
        case .success(let maybeRows):
            // Both live owners ({ grants: [...] }) and non-owners (null -> []) complete cleanly.
            let rows = maybeRows ?? []
            decodedAdminGrants = rows.compactMap { row in
                guard let grantID = row.grant_id, !grantID.isEmpty,
                      let principalID = row.principal_id else {
                    return nil
                }
                let rawAgentName = row.agent_name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let agentName = rawAgentName.isEmpty ? (agentNamesByID[principalID] ?? "Agent") : rawAgentName
                let rawOwnerDisplay = row.owner_display?.trimmingCharacters(in: .whitespacesAndNewlines)
                let ownerDisplay: String?
                if let rawOwnerDisplay, !rawOwnerDisplay.isEmpty {
                    ownerDisplay = rawOwnerDisplay
                } else if let ownerID = row.owner_user_id {
                    ownerDisplay = ownerID == viewerID ? "You" : namesByUserID[ownerID]
                } else {
                    ownerDisplay = nil
                }
                return WorkspaceAgentAdminGrant(
                    grantID: grantID,
                    principalID: principalID,
                    agentName: agentName,
                    ownerUserID: row.owner_user_id,
                    ownerDisplay: ownerDisplay,
                    level: row.level?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "scoped",
                    expiresAt: PeopleDirectoryRules.parseISO8601(row.expires_at),
                    createdAt: PeopleDirectoryRules.parseISO8601(row.created_at),
                    mayEnd: row.may_end ?? false
                )
            }
        case .failure:
            decodedAdminGrants = nil
        }

        let freshNonOwner = decodedPeople.map { people in
            people.first(where: { $0.isViewer })?.role != .owner
        } ?? false
        let effectiveAdminGrants: [WorkspaceAgentAdminGrant]? = freshNonOwner
            ? (decodedAdminGrants != nil ? [] : nil)
            : decodedAdminGrants

        if let people = decodedPeople, let agents = decodedAgents {
            return .complete(
                PeopleDirectorySnapshot(
                    people: people,
                    agents: agents,
                    invites: decodedInvites ?? [],
                    invitesLoaded: decodedInvites != nil,
                    adminGrants: effectiveAdminGrants ?? [],
                    adminGrantsLoaded: effectiveAdminGrants != nil
                )
            )
        }

        return .coreFailed(
            PeopleDirectoryPartialUpdate(
                people: decodedPeople,
                agents: decodedAgents,
                invites: decodedInvites,
                adminGrants: effectiveAdminGrants
            )
        )
    }
}
