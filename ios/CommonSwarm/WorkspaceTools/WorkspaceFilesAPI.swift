import Foundation

struct WorkspaceFilesAPI: Sendable {
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

    private struct FileDownloadURLCommand: Encodable {
        let kind = "file_download_url"
        let file_id: String
        let version_n: Int
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

    private struct DownloadGrantReplyWire: Decodable {
        let status: String?
        let file_id: String?
        let version_n: Int?
        let size_bytes: Int?
        let download_path: String?
        let download_url_expires_in_seconds: Double?
        let content_warning: String?
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

    func listFiles(workspaceID: UUID) async throws -> [WorkspaceFileItem] {
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
        let (data, response) = try await api.session.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode else {
            throw APIError.invalidResponse
        }
        if status == 403 {
            throw WorkspaceFilesError.accessRefused
        }
        guard status == 200 else {
            throw APIError.refused(status)
        }
        let rows = try JSONDecoder().decode([FileRowWire].self, from: data)

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

        return rows.compactMap { row -> WorkspaceFileItem? in
            guard let fileID = row.file_id, !fileID.isEmpty,
                  let name = row.name, !name.isEmpty,
                  let version = row.current_version, version >= 1,
                  let sizeBytes = row.size_bytes, sizeBytes >= 0,
                  let committedAt = row.committed_at, !committedAt.isEmpty else {
                return nil
            }
            let kind: WorkspaceFileUploaderKind = row.uploaded_by_kind == "agent" ? .agent : .user
            let uploadedBy = row.uploaded_by ?? ""
            let uploaderLabel = WorkspaceFilesRules.formatUploader(
                kind: kind,
                id: uploadedBy,
                viewerID: viewerID,
                userNames: userNames,
                agentNames: agentNames
            )
            let tombstonedAt = row.tombstoned_at.flatMap { $0.isEmpty ? nil : $0 }
            return WorkspaceFileItem(
                fileID: fileID,
                name: name,
                currentVersion: version,
                sizeBytes: sizeBytes,
                uploadedByKind: kind,
                uploadedBy: uploadedBy,
                uploaderLabel: uploaderLabel,
                committedAt: committedAt,
                committedDate: WorkspaceFilesRules.parseISO8601(committedAt),
                tombstonedAt: tombstonedAt,
                tombstonedDate: tombstonedAt.flatMap { WorkspaceFilesRules.parseISO8601($0) }
            )
        }
    }

    func requestDownloadGrant(
        workspaceID: UUID,
        fileID: String,
        version: Int,
        expectedSizeBytes: Int64,
        commandID: UUID
    ) async throws -> WorkspaceFileDownloadGrant {
        let requestedAt = Date()
        var request = api.request("functions/v1/command")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let envelope = CommandEnvelope(
            command_id: commandID.uuidString.lowercased(),
            workspace_id: workspaceID.uuidString.lowercased(),
            command: FileDownloadURLCommand(file_id: fileID, version_n: version)
        )
        request.httpBody = try JSONEncoder().encode(envelope)
        let (data, response) = try await api.session.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode else {
            throw APIError.invalidResponse
        }
        let reply = try? JSONDecoder().decode(DownloadGrantReplyWire.self, from: data)
        let reason = reply?.reason ?? reply?.error ?? ""
        if status == 403 || reason == "workspace_access_refused" || reason == "forbidden" {
            throw WorkspaceFilesError.accessRefused
        }
        guard status == 200, reply?.status == "accepted" else {
            if !reason.isEmpty {
                throw WorkspaceFilesError.downloadRefused(reason: reason)
            }
            throw WorkspaceFilesError.downloadFailed(status: status)
        }
        if let grantedFileID = reply?.file_id, grantedFileID.lowercased() != fileID.lowercased() {
            throw WorkspaceFilesError.invalidDownloadPath
        }
        if let grantedVersion = reply?.version_n, grantedVersion != version {
            throw WorkspaceFilesError.invalidDownloadPath
        }
        let resolvedSize = reply?.size_bytes ?? Int(expectedSizeBytes)
        guard resolvedSize > 0, resolvedSize <= WorkspaceFilesRules.maxDownloadBytes else {
            throw WorkspaceFilesError.invalidDownloadPath
        }
        guard let downloadPath = reply?.download_path,
              let url = WorkspaceFilesRules.validatedDownloadURL(
                  downloadPath: downloadPath,
                  origin: api.origin,
                  workspaceID: workspaceID,
                  fileID: fileID,
                  version: version
              ) else {
            throw WorkspaceFilesError.invalidDownloadPath
        }
        let expiresAt: Date?
        if let seconds = reply?.download_url_expires_in_seconds, seconds.isFinite, seconds >= 0 {
            expiresAt = requestedAt.addingTimeInterval(seconds)
        } else {
            expiresAt = nil
        }
        let warning = (reply?.content_warning?.isEmpty == false)
            ? reply!.content_warning!
            : WorkspaceFilesRules.defaultContentWarning
        return WorkspaceFileDownloadGrant(
            url: url,
            sizeBytes: resolvedSize,
            contentWarning: warning,
            expiresAt: expiresAt
        )
    }

    /// Downloads file bytes through the login-scoped HumanSession transport (NoRedirect, cookies off,
    /// sign-out cancellation) and writes them with complete file protection in a per-download directory.
    func downloadProtectedFile(
        from url: URL,
        expectedSizeBytes: Int,
        fileName: String,
        fileID: String,
        version: Int
    ) async throws -> URL {
        guard expectedSizeBytes > 0, expectedSizeBytes <= WorkspaceFilesRules.maxDownloadBytes else {
            throw WorkspaceFilesError.invalidDownloadPath
        }

        let data: Data
        do {
            data = try await api.session.downloadStorage(url, size: expectedSizeBytes)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch APIError.invalidResponse {
            // HumanSession.downloadStorage throws APIError.invalidResponse for non-200 storage responses (e.g. expired 410/403).
            throw WorkspaceFilesError.linkExpired
        } catch {
            throw WorkspaceFilesError.downloadFailed(status: 0)
        }

        guard await MainActor.run(body: { api.session.isActive }) else {
            throw CancellationError()
        }
        try Task.checkCancellation()

        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("commonswarm-downloads", isDirectory: true)
            .appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        do {
            let safeName = WorkspaceFilesRules.sanitizedLocalFileName(fileName, fallbackID: "\(fileID)-v\(version)")
            let destination = folder.appendingPathComponent(safeName, isDirectory: false)
            try data.write(to: destination, options: [.atomic, .completeFileProtection])
            return destination
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
    }
}
