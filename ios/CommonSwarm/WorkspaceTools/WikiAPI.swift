import Foundation

enum WikiAccessStatus: Equatable, Sendable {
    case granted(WikiAccess)
    case refused(reason: String)
    case unavailable
}

private final class WikiUploadNoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

struct WikiAPI: Sendable {
    let api: ConversationAPI

    var session: HumanSession { api.session }

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

    private struct FileDownloadURLCommand: Encodable {
        let kind = "file_download_url"
        let file_id: String
        let version_n: Int
    }

    private struct FileVersionCreateCommand: Encodable {
        let kind = "file_version_create"
        let file_id: String
        let version_id: String
        let name: String
        let content_type: String
        let declared_size_bytes: Int
        let if_version: Int
    }

    private struct FileVersionCommitCommand: Encodable {
        let kind = "file_version_commit"
        let file_id: String
        let version_id: String
        let sha256: String
    }

    private struct AccessReplyWire: Decodable {
        let status: String?
        let reason: String?
        let error: String?
        let operations: [String]?
    }

    private struct FileRowWire: Decodable {
        let file_id: String?
        let name: String?
        let current_version: Int?
        let size_bytes: Int64?
        let uploaded_by_kind: String?
        let uploaded_by: String?
        let committed_at: String?
        let tombstoned_at: String?
    }

    private struct MemberProfileWire: Decodable {
        let user_id: UUID
        let display_name: String?
    }

    private struct AgentPrincipalWire: Decodable {
        let principal_id: UUID
        let name: String?
    }

    private struct DownloadGrantReplyWire: Decodable {
        let status: String?
        let file_id: String?
        let version_n: Int?
        let version_state: String?
        let size_bytes: Int?
        let download_path: String?
        let reason: String?
        let error: String?
    }

    private struct VersionCreateReplyWire: Decodable {
        let status: String?
        let file_id: String?
        let version_id: String?
        let version_n: Int?
        let upload_path: String?
        let reason: String?
        let error: String?
        let current_version: Int?
    }

    private struct VersionCommitReplyWire: Decodable {
        let status: String?
        let file_id: String?
        let version_n: Int?
        let size_bytes: Int?
        let replayed: Bool?
        let reason: String?
        let error: String?
        let current_version: Int?
    }

    private struct RefusalProbeWire: Decodable {
        let status: String?
        let reason: String?
        let error: String?
        let current_version: Int?
    }

    private func gatedRows<T: Decodable>(
        _ table: String,
        _ query: [String: String],
        canDispatch: @escaping @MainActor @Sendable () -> Bool
    ) async throws -> [T] {
        var req = api.request("rest/v1/" + table, query)
        req.setValue("swarm_read", forHTTPHeaderField: "Accept-Profile")
        return try await api.send(req, canDispatch: canDispatch)
    }

    private func postCommand<Command: Encodable>(
        workspaceID: UUID,
        commandID: UUID,
        command: Command,
        canDispatch: @escaping @MainActor @Sendable () -> Bool
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
        let (data, response) = try await api.session.data(for: request, canDispatch: canDispatch)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return (data, status)
    }

    func access(
        workspaceID: UUID,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async throws -> WikiAccessStatus {
        let (data, status) = try await postCommand(
            workspaceID: workspaceID,
            commandID: UUID(),
            command: HouseholdAccessCommand(),
            canDispatch: canDispatch
        )
        let wire = try? JSONDecoder().decode(AccessReplyWire.self, from: data)
        if status == 401 { return .refused(reason: "unauthorized") }
        if status == 403 { return .refused(reason: wire?.reason ?? wire?.error ?? "forbidden") }
        if status == 404 { return .refused(reason: wire?.reason ?? wire?.error ?? "workspace_not_found") }
        if status == 400 { return .unavailable }
        guard status == 200, let wire else {
            throw WikiError.failed(status: status)
        }
        if wire.status == "ok", let ops = wire.operations {
            let opSet = Set(ops)
            return .granted(
                WikiAccess(
                    canRead: opSet.contains("read"),
                    canCreate: opSet.contains("read") && opSet.contains("create"),
                    canUpdate: opSet.contains("read") && opSet.contains("update")
                )
            )
        }
        if wire.status == "refused" {
            return .refused(reason: wire.reason ?? "workspace_access_refused")
        }
        return .unavailable
    }

    func listTopics(
        workspaceID: UUID,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async throws -> [WikiTopic] {
        let wsFilter = "eq." + workspaceID.uuidString.lowercased()
        var request = api.request(
            "rest/v1/files",
            [
                "select": "file_id,name,current_version,size_bytes,uploaded_by_kind,uploaded_by,committed_at,tombstoned_at",
                "workspace_id": wsFilter,
                "current_version": "gt.0",
                "order": "name.asc",
                "limit": String(WorkspaceFilesRules.maxFileLimit),
            ]
        )
        request.setValue("swarm_read", forHTTPHeaderField: "Accept-Profile")
        let (data, response) = try await api.session.data(for: request, canDispatch: canDispatch)
        guard let status = (response as? HTTPURLResponse)?.statusCode else {
            throw WikiError.failed(status: 0)
        }
        if status == 401 { throw WikiError.refused("unauthorized") }
        if status == 403 {
            let probe = try? JSONDecoder().decode(RefusalProbeWire.self, from: data)
            throw WikiError.refused(probe?.reason ?? probe?.error ?? "forbidden")
        }
        if status == 404 {
            let probe = try? JSONDecoder().decode(RefusalProbeWire.self, from: data)
            throw WikiError.refused(probe?.reason ?? probe?.error ?? "workspace_not_found")
        }
        guard status == 200 else {
            throw WikiError.failed(status: status)
        }
        let rows = try JSONDecoder().decode([FileRowWire].self, from: data)

        async let membersTask: [MemberProfileWire]? = try? await gatedRows(
            "member_profiles",
            ["select": "user_id,display_name", "workspace_id": wsFilter],
            canDispatch: canDispatch
        )
        async let agentsTask: [AgentPrincipalWire]? = try? await gatedRows(
            "agent_principals",
            ["select": "principal_id,name", "workspace_id": wsFilter],
            canDispatch: canDispatch
        )
        let members = await membersTask ?? []
        let agents = await agentsTask ?? []
        let userNames = Dictionary(
            members.compactMap { row -> (UUID, String)? in
                let trimmed = row.display_name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return trimmed.isEmpty ? nil : (row.user_id, trimmed)
            },
            uniquingKeysWith: { first, _ in first }
        )
        let agentNames = Dictionary(
            agents.compactMap { row -> (UUID, String)? in
                let trimmed = row.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return trimmed.isEmpty ? nil : (row.principal_id, trimmed)
            },
            uniquingKeysWith: { first, _ in first }
        )
        let viewerID = await MainActor.run { api.session.userID }

        return rows.compactMap { row -> WikiTopic? in
            guard row.tombstoned_at == nil || row.tombstoned_at?.isEmpty == true,
                  let rawFileID = row.file_id, let fileID = UUID(uuidString: rawFileID),
                  let name = row.name, let topic = WikiRules.topicFromFileName(name),
                  let version = row.current_version, version >= 1,
                  let sizeBytes = row.size_bytes, sizeBytes >= 0,
                  let committedAt = row.committed_at, !committedAt.isEmpty else {
                return nil
            }
            let kind: WorkspaceFileUploaderKind = row.uploaded_by_kind == "agent" ? .agent : .user
            let uploadedBy = row.uploaded_by ?? ""
            let updaterLabel = WorkspaceFilesRules.formatUploader(
                kind: kind,
                id: uploadedBy,
                viewerID: viewerID,
                userNames: userNames,
                agentNames: agentNames
            )
            return WikiTopic(
                fileID: fileID,
                name: name,
                topic: topic,
                currentVersion: version,
                sizeBytes: sizeBytes,
                uploadedByKind: kind,
                uploadedBy: uploadedBy,
                updaterLabel: updaterLabel,
                committedAt: committedAt,
                committedDate: WorkspaceFilesRules.parseISO8601(committedAt)
            )
        }
        .sorted { $0.topic.localizedStandardCompare($1.topic) == .orderedAscending }
    }

    func readTopicContent(
        workspaceID: UUID,
        fileID: UUID,
        version: Int,
        expectedSizeBytes: Int64,
        canDispatch: @escaping @MainActor @Sendable () -> Bool = { true }
    ) async throws -> WikiReadContentResult {
        let (data, status) = try await postCommand(
            workspaceID: workspaceID,
            commandID: UUID(),
            command: FileDownloadURLCommand(file_id: fileID.uuidString.lowercased(), version_n: version),
            canDispatch: canDispatch
        )
        let reply = try? JSONDecoder().decode(DownloadGrantReplyWire.self, from: data)
        if status == 401 { throw WikiError.refused("unauthorized") }
        if status == 403 { throw WikiError.refused(reply?.reason ?? reply?.error ?? "forbidden") }
        if status == 404 { throw WikiError.notFound }
        if status == 409 {
            let reason = reply?.reason ?? reply?.error ?? "file_tombstoned"
            throw WikiError.refused(reason)
        }
        guard status == 200, reply?.status == "accepted" else {
            if let reason = reply?.reason ?? reply?.error, !reason.isEmpty {
                throw WikiError.refused(reason)
            }
            throw WikiError.failed(status: status)
        }
        if let grantedFileID = reply?.file_id, grantedFileID.lowercased() != fileID.uuidString.lowercased() {
            throw WikiError.invalidDownloadPath
        }
        if let grantedVersion = reply?.version_n, grantedVersion != version {
            throw WikiError.invalidDownloadPath
        }
        let resolvedSize = reply?.size_bytes ?? Int(expectedSizeBytes)
        guard resolvedSize > 0, resolvedSize <= WikiRules.maxMarkdownBytes else {
            throw WikiError.invalidDownloadPath
        }
        guard let downloadPath = reply?.download_path,
              let url = WorkspaceFilesRules.validatedDownloadURL(
                  downloadPath: downloadPath,
                  origin: api.origin,
                  workspaceID: workspaceID,
                  fileID: fileID.uuidString.lowercased(),
                  version: version
              ) else {
            throw WikiError.invalidDownloadPath
        }
        guard await canDispatch() else { throw CancellationError() }

        let bytes: Data
        do {
            bytes = try await api.session.downloadStorage(url, size: resolvedSize)
        } catch is CancellationError {
            throw CancellationError()
        } catch APIError.invalidResponse {
            throw WikiError.linkExpired
        } catch {
            throw WikiError.failed(status: 0)
        }
        guard let markdown = String(data: bytes, encoding: .utf8) else {
            throw WikiError.invalidEncoding
        }
        return .loaded(markdown: markdown, version: version, versionState: reply?.version_state)
    }

    func saveTopicVersion(
        workspaceID: UUID,
        fileID: UUID,
        fileName: String,
        ifVersion: Int,
        markdown: String,
        versionID: UUID,
        createCommandID: UUID,
        commitCommandID: UUID,
        existingSlot: WikiUploadSlot?,
        alreadyUploaded: Bool,
        canDispatch: @escaping @MainActor @Sendable () -> Bool
    ) async -> WikiSaveOutcome {
        let unconfirmedMessage = "The wiki page save could not be confirmed. Retry unchanged to check."
        let bytes = Data(markdown.utf8)
        guard !bytes.isEmpty, bytes.count <= WikiRules.maxMarkdownBytes else {
            return .refused(reason: "invalid_size", message: "A wiki page must be between 1 byte and 25 MiB.")
        }
        let digest = WikiRules.sha256Hex(bytes)

        var resolvedSlot = existingSlot
        var uploaded = alreadyUploaded

        // Step 1: file_version_create (idempotent on createCommandID, compare-and-set on if_version)
        if resolvedSlot == nil {
            do {
                let (data, status) = try await postCommand(
                    workspaceID: workspaceID,
                    commandID: createCommandID,
                    command: FileVersionCreateCommand(
                        file_id: fileID.uuidString.lowercased(),
                        version_id: versionID.uuidString.lowercased(),
                        name: fileName,
                        content_type: "text/markdown",
                        declared_size_bytes: bytes.count,
                        if_version: ifVersion
                    ),
                    canDispatch: canDispatch
                )
                let reply = try? JSONDecoder().decode(VersionCreateReplyWire.self, from: data)
                if status >= 500 || status == 0 {
                    return .unconfirmed(message: unconfirmedMessage, slot: nil, uploaded: false)
                }
                if status == 401 {
                    return .refused(reason: "unauthorized", message: WikiRules.refusalMessage("unauthorized"))
                }
                if status == 403 {
                    let reason = reply?.reason ?? reply?.error ?? "forbidden"
                    return .refused(reason: reason, message: WikiRules.refusalMessage(reason))
                }
                if status == 404 {
                    let reason = reply?.reason ?? reply?.error ?? "file_not_found"
                    return .refused(reason: reason, message: WikiRules.refusalMessage(reason))
                }
                if status == 409 {
                    let reason = reply?.reason ?? reply?.error ?? "conflict"
                    if reason == "file_version_precondition_failed" {
                        return .conflict(currentVersion: reply?.current_version, message: WikiRules.refusalMessage(reason))
                    }
                    return .refused(reason: reason, message: WikiRules.refusalMessage(reason))
                }
                guard status == 200,
                      let reply,
                      reply.status == "accepted",
                      let rawSlotFileID = reply.file_id, let slotFileID = UUID(uuidString: rawSlotFileID),
                      let rawSlotVersionID = reply.version_id, let slotVersionID = UUID(uuidString: rawSlotVersionID),
                      slotVersionID == versionID,
                      let versionN = reply.version_n, versionN > 0,
                      let uploadPath = reply.upload_path,
                      WikiRules.validatedUploadURL(
                          uploadPath: uploadPath,
                          origin: api.origin,
                          workspaceID: workspaceID,
                          fileID: slotFileID,
                          version: versionN
                      ) != nil else {
                    if let reason = reply?.reason ?? reply?.error, !reason.isEmpty {
                        return .refused(reason: reason, message: WikiRules.refusalMessage(reason))
                    }
                    return .unconfirmed(message: unconfirmedMessage, slot: nil, uploaded: false)
                }
                resolvedSlot = WikiUploadSlot(fileID: slotFileID, versionID: slotVersionID, versionN: versionN, uploadPath: uploadPath)
            } catch is CancellationError {
                return .cancelled
            } catch {
                return .unconfirmed(message: unconfirmedMessage, slot: nil, uploaded: false)
            }
        }

        guard let slot = resolvedSlot else {
            return .unconfirmed(message: unconfirmedMessage, slot: nil, uploaded: false)
        }

        // Step 2: PUT bytes to validated signed upload path via HumanSession.putStorage
        if !uploaded {
            guard await canDispatch() else { return .cancelled }
            guard let uploadURL = WikiRules.validatedUploadURL(
                uploadPath: slot.uploadPath,
                origin: api.origin,
                workspaceID: workspaceID,
                fileID: slot.fileID,
                version: slot.versionN
            ) else {
                return .refused(reason: "invalid_upload_path", message: "The upload target could not be verified.")
            }
            let tempURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("commonswarm-wiki-upload-\(UUID().uuidString.lowercased()).md")
            do {
                try bytes.write(to: tempURL, options: [.atomic, .completeFileProtection])
            } catch {
                return .unconfirmed(message: unconfirmedMessage, slot: slot, uploaded: false)
            }
            defer { try? FileManager.default.removeItem(at: tempURL) }

            var putReq = URLRequest(url: uploadURL)
            putReq.httpMethod = "PUT"
            putReq.httpShouldHandleCookies = false
            putReq.setValue("text/markdown", forHTTPHeaderField: "Content-Type")

            do {
                let putStatus = try await api.session.putStorage(
                    putReq,
                    from: tempURL,
                    delegate: WikiUploadNoRedirectDelegate()
                )
                if (200..<300).contains(putStatus) {
                    uploaded = true
                } else if putStatus == 401 {
                    return .refused(reason: "unauthorized", message: WikiRules.refusalMessage("unauthorized"))
                } else if putStatus == 403 {
                    return .refused(reason: "forbidden", message: WikiRules.refusalMessage("forbidden"))
                } else {
                    return .unconfirmed(message: unconfirmedMessage, slot: slot, uploaded: false)
                }
            } catch is CancellationError {
                return .cancelled
            } catch {
                return .unconfirmed(message: unconfirmedMessage, slot: slot, uploaded: false)
            }
        }

        // Step 3: file_version_commit (idempotent on commitCommandID, SHA-256 verified)
        do {
            let (data, status) = try await postCommand(
                workspaceID: workspaceID,
                commandID: commitCommandID,
                command: FileVersionCommitCommand(
                    file_id: slot.fileID.uuidString.lowercased(),
                    version_id: slot.versionID.uuidString.lowercased(),
                    sha256: digest
                ),
                canDispatch: canDispatch
            )
            let reply = try? JSONDecoder().decode(VersionCommitReplyWire.self, from: data)
            if status >= 500 || status == 0 {
                return .unconfirmed(message: unconfirmedMessage, slot: slot, uploaded: uploaded)
            }
            if status == 401 {
                return .refused(reason: "unauthorized", message: WikiRules.refusalMessage("unauthorized"))
            }
            if status == 403 {
                let reason = reply?.reason ?? reply?.error ?? "forbidden"
                return .refused(reason: reason, message: WikiRules.refusalMessage(reason))
            }
            if status == 404 {
                let reason = reply?.reason ?? reply?.error ?? "file_not_found"
                return .refused(reason: reason, message: WikiRules.refusalMessage(reason))
            }
            if status == 409 {
                let reason = reply?.reason ?? reply?.error ?? "conflict"
                if reason == "file_version_precondition_failed" {
                    return .conflict(currentVersion: reply?.current_version, message: WikiRules.refusalMessage(reason))
                }
                return .refused(reason: reason, message: WikiRules.refusalMessage(reason))
            }
            guard status == 200,
                  let reply,
                  reply.status == "accepted",
                  let rawFileID = reply.file_id, let committedFileID = UUID(uuidString: rawFileID),
                  let committedVersion = reply.version_n, committedVersion >= 1 else {
                if let reason = reply?.reason ?? reply?.error, !reason.isEmpty {
                    return .refused(reason: reason, message: WikiRules.refusalMessage(reason))
                }
                return .unconfirmed(message: unconfirmedMessage, slot: slot, uploaded: uploaded)
            }
            return .committed(
                fileID: committedFileID,
                version: committedVersion,
                sizeBytes: reply.size_bytes ?? bytes.count,
                replayed: reply.replayed == true
            )
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .unconfirmed(message: unconfirmedMessage, slot: slot, uploaded: uploaded)
        }
    }
}
