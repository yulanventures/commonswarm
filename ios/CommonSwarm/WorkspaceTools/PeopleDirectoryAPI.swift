import Foundation

struct PeopleDirectorySnapshot: Sendable {
    let people: [WorkspacePerson]
    let agents: [WorkspaceAgent]
    let invites: [WorkspacePendingInvite]
    let invitesLoaded: Bool
    let adminGrants: [WorkspaceAgentAdminGrant]
    let adminGrantsLoaded: Bool
    let adminGrantsAll: Bool
}

struct PeopleDirectoryPartialUpdate: Sendable {
    let people: [WorkspacePerson]?
    let agents: [WorkspaceAgent]?
    let invites: [WorkspacePendingInvite]?
    let adminGrants: [WorkspaceAgentAdminGrant]?
    let adminGrantsAll: Bool?
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
        let last_ack_via: String?
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

    private struct MyAdminGrantsRPCResponse: Decodable {
        let grants: [MyAdminGrantWire]?
    }

    private struct MyAdminGrantWire: Decodable {
        let grant_id: String?
        let principal_id: UUID?
        let level: String?
        let organization_id: String?
        let workspace_ids: [String]?
        let expires_at: String?
        let state: String?
        let created_at: String?
    }

    private struct WorkspaceOrgWire: Decodable {
        let workspace_id: UUID?
        let org_id: UUID?
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

    /// Calls `POST rest/v1/rpc/my_seat_admin_grants` with `{}` for non-owner members and admins,
    /// matching `loadMySeatAdminGrants` in `site/src/lib/seat-admin.ts`.
    private func fetchMyAdminGrantsRPC(
        canDispatch: @escaping @MainActor @Sendable () -> Bool
    ) async throws -> [MyAdminGrantWire] {
        var request = api.request("rest/v1/rpc/my_seat_admin_grants")
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
                return []
            }
            throw APIError.refused(status)
        }
        let trimmed = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == "null" {
            return []
        }
        let decoded = try JSONDecoder().decode(MyAdminGrantsRPCResponse.self, from: data)
        guard let grants = decoded.grants else {
            throw APIError.invalidResponse
        }
        return grants
    }

    func loadDirectory(
        workspaceID: UUID,
        organizationID: UUID? = nil,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true },
        onOwnerGrantsDenied: @escaping @MainActor @Sendable () -> Void = {}
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
                        "select": "principal_id,last_command_at,client_build,last_ack_via",
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

        let namesByUserID = Dictionary((decodedPeople ?? []).map { ($0.userID, $0.name) }, uniquingKeysWith: { first, _ in first })
        let presenceByAgentID: [UUID: PresenceWire] = Dictionary(
            (presenceRows ?? []).compactMap { row in
                guard let id = row.principal_id else { return nil }
                return (id, row)
            },
            uniquingKeysWith: { first, _ in first }
        )
        let presenceAvailable = presenceRows != nil

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
                    lastAckVia: presence?.last_ack_via
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

        let freshNonOwner = decodedPeople.map { people in
            people.first(where: { $0.isViewer })?.role != .owner
        } ?? false

        let workspaceGrantsReturnedNull: Bool
        if case .success(nil) = grantsResult {
            workspaceGrantsReturnedNull = true
        } else {
            workspaceGrantsReturnedNull = false
        }

        let effectiveAdminGrants: [WorkspaceAgentAdminGrant]?
        let effectiveAdminGrantsAll: Bool

        if freshNonOwner || workspaceGrantsReturnedNull {
            // Non-owner viewer (or owner RPC returned null): clear any cached owner-wide
            // grant rows and count immediately BEFORE dispatching the own-grants RPC so
            // owner-wide rows never stay visible while my_seat_admin_grants is in flight.
            if await canDispatch() {
                await onOwnerGrantsDenied()
            }
            effectiveAdminGrantsAll = false
            do {
                let myRows = try await fetchMyAdminGrantsRPC(canDispatch: canDispatch)
                var resolvedOrgID = organizationID
                let hasActiveOrgGrant = myRows.contains {
                    $0.state?.lowercased() == "active"
                        && $0.level?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "organization"
                }
                if resolvedOrgID == nil && hasActiveOrgGrant {
                    let wsRows: [WorkspaceOrgWire] = try await fetchView(
                        "workspaces",
                        query: [
                            "select": "workspace_id,org_id",
                            "workspace_id": wsFilter,
                            "limit": "1",
                        ],
                        canDispatch: canDispatch
                    )
                    resolvedOrgID = wsRows.first(where: { $0.workspace_id == workspaceID })?.org_id
                }
                let targetWorkspace = workspaceID.uuidString.lowercased()
                let targetOrganization = resolvedOrgID?.uuidString.lowercased()
                let now = Date()
                effectiveAdminGrants = myRows.compactMap { row in
                    guard let grantID = row.grant_id, !grantID.isEmpty,
                          let principalID = row.principal_id,
                          row.state?.lowercased() == "active",
                          let agentName = agentNamesByID[principalID] else {
                        return nil
                    }
                    let expiresAt = PeopleDirectoryRules.parseISO8601(row.expires_at)
                    if let expiresAt, expiresAt <= now {
                        return nil
                    }
                    let normalizedLevel = row.level?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "scoped"
                    let matchesHere: Bool
                    if normalizedLevel == "organization" {
                        let grantOrg = row.organization_id?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                        matchesHere = targetOrganization != nil && grantOrg != nil && grantOrg == targetOrganization
                    } else {
                        let workspaceIDs = (row.workspace_ids ?? []).map { $0.lowercased() }
                        matchesHere = workspaceIDs.contains(targetWorkspace)
                    }
                    guard matchesHere else {
                        return nil
                    }
                    return WorkspaceAgentAdminGrant(
                        grantID: grantID,
                        principalID: principalID,
                        agentName: agentName,
                        ownerUserID: viewerID,
                        ownerDisplay: "You",
                        level: normalizedLevel,
                        expiresAt: expiresAt,
                        createdAt: PeopleDirectoryRules.parseISO8601(row.created_at),
                        mayEnd: true
                    )
                }
            } catch PeopleDirectoryError.accessRefused {
                throw PeopleDirectoryError.accessRefused
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                effectiveAdminGrants = nil
            }
        } else {
            effectiveAdminGrantsAll = true
            switch grantsResult {
            case .success(let maybeRows):
                let rows = maybeRows ?? []
                effectiveAdminGrants = rows.compactMap { row in
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
                effectiveAdminGrants = nil
            }
        }

        if let people = decodedPeople, let agents = decodedAgents {
            return .complete(
                PeopleDirectorySnapshot(
                    people: people,
                    agents: agents,
                    invites: decodedInvites ?? [],
                    invitesLoaded: decodedInvites != nil,
                    adminGrants: effectiveAdminGrants ?? [],
                    adminGrantsLoaded: effectiveAdminGrants != nil,
                    adminGrantsAll: effectiveAdminGrantsAll
                )
            )
        }

        return .coreFailed(
            PeopleDirectoryPartialUpdate(
                people: decodedPeople,
                agents: decodedAgents,
                invites: decodedInvites,
                adminGrants: effectiveAdminGrants,
                adminGrantsAll: effectiveAdminGrants != nil ? effectiveAdminGrantsAll : nil
            )
        )
    }
}
