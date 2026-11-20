import Foundation

struct PeopleDirectorySnapshot: Sendable {
    let people: [WorkspacePerson]
    let agents: [WorkspaceAgent]
    let invites: [WorkspacePendingInvite]
    let invitesLoaded: Bool
    let adminGrants: [WorkspaceAgentAdminGrant]
    let adminGrantsLoaded: Bool
}

struct PeopleDirectoryAPI: Sendable {
    let api: ConversationAPI

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

    private struct AdminGrantWire: Decodable {
        let grant_id: String?
        let principal_id: UUID?
        let scopes: [String]?
        let expires_at: String?
        let revoked_at: String?
    }

    private func fetchView<Row: Decodable>(_ path: String, query: [String: String]) async throws -> [Row] {
        var request = api.request("rest/v1/" + path, query)
        request.setValue("swarm_read", forHTTPHeaderField: "Accept-Profile")
        let (data, response) = try await api.session.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode else {
            throw APIError.invalidResponse
        }
        if status == 403 {
            throw PeopleDirectoryError.accessRefused
        }
        guard status == 200 else {
            throw APIError.refused(status)
        }
        return try JSONDecoder().decode([Row].self, from: data)
    }

    func loadDirectory(workspaceID: UUID) async throws -> PeopleDirectorySnapshot {
        let wsFilter = "eq." + workspaceID.uuidString.lowercased()
        let viewerID = await MainActor.run { api.session.userID }

        async let membersTask: [MemberWire] = fetchView(
            "member_profiles",
            query: [
                "select": "user_id,display_name,role",
                "workspace_id": wsFilter,
                "limit": "1000",
            ]
        )
        async let agentsTask: [AgentWire] = fetchView(
            "agent_principals",
            query: [
                "select": "principal_id,name,model,transport,turn_only,owner_user_id,revoked_at,workspace_id",
                "workspace_id": wsFilter,
                "revoked_at": "is.null",
                "order": "name.asc,principal_id.asc",
                "limit": "500",
            ]
        )
        async let presenceTask: [PresenceWire]? = try? await fetchView(
            "agent_presence",
            query: [
                "select": "principal_id,last_command_at,client_build,last_ack_via",
                "workspace_id": wsFilter,
                "limit": "500",
            ]
        )
        async let invitesTask: Result<[InviteWire], Error> = {
            do {
                let rows: [InviteWire] = try await fetchView(
                    "pending_invitations",
                    query: [
                        "select": "workspace_id,invitation_id,email,created_by,created_at,expires_at",
                        "workspace_id": wsFilter,
                        "order": "created_at.desc",
                        "limit": "50",
                    ]
                )
                return .success(rows)
            } catch {
                return .failure(error)
            }
        }()
        async let adminGrantsTask: Result<[AdminGrantWire], Error> = {
            do {
                let rows: [AdminGrantWire] = try await fetchView(
                    "workspace_seat_admin_grants",
                    query: [
                        "select": "grant_id,principal_id,scopes,expires_at,revoked_at",
                        "workspace_id": wsFilter,
                        "revoked_at": "is.null",
                        "limit": "200",
                    ]
                )
                return .success(rows)
            } catch {
                return .failure(error)
            }
        }()

        let memberRows = try await membersTask
        let agentRows = try await agentsTask
        let presenceRows = await presenceTask
        let invitesResult = await invitesTask
        let grantsResult = await adminGrantsTask

        // Propagate explicit 403 access refusal if secondary views report it
        if case .failure(PeopleDirectoryError.accessRefused) = invitesResult {
            throw PeopleDirectoryError.accessRefused
        }
        if case .failure(PeopleDirectoryError.accessRefused) = grantsResult {
            throw PeopleDirectoryError.accessRefused
        }

        let people: [WorkspacePerson] = memberRows.compactMap { row in
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

        let namesByUserID = Dictionary(uniqueKeysWithValues: people.map { ($0.userID, $0.name) })
        let presenceByAgentID: [UUID: PresenceWire] = Dictionary(
            uniqueKeysWithValues: (presenceRows ?? []).compactMap { row in
                guard let id = row.principal_id else { return nil }
                return (id, row)
            }
        )
        let presenceAvailable = presenceRows != nil

        let agents: [WorkspaceAgent] = agentRows.compactMap { row in
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

        let agentNamesByID = Dictionary(uniqueKeysWithValues: agents.map { ($0.principalID, $0.name) })

        let invitesLoaded: Bool
        let invites: [WorkspacePendingInvite]
        switch invitesResult {
        case .success(let rows):
            invitesLoaded = true
            invites = rows.compactMap { row in
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
            invitesLoaded = false
            invites = []
        }

        let adminGrantsLoaded: Bool
        let adminGrants: [WorkspaceAgentAdminGrant]
        switch grantsResult {
        case .success(let rows):
            adminGrantsLoaded = true
            adminGrants = rows.compactMap { row in
                guard row.revoked_at == nil,
                      let grantID = row.grant_id, !grantID.isEmpty,
                      let principalID = row.principal_id else {
                    return nil
                }
                return WorkspaceAgentAdminGrant(
                    grantID: grantID,
                    principalID: principalID,
                    agentName: agentNamesByID[principalID] ?? "Agent",
                    scopes: row.scopes ?? [],
                    expiresAt: PeopleDirectoryRules.parseISO8601(row.expires_at)
                )
            }
        case .failure:
            // Treat 404/unavailable view gracefully when not yet deployed on older servers,
            // while still reflecting adminGrantsLoaded = false if it errored.
            adminGrantsLoaded = false
            adminGrants = []
        }

        return PeopleDirectorySnapshot(
            people: people,
            agents: agents,
            invites: invites,
            invitesLoaded: invitesLoaded,
            adminGrants: adminGrants,
            adminGrantsLoaded: adminGrantsLoaded
        )
    }
}
