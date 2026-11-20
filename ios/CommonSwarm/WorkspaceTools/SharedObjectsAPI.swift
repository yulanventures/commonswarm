import Foundation

struct SharedObjectsAPI: Sendable {
    let api: ConversationAPI

    private static let householdLocalSeat = "seat_0000000000000000000000"
    private static let pageLimit = 100
    private static let historyPageLimit = 50
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

    private struct HouseholdDraftCommand: Encodable {
        let kind = "household_draft"
        let draft_id: String
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
        let revision: SharedRevisionRef?
    }

    private struct ObjectHistoryArgs: Encodable {
        let seat: String
        let object_id: String
        let offset: Int
        let limit: Int
    }

    private struct CreateContentBody: Encodable {
        let kind: String
        let items: [SharedListItem]?
        let markdown: String?

        init(_ content: SharedContent) {
            switch content {
            case .list(let items):
                self.kind = "list"
                self.items = items
                self.markdown = nil
            case .doc(let markdown):
                self.kind = "doc"
                self.items = nil
                self.markdown = markdown
            }
        }
    }

    private struct ObjectCreateArgs: Encodable {
        let seat: String
        let request_id: String
        let object_id: String
        let title: String
        let content: CreateContentBody
    }

    private struct ObjectUpdateArgs: Encodable {
        let seat: String
        let request_id: String
        let object_id: String
        let base: SharedRevisionRef
        let patch: SharedPatch
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

    private struct HistoryEntryWire: Decodable {
        let revision: SharedRevisionRef
        let title: String
        let kind: SharedObjectKind?
        let author: SharedAttribution
        let occurred_at_server: Int64
        let live: Bool?
    }

    private struct ObjectHistoryReplyWire: Decodable {
        let status: String?
        let reason: String?
        let error: String?
        let revisions: [HistoryEntryWire]?
        let next_offset: Int?
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

    private struct ObjectWriteReplyWire: Decodable {
        let status: String?
        let object_id: String?
        let revision: SharedRevisionRef?
        let current: SharedRevisionRef?
        let draft_id: String?
        let reason: String?
        let error: String?
    }

    private struct DraftSnapshotWire: Decodable {
        let revision: SharedRevisionRef
        let title: String
        let author: SharedAttribution
        let occurred_at_server: Int64
        let live: Bool?
        let content: ContentWire
    }

    private struct DraftReplyWire: Decodable {
        let status: String?
        let reason: String?
        let error: String?
        let workspace_id: String?
        let object_id: String?
        let draft_id: String?
        let owner_user_id: String?
        let proposed: ContentWire?
        let base: DraftSnapshotWire?
        let current: DraftSnapshotWire?
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

    private func loadAttributionContext(workspaceID: UUID) async -> (viewerID: UUID, userNames: [UUID: String], agentNames: [UUID: String]) {
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
        return (viewerID, userNames, agentNames)
    }

    private func decodeContent(_ wire: ContentWire, expectedKind: SharedObjectKind) throws -> SharedContent {
        guard wire.kind == expectedKind else {
            throw APIError.invalidResponse
        }
        switch wire.kind {
        case .list:
            guard let items = wire.items else { throw APIError.invalidResponse }
            return .list(items)
        case .doc:
            guard let markdown = wire.markdown else { throw APIError.invalidResponse }
            return .doc(markdown)
        case .file, .definition:
            throw APIError.invalidResponse
        }
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
        expectedKind: SharedObjectKind,
        revision: SharedRevisionRef? = nil
    ) async throws -> SharedObjectDetail {
        if let revision, !revision.isBound(workspaceID: workspaceID, objectID: objectID) {
            throw APIError.invalidResponse
        }
        let (data, status) = try await postCommand(
            workspaceID: workspaceID,
            commandID: UUID(),
            command: HouseholdToolCommand(
                tool: "object_read",
                arguments: ObjectReadArgs(
                    seat: Self.householdLocalSeat,
                    object_id: objectID,
                    revision: revision
                )
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
        guard meta.revision.isBound(workspaceID: workspaceID, objectID: objectID) else {
            throw APIError.invalidResponse
        }
        if let requested = revision, meta.revision.token != requested.token {
            throw APIError.invalidResponse
        }

        let content = try decodeContent(rawContent, expectedKind: expectedKind)
        let ctx = await loadAttributionContext(workspaceID: workspaceID)
        let attribution = SharedObjectsRules.formatAttribution(
            meta.author,
            viewerID: ctx.viewerID,
            userNames: ctx.userNames,
            agentNames: ctx.agentNames
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

    func readHistory(
        workspaceID: UUID,
        objectID: String,
        offset: Int = 0
    ) async throws -> (revisions: [SharedRevisionEntry], nextOffset: Int?) {
        let (data, status) = try await postCommand(
            workspaceID: workspaceID,
            commandID: UUID(),
            command: HouseholdToolCommand(
                tool: "object_history",
                arguments: ObjectHistoryArgs(
                    seat: Self.householdLocalSeat,
                    object_id: objectID,
                    offset: offset,
                    limit: Self.historyPageLimit
                )
            )
        )
        guard status == 200 || status == 403,
              let reply = try? JSONDecoder().decode(ObjectHistoryReplyWire.self, from: data) else {
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
              let rows = reply.revisions else {
            throw APIError.refused(status)
        }
        let ctx = await loadAttributionContext(workspaceID: workspaceID)
        var entries: [SharedRevisionEntry] = []
        for row in rows {
            guard row.revision.isBound(workspaceID: workspaceID, objectID: objectID) else {
                throw APIError.invalidResponse
            }
            let attribution = SharedObjectsRules.formatAttribution(
                row.author,
                viewerID: ctx.viewerID,
                userNames: ctx.userNames,
                agentNames: ctx.agentNames
            )
            entries.append(
                SharedRevisionEntry(
                    revision: row.revision,
                    title: row.title,
                    authorLabel: attribution.label,
                    authorIsAgent: attribution.isAgent,
                    occurredAtServerMs: row.occurred_at_server,
                    live: row.live ?? true
                )
            )
        }
        let nextOffset = reply.next_offset.flatMap { $0 > offset ? $0 : nil }
        return (entries, nextOffset)
    }

    func createObject(
        workspaceID: UUID,
        objectID: String,
        title: String,
        content: SharedContent,
        requestID: UUID
    ) async -> SharedSaveOutcome {
        do {
            let (data, status) = try await postCommand(
                workspaceID: workspaceID,
                commandID: requestID,
                command: HouseholdToolCommand(
                    tool: "object_create",
                    arguments: ObjectCreateArgs(
                        seat: Self.householdLocalSeat,
                        request_id: requestID.uuidString.lowercased(),
                        object_id: objectID,
                        title: title,
                        content: CreateContentBody(content)
                    )
                )
            )
            return decodeWriteOutcome(data: data, status: status, workspaceID: workspaceID, objectID: objectID)
        } catch {
            return .unconfirmed(message: Self.unconfirmedMessage)
        }
    }

    func updateObject(
        workspaceID: UUID,
        objectID: String,
        base: SharedRevisionRef,
        patch: SharedPatch,
        requestID: UUID
    ) async -> SharedSaveOutcome {
        guard base.isBound(workspaceID: workspaceID, objectID: objectID), !patch.isEmpty else {
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
                        patch: patch
                    )
                )
            )
            return decodeWriteOutcome(data: data, status: status, workspaceID: workspaceID, objectID: objectID)
        } catch {
            return .unconfirmed(message: Self.unconfirmedMessage)
        }
    }

    func recoverDraft(
        workspaceID: UUID,
        objectID: String,
        draftID: String,
        expectedKind: SharedObjectKind
    ) async throws -> SharedConflictDraft {
        let (data, status) = try await postCommand(
            workspaceID: workspaceID,
            commandID: UUID(),
            command: HouseholdDraftCommand(draft_id: draftID)
        )
        guard status == 200 || status == 403,
              let reply = try? JSONDecoder().decode(DraftReplyWire.self, from: data) else {
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
              let replyWorkspace = reply.workspace_id,
              replyWorkspace.lowercased() == workspaceID.uuidString.lowercased(),
              reply.object_id == objectID,
              reply.draft_id == draftID,
              let rawOwner = reply.owner_user_id,
              let ownerUUID = UUID(uuidString: rawOwner),
              let rawProposed = reply.proposed,
              let rawBase = reply.base,
              let rawCurrent = reply.current,
              rawBase.revision.isBound(workspaceID: workspaceID, objectID: objectID),
              rawCurrent.revision.isBound(workspaceID: workspaceID, objectID: objectID) else {
            throw APIError.invalidResponse
        }

        let ctx = await loadAttributionContext(workspaceID: workspaceID)
        guard ownerUUID == ctx.viewerID else {
            throw APIError.invalidResponse
        }

        let proposed = try decodeContent(rawProposed, expectedKind: expectedKind)
        let baseContent = try decodeContent(rawBase.content, expectedKind: expectedKind)
        let currentContent = try decodeContent(rawCurrent.content, expectedKind: expectedKind)

        let baseAttr = SharedObjectsRules.formatAttribution(
            rawBase.author,
            viewerID: ctx.viewerID,
            userNames: ctx.userNames,
            agentNames: ctx.agentNames
        )
        let currentAttr = SharedObjectsRules.formatAttribution(
            rawCurrent.author,
            viewerID: ctx.viewerID,
            userNames: ctx.userNames,
            agentNames: ctx.agentNames
        )

        let baseDetail = SharedObjectDetail(
            objectID: objectID,
            kind: expectedKind,
            title: rawBase.title,
            revision: rawBase.revision,
            authorLabel: baseAttr.label,
            authorIsAgent: baseAttr.isAgent,
            occurredAtServerMs: rawBase.occurred_at_server,
            live: rawBase.live ?? true,
            content: baseContent
        )
        let currentDetail = SharedObjectDetail(
            objectID: objectID,
            kind: expectedKind,
            title: rawCurrent.title,
            revision: rawCurrent.revision,
            authorLabel: currentAttr.label,
            authorIsAgent: currentAttr.isAgent,
            occurredAtServerMs: rawCurrent.occurred_at_server,
            live: rawCurrent.live ?? true,
            content: currentContent
        )

        return SharedConflictDraft(
            workspaceID: workspaceID,
            objectID: objectID,
            draftID: draftID,
            ownerUserID: ownerUUID,
            base: baseDetail,
            current: currentDetail,
            proposed: proposed
        )
    }

    private func decodeWriteOutcome(
        data: Data,
        status: Int,
        workspaceID: UUID,
        objectID: String
    ) -> SharedSaveOutcome {
        guard status == 200 || status == 403 || status == 409,
              let reply = try? JSONDecoder().decode(ObjectWriteReplyWire.self, from: data) else {
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
    }
}
