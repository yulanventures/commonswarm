import Foundation

enum AnswerChoiceOutcome: Equatable, Sendable {
    case accepted
    case failed(message: String, retryable: Bool)
}

struct WaitingLoadSnapshot: Sendable {
    let items: [WaitingAskItem]
    let workspaceComplete: [UUID: Bool]
    let workspaceFailed: [UUID: Bool]
    let enumeratedAllWorkspaces: Bool
}

struct WaitingOnYouAPI: Sendable {
    let api: ConversationAPI

    private static let askChoicesBatchSize = 50
    private static let maxDecisionQueuePages = 20

    private struct DecisionAskWire: Decodable {
        struct Sender: Decodable {
            let kind: String
            let id: UUID
            let name: String?
        }
        let signal_id: UUID
        let from: Sender
        let body: String
        let created_at: String
        let until: String
    }

    private struct DecisionQueueWire: Decodable {
        let workspace_id: UUID
        let generated_at: String
        let total: Int
        let truncated: Bool
        let asks: [DecisionAskWire]
    }

    private struct AskChoicesWire: Decodable {
        let asks: [WaitingAskChoiceState]
    }

    private struct ChannelWire: Decodable {
        let channel_id: UUID
        let slug: String
    }

    private struct CommandStream: Encodable {
        let kind = "workspace"
    }

    private struct AnswerChoiceV1Command: Encodable {
        let kind = "answer_choice"
        let signal_id: String
        let option_id: String
    }

    private struct AnswerChoiceV2Command: Encodable {
        let kind = "answer_choice"
        let signal_id: String
        let option_ids: [String]?
        let other_text: String?

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(kind, forKey: .kind)
            try container.encode(signal_id, forKey: .signal_id)
            if let option_ids, !option_ids.isEmpty {
                try container.encode(option_ids, forKey: .option_ids)
            }
            if let other_text {
                try container.encode(other_text, forKey: .other_text)
            }
        }

        private enum CodingKeys: String, CodingKey {
            case kind, signal_id, option_ids, other_text
        }
    }

    private struct CommandEnvelope<Command: Encodable>: Encodable {
        let command_id: String
        let workspace_id: String
        let client_version = ConversationAPI.clientVersion
        let stream = CommandStream()
        let command: Command
    }

    private struct CommandReceiptWire: Decodable {
        let status: String?
        let error: String?
        let message: String?
    }

    private func rpc<Body: Encodable, Output: Decodable>(_ name: String, body: Body) async throws -> Output {
        var request = api.request("rest/v1/rpc/" + name)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("swarm_read", forHTTPHeaderField: "Content-Profile")
        request.setValue("swarm_read", forHTTPHeaderField: "Accept-Profile")
        request.httpBody = try JSONEncoder().encode(body)
        return try await api.send(request)
    }

    private func decisionQueue(workspaceID: UUID) async throws -> (asks: [DecisionAskWire], complete: Bool)? {
        struct FirstArgs: Encodable { let p_workspace_id: String }
        struct PageArgs: Encodable {
            let p_workspace_id: String
            let p_after_created_at: String
            let p_after_id: String
        }

        let wsID = workspaceID.uuidString.lowercased()
        let first: DecisionQueueWire? = try await rpc("decision_queue", body: FirstArgs(p_workspace_id: wsID))
        guard let first else { return nil }
        if !first.truncated && first.asks.count >= first.total {
            return (first.asks, true)
        }

        var asks = first.asks
        var seen = Set(asks.map(\.signal_id))
        var page = first
        var truncated = true
        var pages = 1

        while truncated && pages < Self.maxDecisionQueuePages, let last = page.asks.last {
            let fetched: DecisionQueueWire?? = try? await rpc(
                "decision_queue_page",
                body: PageArgs(
                    p_workspace_id: wsID,
                    p_after_created_at: last.created_at,
                    p_after_id: last.signal_id.uuidString.lowercased()
                )
            )
            guard let nextPage = fetched ?? nil else {
                break
            }
            var added = 0
            for ask in nextPage.asks where !seen.contains(ask.signal_id) {
                seen.insert(ask.signal_id)
                asks.append(ask)
                added += 1
            }
            page = nextPage
            pages += 1
            if !nextPage.truncated || nextPage.asks.isEmpty || added == 0 {
                truncated = nextPage.truncated
                break
            }
        }
        return (asks, !truncated)
    }

    private func askChoices(workspaceID: UUID, signalIDs: [UUID]) async throws -> [WaitingAskChoiceState] {
        struct Args: Encodable {
            let p_workspace_id: String
            let p_signal_ids: [String]
        }
        guard !signalIDs.isEmpty else { return [] }
        let wsID = workspaceID.uuidString.lowercased()
        var out: [WaitingAskChoiceState] = []
        var offset = 0
        while offset < signalIDs.count {
            let end = min(offset + Self.askChoicesBatchSize, signalIDs.count)
            let chunk = signalIDs[offset..<end].map { $0.uuidString.lowercased() }
            let wire: AskChoicesWire = try await rpc("ask_choices", body: Args(p_workspace_id: wsID, p_signal_ids: chunk))
            out.append(contentsOf: wire.asks)
            offset = end
        }
        return out
    }

    private func signalLocations(workspaceID: UUID, signalIDs: [UUID]) async throws -> [UUID: WaitingSignalPlacement] {
        guard !signalIDs.isEmpty else { return [:] }
        let wsFilter = "eq." + workspaceID.uuidString.lowercased()
        func fetchBatch(_ ids: [UUID]) async throws -> [WaitingSignalPlacement] {
            var rows: [WaitingSignalPlacement] = []
            var offset = 0
            while offset < ids.count {
                let end = min(offset + Self.askChoicesBatchSize, ids.count)
                let joined = ids[offset..<end].map { $0.uuidString.lowercased() }.joined(separator: ",")
                let batch: [WaitingSignalPlacement] = try await api.rows(
                    "signals",
                    [
                        "select": "id,channel_id,to,to_agent,thread_root_id,from,from_kind",
                        "workspace_id": wsFilter,
                        "id": "in.(\(joined))",
                    ]
                )
                rows.append(contentsOf: batch)
                offset = end
            }
            return rows
        }

        var map: [UUID: WaitingSignalPlacement] = [:]
        for row in try await fetchBatch(signalIDs) {
            map[row.id] = row
        }
        let missingRoots = Array(Set(map.values.compactMap { loc -> UUID? in
            guard loc.channel_id == nil, let rootID = loc.thread_root_id, map[rootID] == nil else { return nil }
            return rootID
        }))
        if !missingRoots.isEmpty {
            for row in try await fetchBatch(missingRoots) {
                map[row.id] = row
            }
        }
        return map
    }

    private func channelSlugs(workspaceID: UUID) async -> [UUID: String] {
        let filter = "eq." + workspaceID.uuidString.lowercased()
        guard let rows: [ChannelWire] = try? await api.rows(
            "channels",
            ["select": "channel_id,slug", "workspace_id": filter, "archived_at": "is.null"]
        ) else { return [:] }
        return Dictionary(uniqueKeysWithValues: rows.map { ($0.channel_id, "#" + $0.slug) })
    }

    private func loadWorkspace(_ workspace: Workspace) async -> WaitingWorkspaceLoad {
        do {
            guard let queue = try await decisionQueue(workspaceID: workspace.id) else {
                return WaitingWorkspaceLoad(workspaceID: workspace.id, items: [], complete: true, failed: false)
            }
            let ids = queue.asks.map(\.signal_id)
            if ids.isEmpty {
                return WaitingWorkspaceLoad(workspaceID: workspace.id, items: [], complete: queue.complete, failed: false)
            }

            async let choicesTask = askChoices(workspaceID: workspace.id, signalIDs: ids)
            async let locationsTask = signalLocations(workspaceID: workspace.id, signalIDs: ids)
            async let channelsTask = channelSlugs(workspaceID: workspace.id)

            let choicesList = try await choicesTask
            let locations: [UUID: WaitingSignalPlacement]
            let locationsFailed: Bool
            do {
                locations = try await locationsTask
                locationsFailed = false
            } catch {
                locations = [:]
                locationsFailed = true
            }
            let channels = await channelsTask

            let choicesByID = Dictionary(uniqueKeysWithValues: choicesList.map { ($0.signal_id, $0) })
            var items: [WaitingAskItem] = []
            var anyUnknownLocation = false
            for ask in queue.asks {
                guard let choiceState = choicesByID[ask.signal_id],
                      choiceState.answer == nil,
                      (2...6).contains(choiceState.options.count) else { continue }
                let loc = locations[ask.signal_id]
                let root = loc?.thread_root_id.flatMap { locations[$0] }
                let conversation = WaitingChoiceRules.classifyConversation(loc, root: root)
                if conversation == .unknown {
                    anyUnknownLocation = true
                }
                let fromKind: WaitingPartnerKind = ask.from.kind == "agent" ? .agent : .person
                let senderName = ask.from.name?.trimmingCharacters(in: .whitespacesAndNewlines)
                let displayName = (senderName?.isEmpty == false) ? senderName! : (fromKind == .agent ? "Agent" : "Member")
                let channelLabel: String
                switch conversation {
                case .channel(let channelID):
                    channelLabel = channels[channelID] ?? "#channel"
                case .general:
                    channelLabel = "#general"
                case .dm:
                    channelLabel = displayName
                case .group, .unknown:
                    channelLabel = ""
                }
                items.append(WaitingAskItem(
                    id: ask.signal_id,
                    workspaceID: workspace.id,
                    workspaceName: workspace.name,
                    conversation: conversation,
                    channelLabel: channelLabel,
                    fromKind: fromKind,
                    fromID: ask.from.id,
                    fromName: displayName,
                    body: ask.body,
                    createdAt: ask.created_at,
                    until: ask.until,
                    multi: choiceState.isMulti,
                    options: choiceState.options
                ))
            }
            let failed = locationsFailed || anyUnknownLocation
            return WaitingWorkspaceLoad(
                workspaceID: workspace.id,
                items: items,
                complete: queue.complete && !failed,
                failed: failed
            )
        } catch {
            return WaitingWorkspaceLoad(workspaceID: workspace.id, items: [], complete: false, failed: true)
        }
    }

    func loadAll(currentWorkspaceID: UUID, currentWorkspaceName: String) async -> WaitingLoadSnapshot {
        let workspaces: [Workspace]
        let enumeratedAll: Bool
        if let fetched = try? await api.workspaces(), !fetched.isEmpty {
            workspaces = fetched
            enumeratedAll = true
        } else {
            workspaces = [Workspace(workspace_id: currentWorkspaceID, name: currentWorkspaceName)]
            enumeratedAll = false
        }

        let results = await withTaskGroup(of: WaitingWorkspaceLoad.self, returning: [WaitingWorkspaceLoad].self) { group in
            for ws in workspaces {
                group.addTask { await loadWorkspace(ws) }
            }
            var collected: [WaitingWorkspaceLoad] = []
            for await result in group {
                collected.append(result)
            }
            return collected
        }

        let orderIndex = Dictionary(uniqueKeysWithValues: workspaces.enumerated().map { ($0.element.id, $0.offset) })
        let sortedResults = results.sorted { (orderIndex[$0.workspaceID] ?? .max) < (orderIndex[$1.workspaceID] ?? .max) }
        var allItems: [WaitingAskItem] = []
        var completeMap: [UUID: Bool] = [:]
        var failedMap: [UUID: Bool] = [:]
        for result in sortedResults {
            allItems.append(contentsOf: result.items)
            completeMap[result.workspaceID] = result.complete
            failedMap[result.workspaceID] = result.failed
        }
        return WaitingLoadSnapshot(
            items: allItems,
            workspaceComplete: completeMap,
            workspaceFailed: failedMap,
            enumeratedAllWorkspaces: enumeratedAll
        )
    }

    func answerChoice(
        commandID: UUID,
        workspaceID: UUID,
        signalID: UUID,
        multi: Bool,
        submission: WaitingChoiceSubmission
    ) async -> AnswerChoiceOutcome {
        let useV1 = !multi && submission.otherText == nil && submission.optionIds.count == 1
        var request = api.request("functions/v1/command")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            if useV1, let optionID = submission.optionIds.first {
                let envelope = CommandEnvelope(
                    command_id: commandID.uuidString.lowercased(),
                    workspace_id: workspaceID.uuidString.lowercased(),
                    command: AnswerChoiceV1Command(
                        signal_id: signalID.uuidString.lowercased(),
                        option_id: optionID
                    )
                )
                request.httpBody = try JSONEncoder().encode(envelope)
            } else {
                let envelope = CommandEnvelope(
                    command_id: commandID.uuidString.lowercased(),
                    workspace_id: workspaceID.uuidString.lowercased(),
                    command: AnswerChoiceV2Command(
                        signal_id: signalID.uuidString.lowercased(),
                        option_ids: submission.optionIds.isEmpty ? nil : submission.optionIds,
                        other_text: submission.otherText
                    )
                )
                request.httpBody = try JSONEncoder().encode(envelope)
            }
            let (data, response) = try await api.session.data(for: request)
            guard let status = (response as? HTTPURLResponse)?.statusCode else {
                return .failed(message: WaitingChoiceRules.answerFailedMessage, retryable: true)
            }
            let receipt = try? JSONDecoder().decode(CommandReceiptWire.self, from: data)
            if status == 200 && receipt?.status == "accepted" {
                return .accepted
            }
            if status == 400 && (receipt?.error == "invalid_request" || receipt?.error == nil) {
                let msg = useV1 ? WaitingChoiceRules.answerFailedMessage : WaitingChoiceRules.answerUnsupportedMessage
                return .failed(message: msg, retryable: useV1)
            }
            let message = (receipt?.message?.isEmpty == false) ? receipt!.message! : WaitingChoiceRules.answerFailedMessage
            return .failed(message: message, retryable: status >= 500 || status == 408 || status == 429)
        } catch {
            return .failed(message: WaitingChoiceRules.answerFailedMessage, retryable: true)
        }
    }
}
