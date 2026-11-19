import Foundation

struct SharedObjectsAPI: Sendable {
    let api: ConversationAPI

    private static let householdLocalSeat = "seat_0000000000000000000000"
    private static let pageLimit = 100
    private static let unconfirmedMessage = "The save could not be confirmed. Retry or reload to check."

    private struct CommandStream: Encodable {
        let kind = "workspace"
    }

    private struct CommandEnvelope<Command: Encodable>: Encodable {
        let command_id: String
        let workspace_id: String
        let client_version = ConversationAPI.clientVersion
        let stream = CommandStream()
        let command: Command
    }

    private struct HouseholdAccessCommand: Encodable {
        let kind = "household_access"
    }

    private struct HouseholdToolCommand<Arguments: Encodable>: Encodable {
        let kind = "household_tool"
        let tool: String
        let arguments: Arguments
    }

    private struct ObjectListArgs: Encodable {
        let seat: String
        let offset: Int
        let limit: Int
    }

    private struct ObjectReadArgs: Encodable {
        let seat: String
        let object_id: String
    }

    private struct ListPatchBody: Encodable {
        let kind = "list"
        let operations: [SharedListPatchOp]
    }

    private struct ObjectUpdateArgs: Encodable {
        let seat: String
        let request_id: String
        let object_id: String
        let base: SharedRevisionRef
        let patch: ListPatchBody
    }

    private struct AccessReplyWire: Decodable {
        let status: String
        let reason: String?
        let content_role: SharedContentRole?
        let operations: [String]?
    }

    private struct ObjectListEntryWire: Decodable {
        let object_id: String
        let kind: SharedObjectKind
        let title: String
        let revision: SharedRevisionRef
    }

    private struct ObjectListReplyWire: Decodable {
        let status: String?
        let reason: String?
        let error: String?
        let objects: [ObjectListEntryWire]?
        let next_offset: Int?
    }

    private struct RevisionMetaWire: Decodable {
        let revision: SharedRevisionRef
        let title: String
        let kind: SharedObjectKind?
        let author: SharedAttribution
        let occurred_at_server: Int64
    }

    private struct ContentWire: Decodable {
        let kind: SharedObjectKind
        let items: [SharedListItem]?
        let markdown: String?
    }

    private struct ObjectReadReplyWire: Decodable {
        let status: String?
        let reason: String?
        let error: String?
        let live: Bool?
        let revision: RevisionMetaWire?
        let content: ContentWire?
    }

    private struct ObjectUpdateReplyWire: Decodable {
        let status: String?
        let object_id: String?
        let revision: SharedRevisionRef?
        let current: SharedRevisionRef?
        let draft_id: String?
        let reason: String?
        let error: String?
    }

    private struct MemberProfileWire: Decodable {
        let user_id: UUID
        let display_name: String?
    }

    private struct AgentPrincipalWire: Decodable {
        let principal_id: UUID
        let name: String?
    }

    private func postCommand<Command: Encodable>(
        workspaceID: UUID,
        commandID: UUID,
        command: Command
    ) async throws -> (Data, Int) {
        var request = api.request("functions/v1/command")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let envelope = CommandEnvelope(
            command_id: commandID.uuidString.lowercased(),
            workspace_id: workspaceID.uuidString.lowercased(),
            command: command
        )
        request.httpBody = try JSONEncoder().encode(envelope)
        let (data, response) = try await api.session.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode else {
            throw APIError.invalidResponse
        }
        return (data, status)
    }

    func access(workspaceID: UUID) async throws -> SharedAccessStatus {
        let (data, status) = try await postCommand(
            workspaceID: workspaceID,
            commandID: UUID(),
            command: HouseholdAccessCommand()
        )
        guard status == 200 || status == 403,
              let reply = try? JSONDecoder().decode(AccessReplyWire.self, from: data) else {
            throw APIError.refused(status)
        }
        if reply.status == "ok", let role = reply.content_role, let operations = reply.operations {
            return .granted(SharedAccess(role: role, operations: Set(operations)))
        }
        let reason = reply.reason ?? "content_consent_required"
        if reason == "content_consent_required" {
            return .needsConfirmation(reason: reason)
        }
        return .refused(reason: reason)
    }

    func listObjects(workspaceID: UUID) async throws -> [SharedObjectSummary] {
        var collected: [SharedObjectSummary] = []
        var seen = Set<String>()
        var offset = 0

        while true {
            let (data, status) = try await postCommand(
                workspaceID: workspaceID,
                commandID: UUID(),
                command: HouseholdToolCommand(
                    tool: "object_list",
                    arguments: ObjectListArgs(
                        seat: Self.householdLocalSeat,
                        offset: offset,
                        limit: Self.pageLimit
                    )
                )
            )
            if (status == 200 || status == 403),
               let reply = try? JSONDecoder().decode(ObjectListReplyWire.self, from: data) {
                if reply.status == "refused" {
                    throw SharedObjectsError.refused(reason: reply.reason ?? "workspace_access_refused")
                }
                if status == 403, let err = reply.error, !err.isEmpty {
                    throw SharedObjectsError.refused(reason: err)
                }
                if status == 200, reply.status == "ok", let rows = reply.objects {
                    for row in rows {
                        guard row.kind.isListOrDoc else { continue }
                        guard row.revision.isBound(workspaceID: workspaceID, objectID: row.object_id) else {
                            throw APIError.invalidResponse
                        }
                        if seen.insert(row.object_id).inserted {
                            collected.append(
                                SharedObjectSummary(
                                    objectID: row.object_id,
                                    kind: row.kind,
                                    title: row.title,
                                    revision: row.revision
                                )
                            )
                        }
                    }
                    guard collected.count <= SharedObjectsRules.objectLimit else {
                        throw APIError.invalidResponse
                    }
                    guard let nextOffset = reply.next_offset else {
                        break
                    }
                    guard nextOffset > offset && nextOffset < SharedObjectsRules.objectLimit else {
                        throw APIError.invalidResponse
                    }
                    offset = nextOffset
                    continue
                }
            }
            throw APIError.refused(status)
        }
        return collected
    }

    func readObject(
        workspaceID: UUID,
        objectID: String,
        expectedKind: SharedObjectKind
    ) async throws -> SharedObjectDetail {
        let (data, status) = try await postCommand(
            workspaceID: workspaceID,
            commandID: UUID(),
            command: HouseholdToolCommand(
                tool: "object_read",
                arguments: ObjectReadArgs(seat: Self.householdLocalSeat, object_id: objectID)
            )
        )
        guard status == 200 || status == 403,
              let reply = try? JSONDecoder().decode(ObjectReadReplyWire.self, from: data) else {
            throw APIError.refused(status)
        }
        if reply.status == "refused" {
            throw SharedObjectsError.refused(reason: reply.reason ?? "workspace_access_refused")
        }
        if status == 403, let err = reply.error, !err.isEmpty {
            throw SharedObjectsError.refused(reason: err)
        }
        guard status == 200,
              reply.status == "ok",
              let meta = reply.revision,
              let rawContent = reply.content else {
            throw APIError.refused(status)
        }
        guard meta.revision.isBound(workspaceID: workspaceID, objectID: objectID),
              rawContent.kind == expectedKind else {
            throw APIError.invalidResponse
        }

        let content: SharedContent
        switch rawContent.kind {
        case .list:
            guard let items = rawContent.items else { throw APIError.invalidResponse }
            content = .list(items)
        case .doc:
            guard let markdown = rawContent.markdown else { throw APIError.invalidResponse }
            content = .doc(markdown)
        case .file, .definition:
            throw APIError.invalidResponse
        }

        let wsFilter = "eq." + workspaceID.uuidString.lowercased()
        async let membersTask: [MemberProfileWire]? = try? await api.rows(
            "member_profiles",
            ["select": "user_id,display_name", "workspace_id": wsFilter]
        )
        async let agentsTask: [AgentPrincipalWire]? = try? await api.rows(
            "agent_principals",
            ["select": "principal_id,name", "workspace_id": wsFilter]
        )
        let members = await membersTask ?? []
        let agents = await agentsTask ?? []
        let userNames = Dictionary(uniqueKeysWithValues: members.compactMap { row -> (UUID, String)? in
            let trimmed = row.display_name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : (row.user_id, trimmed)
        })
        let agentNames = Dictionary(uniqueKeysWithValues: agents.compactMap { row -> (UUID, String)? in
            let trimmed = row.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : (row.principal_id, trimmed)
        })

        let viewerID = await MainActor.run { api.session.userID }
        let attribution = SharedObjectsRules.formatAttribution(
            meta.author,
            viewerID: viewerID,
            userNames: userNames,
            agentNames: agentNames
        )

        return SharedObjectDetail(
            objectID: objectID,
            kind: rawContent.kind,
            title: meta.title,
            revision: meta.revision,
            authorLabel: attribution.label,
            authorIsAgent: attribution.isAgent,
            occurredAtServerMs: meta.occurred_at_server,
            live: reply.live ?? true,
            content: content
        )
    }

    func updateList(
        workspaceID: UUID,
        objectID: String,
        base: SharedRevisionRef,
        operations: [SharedListPatchOp],
        requestID: UUID
    ) async -> SharedSaveOutcome {
        guard base.isBound(workspaceID: workspaceID, objectID: objectID), !operations.isEmpty else {
            return .refused(reason: "invalid_request", message: SharedObjectsRules.refusalMessage("invalid_request"))
        }
        do {
            let (data, status) = try await postCommand(
                workspaceID: workspaceID,
                commandID: requestID,
                command: HouseholdToolCommand(
                    tool: "object_update",
                    arguments: ObjectUpdateArgs(
                        seat: Self.householdLocalSeat,
                        request_id: requestID.uuidString.lowercased(),
                        object_id: objectID,
                        base: base,
                        patch: ListPatchBody(operations: operations)
                    )
                )
            )
            guard status == 200 || status == 403 || status == 409,
                  let reply = try? JSONDecoder().decode(ObjectUpdateReplyWire.self, from: data) else {
                return .unconfirmed(message: Self.unconfirmedMessage)
            }
            if reply.status == "committed",
               reply.object_id == objectID,
               let rev = reply.revision,
               rev.isBound(workspaceID: workspaceID, objectID: objectID) {
                return .committed(revision: rev)
            }
            if reply.status == "conflict",
               reply.object_id == objectID,
               let current = reply.current,
               current.isBound(workspaceID: workspaceID, objectID: objectID),
               let draftID = reply.draft_id, !draftID.isEmpty {
                return .conflict(current: current, draftID: draftID)
            }
            if reply.status == "refused" {
                let reason = reply.reason ?? "refused"
                return .refused(reason: reason, message: SharedObjectsRules.refusalMessage(reason))
            }
            if status == 403, let err = reply.error, !err.isEmpty {
                return .refused(reason: err, message: SharedObjectsRules.refusalMessage(err))
            }
            return .unconfirmed(message: Self.unconfirmedMessage)
        } catch {
            return .unconfirmed(message: Self.unconfirmedMessage)
        }
    }
}
