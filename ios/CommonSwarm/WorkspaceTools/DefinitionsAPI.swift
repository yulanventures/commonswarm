import Foundation

struct DefinitionsAPI: Sendable {
    let api: ConversationAPI
    var session: HumanSession { api.session }

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

    private struct AccessReplyWire: Decodable {
        let status: String?
        let reason: String?
        let error: String?
        let content_role: SharedContentRole?
        let operations: [String]?
    }

    private struct HouseholdToolCommand<Arguments: Encodable>: Encodable {
        let kind = "household_tool"
        let tool: String
        let arguments: Arguments
    }

    private struct CertifyCommand: Encodable {
        let kind = "household_definition_certify"
        let object_id: String
        let revision: SharedRevisionRef
    }

    private struct SearchArgs: Encodable {
        let seat: String
        let offset: Int
        let limit: Int
    }

    private struct ReadArgs: Encodable {
        let seat: String
        let object_id: String
    }

    private struct CreateArgs: Encodable {
        let seat: String
        let request_id: String
        let object_id: String
        let term: String
        let meaning: String
        let source: String
    }

    private struct FieldsWire: Codable {
        let term: String
        let meaning: String
        let source: String
    }

    private struct UpdateArgs: Encodable {
        let seat: String
        let request_id: String
        let object_id: String
        let base: SharedRevisionRef
        let before: FieldsWire
        let after: FieldsWire
    }

    private enum CertifiedByWire: Decodable {
        case userID(String)
        case object(userID: String?)

        init(from decoder: Decoder) throws {
            let single = try decoder.singleValueContainer()
            if let str = try? single.decode(String.self) {
                self = .userID(str)
                return
            }
            struct Obj: Decodable { let user_id: String? }
            let obj = try single.decode(Obj.self)
            self = .object(userID: obj.user_id)
        }

        var rawUserID: String? {
            switch self {
            case .userID(let id): id
            case .object(let id): id
            }
        }
    }

    private enum TimestampWire: Decodable {
        case millis(Int64)
        case iso(String)

        init(from decoder: Decoder) throws {
            let single = try decoder.singleValueContainer()
            if let num = try? single.decode(Int64.self) {
                self = .millis(num)
                return
            }
            if let dbl = try? single.decode(Double.self) {
                self = .millis(Int64(dbl))
                return
            }
            self = .iso(try single.decode(String.self))
        }

        var millis: Int64? {
            switch self {
            case .millis(let ms): ms
            case .iso(let str): DefinitionsRules.parseTimestampMs(string: str)
            }
        }
    }

    private struct SummaryCertificationObjectWire: Decodable {
        let revision: SharedRevisionRef?
    }

    private enum SummaryCertificationWire: Decodable {
        case state(String)
        case object(SummaryCertificationObjectWire)

        init(from decoder: Decoder) throws {
            let single = try decoder.singleValueContainer()
            if let str = try? single.decode(String.self) {
                self = .state(str)
                return
            }
            self = .object(try single.decode(SummaryCertificationObjectWire.self))
        }
    }

    private struct SummaryEntryWire: Decodable {
        let object_id: String
        let term: String
        let revision: SharedRevisionRef
        let certification: SummaryCertificationWire?
    }

    private struct SearchReplyWire: Decodable {
        let status: String?
        let reason: String?
        let error: String?
        let definitions: [SummaryEntryWire]?
        let next_offset: Int?
    }

    private struct VersionWire: Decodable {
        let revision: SharedRevisionRef
        let term: String
        let meaning: String
        let source: String
        let author: SharedAttribution
        let occurred_at_server: Int64
    }

    private struct CertifiedVersionWire: Decodable {
        let revision: SharedRevisionRef
        let term: String
        let meaning: String
        let source: String
        let certified_by: CertifiedByWire
        let certified_at: TimestampWire
    }

    private struct ReadReplyWire: Decodable {
        let status: String?
        let reason: String?
        let error: String?
        let object_id: String?
        let current: VersionWire?
        let certified: CertifiedVersionWire?
        let proposal_pending: Bool?
    }

    private struct WriteReplyWire: Decodable {
        let status: String?
        let object_id: String?
        let revision: SharedRevisionRef?
        let reason: String?
        let error: String?
    }

    private struct MemberProfileRow: Decodable {
        let user_id: UUID
        let display_name: String?
    }

    private struct AgentPrincipalRow: Decodable {
        let principal_id: UUID
        let name: String
    }

    private struct AttributionContext: Sendable {
        let viewerID: UUID
        let userNames: [UUID: String]
        let agentNames: [UUID: String]
    }

    private func postCommand<Command: Encodable>(
        workspaceID: UUID,
        commandID: UUID,
        command: Command
    ) async throws -> (Data, Int) {
        var req = URLRequest(url: api.origin.appending(path: "functions/v1/command"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(api.publicKey, forHTTPHeaderField: "apikey")
        let envelope = CommandEnvelope(
            command_id: commandID.uuidString.lowercased(),
            workspace_id: workspaceID.uuidString.lowercased(),
            command: command
        )
        req.httpBody = try JSONEncoder().encode(envelope)
        let (data, response) = try await api.session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return (data, status)
    }

    func access(workspaceID: UUID) async throws -> SharedAccessStatus {
        let (data, status) = try await postCommand(
            workspaceID: workspaceID,
            commandID: UUID(),
            command: HouseholdAccessCommand()
        )
        let reply = try? JSONDecoder().decode(AccessReplyWire.self, from: data)
        if status == 401 {
            return .refused(reason: "unauthorized")
        }
        if status == 404 {
            return .refused(reason: reply?.reason ?? reply?.error ?? "not_found")
        }
        if status == 403 {
            let reason = reply?.reason ?? reply?.error ?? "forbidden"
            if reason == "content_consent_required" {
                return .needsConfirmation(reason: reason)
            }
            return .refused(reason: reason)
        }
        guard status == 200, let reply else {
            throw APIError.refused(status)
        }
        if reply.status == "ok", let role = reply.content_role, let operations = reply.operations {
            return .granted(SharedAccess(role: role, operations: Set(operations)))
        }
        let reason = reply.reason ?? reply.error ?? "content_consent_required"
        if reason == "content_consent_required" {
            return .needsConfirmation(reason: reason)
        }
        return .refused(reason: reason)
    }

    func listDefinitions(workspaceID: UUID) async throws -> [DefinitionSummary] {
        var collected: [DefinitionSummary] = []
        var seenIDs = Set<String>()
        var offset = 0

        for _ in 0..<DefinitionsRules.maxListPages {
            let (data, status) = try await postCommand(
                workspaceID: workspaceID,
                commandID: UUID(),
                command: HouseholdToolCommand(
                    tool: "definitions_search",
                    arguments: SearchArgs(
                        seat: Self.householdLocalSeat,
                        offset: offset,
                        limit: Self.pageLimit
                    )
                )
            )
            let reply = try? JSONDecoder().decode(SearchReplyWire.self, from: data)
            if status == 401 {
                throw DefinitionsError.refused(reason: "unauthorized")
            }
            if status == 404 {
                throw DefinitionsError.refused(reason: reply?.reason ?? reply?.error ?? "not_found")
            }
            if status == 403 {
                throw DefinitionsError.refused(reason: reply?.reason ?? reply?.error ?? "forbidden")
            }
            guard status == 200 || status == 400, let reply else {
                throw APIError.refused(status)
            }
            if reply.status == "refused" {
                let reason = reply.reason ?? "workspace_access_refused"
                if reason == "unknown_tool" {
                    throw DefinitionsError.unsupported
                }
                throw DefinitionsError.refused(reason: reason)
            }
            guard status == 200, reply.status == "ok", let rows = reply.definitions else {
                throw APIError.invalidResponse
            }

            for row in rows {
                guard row.revision.isBound(workspaceID: workspaceID, objectID: row.object_id),
                      seenIDs.insert(row.object_id).inserted else {
                    continue
                }
                let status: DefinitionCertificationState
                switch row.certification {
                case .none:
                    status = .proposed
                case .some(.state(let raw)):
                    if raw == "certified" {
                        status = .certified
                    } else if raw == "proposal_pending" {
                        status = .proposalPending
                    } else {
                        status = .proposed
                    }
                case .some(.object(let certObj)):
                    if let certRev = certObj.revision,
                       certRev.isBound(workspaceID: workspaceID, objectID: row.object_id),
                       certRev.token == row.revision.token {
                        status = .certified
                    } else if certObj.revision != nil {
                        status = .proposalPending
                    } else {
                        status = .proposed
                    }
                }
                collected.append(
                    DefinitionSummary(
                        objectID: row.object_id,
                        term: row.term,
                        revision: row.revision,
                        status: status
                    )
                )
            }

            guard let nextOffset = reply.next_offset, nextOffset > offset else {
                break
            }
            offset = nextOffset
        }

        return collected
    }

    func readDefinition(workspaceID: UUID, objectID: String) async throws -> DefinitionDetail {
        let (data, status) = try await postCommand(
            workspaceID: workspaceID,
            commandID: UUID(),
            command: HouseholdToolCommand(
                tool: "definition_read",
                arguments: ReadArgs(
                    seat: Self.householdLocalSeat,
                    object_id: objectID
                )
            )
        )
        let reply = try? JSONDecoder().decode(ReadReplyWire.self, from: data)
        if status == 401 {
            throw DefinitionsError.refused(reason: "unauthorized")
        }
        if status == 404 {
            throw DefinitionsError.refused(reason: reply?.reason ?? reply?.error ?? "not_found")
        }
        if status == 403 {
            throw DefinitionsError.refused(reason: reply?.reason ?? reply?.error ?? "forbidden")
        }
        guard status == 200, let reply else {
            throw APIError.refused(status)
        }
        if reply.status == "refused" {
            throw DefinitionsError.refused(reason: reply.reason ?? "workspace_access_refused")
        }
        guard reply.status == "ok",
              (reply.object_id == nil || reply.object_id == objectID),
              let rawCurrent = reply.current,
              rawCurrent.revision.isBound(workspaceID: workspaceID, objectID: objectID) else {
            throw APIError.invalidResponse
        }

        let ctx = await loadAttributionContext(workspaceID: workspaceID)
        let author = SharedObjectsRules.formatAttribution(
            rawCurrent.author,
            viewerID: ctx.viewerID,
            userNames: ctx.userNames,
            agentNames: ctx.agentNames
        )
        let current = DefinitionVersion(
            revision: rawCurrent.revision,
            term: rawCurrent.term,
            meaning: rawCurrent.meaning,
            source: rawCurrent.source,
            authorLabel: author.label,
            authorIsAgent: author.isAgent,
            occurredAtServerMs: rawCurrent.occurred_at_server
        )

        var certified: DefinitionCertifiedVersion?
        if let rawCert = reply.certified {
            guard rawCert.revision.isBound(workspaceID: workspaceID, objectID: objectID) else {
                throw APIError.invalidResponse
            }
            let certLabel = formatCertifier(
                rawUserID: rawCert.certified_by.rawUserID,
                viewerID: ctx.viewerID,
                userNames: ctx.userNames
            )
            certified = DefinitionCertifiedVersion(
                revision: rawCert.revision,
                term: rawCert.term,
                meaning: rawCert.meaning,
                source: rawCert.source,
                certifiedByLabel: certLabel,
                certifiedAtMs: rawCert.certified_at.millis
            )
        }

        let proposalPending: Bool
        if let explicit = reply.proposal_pending {
            proposalPending = explicit
        } else {
            proposalPending = certified?.revision.token != current.revision.token
        }

        return DefinitionDetail(
            objectID: objectID,
            current: current,
            certified: certified,
            proposalPending: proposalPending
        )
    }

    func createDefinition(
        workspaceID: UUID,
        objectID: String,
        fields: DefinitionFields,
        requestID: UUID
    ) async -> DefinitionMutationOutcome {
        do {
            let (data, status) = try await postCommand(
                workspaceID: workspaceID,
                commandID: requestID,
                command: HouseholdToolCommand(
                    tool: "definition_create",
                    arguments: CreateArgs(
                        seat: Self.householdLocalSeat,
                        request_id: requestID.uuidString.lowercased(),
                        object_id: objectID,
                        term: fields.term,
                        meaning: fields.meaning,
                        source: fields.source
                    )
                )
            )
            return decodeWriteOutcome(data: data, status: status, workspaceID: workspaceID, expectedObjectID: objectID)
        } catch {
            return .unconfirmed(message: Self.unconfirmedMessage)
        }
    }

    func updateDefinition(
        workspaceID: UUID,
        objectID: String,
        base: SharedRevisionRef,
        before: DefinitionFields,
        after: DefinitionFields,
        requestID: UUID
    ) async -> DefinitionMutationOutcome {
        guard base.isBound(workspaceID: workspaceID, objectID: objectID) else {
            return .refused(reason: "invalid_request", message: DefinitionsRules.refusalMessage("invalid_request"))
        }
        do {
            let (data, status) = try await postCommand(
                workspaceID: workspaceID,
                commandID: requestID,
                command: HouseholdToolCommand(
                    tool: "definition_update",
                    arguments: UpdateArgs(
                        seat: Self.householdLocalSeat,
                        request_id: requestID.uuidString.lowercased(),
                        object_id: objectID,
                        base: base,
                        before: FieldsWire(term: before.term, meaning: before.meaning, source: before.source),
                        after: FieldsWire(term: after.term, meaning: after.meaning, source: after.source)
                    )
                )
            )
            return decodeWriteOutcome(data: data, status: status, workspaceID: workspaceID, expectedObjectID: objectID)
        } catch {
            return .unconfirmed(message: Self.unconfirmedMessage)
        }
    }

    func certifyDefinition(
        workspaceID: UUID,
        objectID: String,
        revision: SharedRevisionRef,
        requestID: UUID
    ) async -> DefinitionMutationOutcome {
        guard revision.isBound(workspaceID: workspaceID, objectID: objectID) else {
            return .refused(reason: "invalid_request", message: DefinitionsRules.refusalMessage("invalid_request"))
        }
        do {
            let (data, status) = try await postCommand(
                workspaceID: workspaceID,
                commandID: requestID,
                command: CertifyCommand(object_id: objectID, revision: revision)
            )
            return decodeWriteOutcome(
                data: data,
                status: status,
                workspaceID: workspaceID,
                expectedObjectID: objectID,
                fallbackMessage: "Couldn’t certify definition."
            )
        } catch {
            return .unconfirmed(message: Self.unconfirmedMessage)
        }
    }

    private func decodeWriteOutcome(
        data: Data,
        status: Int,
        workspaceID: UUID,
        expectedObjectID: String,
        fallbackMessage: String = "Couldn’t save definition."
    ) -> DefinitionMutationOutcome {
        let reply = try? JSONDecoder().decode(WriteReplyWire.self, from: data)
        if status == 401 {
            return .refused(reason: "unauthorized", message: DefinitionsRules.refusalMessage("unauthorized", fallback: fallbackMessage))
        }
        if status == 404 {
            let reason = reply?.reason ?? reply?.error ?? "not_found"
            return .refused(reason: reason, message: DefinitionsRules.refusalMessage(reason, fallback: fallbackMessage))
        }
        if status == 403 {
            let reason = reply?.reason ?? reply?.error ?? "forbidden"
            return .refused(reason: reason, message: DefinitionsRules.refusalMessage(reason, fallback: fallbackMessage))
        }
        guard status == 200 || status == 400 || status == 409, let reply else {
            return .unconfirmed(message: Self.unconfirmedMessage)
        }
        if reply.status == "committed",
           let replyObj = reply.object_id ?? Optional(expectedObjectID),
           replyObj == expectedObjectID,
           let rev = reply.revision,
           rev.isBound(workspaceID: workspaceID, objectID: replyObj) {
            return .committed(objectID: replyObj, revision: rev)
        }
        if reply.status == "conflict" {
            return .conflict(message: "Someone saved a newer version. Review it, then edit again.")
        }
        if reply.status == "refused" {
            let reason = reply.reason ?? "refused"
            return .refused(reason: reason, message: DefinitionsRules.refusalMessage(reason, fallback: fallbackMessage))
        }
        return .unconfirmed(message: Self.unconfirmedMessage)
    }

    private func loadAttributionContext(workspaceID: UUID) async -> AttributionContext {
        let viewerID = await MainActor.run { api.session.userID }
        let wsFilter = "eq.\(workspaceID.uuidString.lowercased())"
        async let membersFetch: [MemberProfileRow] = (try? await api.rows(
            "member_profiles",
            [
                "select": "user_id,display_name",
                "workspace_id": wsFilter,
            ]
        )) ?? []
        async let agentsFetch: [AgentPrincipalRow] = (try? await api.rows(
            "agent_principals",
            [
                "select": "principal_id,name",
                "workspace_id": wsFilter,
            ]
        )) ?? []

        let members = await membersFetch
        let agents = await agentsFetch

        var userNames: [UUID: String] = [:]
        for m in members {
            let trimmed = m.display_name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty {
                userNames[m.user_id] = trimmed
            }
        }
        var agentNames: [UUID: String] = [:]
        for a in agents {
            let trimmed = a.name.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                agentNames[a.principal_id] = trimmed
            }
        }
        return AttributionContext(viewerID: viewerID, userNames: userNames, agentNames: agentNames)
    }

    private func formatCertifier(
        rawUserID: String?,
        viewerID: UUID,
        userNames: [UUID: String]
    ) -> String {
        guard let rawUserID, !rawUserID.isEmpty else { return "Member" }
        if let uuid = UUID(uuidString: rawUserID) {
            if uuid == viewerID { return "You" }
            if let name = userNames[uuid] { return name }
        }
        return "Member"
    }
}
