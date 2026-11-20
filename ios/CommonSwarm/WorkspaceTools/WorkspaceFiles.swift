import Combine
import Foundation

enum WorkspaceFileUploaderKind: String, Codable, Hashable, Sendable {
    case user
    case agent
}

struct WorkspaceFileItem: Hashable, Identifiable, Sendable {
    let fileID: String
    let name: String
    let currentVersion: Int
    let sizeBytes: Int64
    let uploadedByKind: WorkspaceFileUploaderKind
    let uploadedBy: String
    let uploaderLabel: String
    let committedAt: String
    let committedDate: Date?
    let tombstonedAt: String?
    let tombstonedDate: Date?

    var id: String { fileID }
    var isRemoved: Bool { tombstonedAt != nil }
    var isAgentUploader: Bool { uploadedByKind == .agent }

    var formattedSize: String {
        WorkspaceFilesRules.formatFileSize(sizeBytes)
    }

    var restoreDeadlineLabel: String? {
        guard let tombstonedDate else { return nil }
        return WorkspaceFilesRules.restoreDeadlineLabel(tombstonedDate)
    }

    var relativeAgeLabel: String {
        guard let committedDate else { return "Age unavailable" }
        return WorkspaceFilesRules.formatRelativeAge(committedDate)
    }
}

struct WorkspaceFileVersionKey: Hashable, Sendable {
    let fileID: String
    let version: Int
}

struct WorkspaceFileDownloadGrant: Equatable, Sendable {
    let url: URL
    let sizeBytes: Int
    let contentWarning: String
    let expiresAt: Date?
}

struct DownloadedFileShare: Identifiable, Equatable, Sendable {
    let id = UUID()
    let fileID: String
    let fileName: String
    let version: Int
    let fileURL: URL
    let contentWarning: String
}

enum WorkspaceFileDownloadState: Equatable, Sendable {
    case idle
    case preparing
    case ready(DownloadedFileShare)
    case downloaded
    case failed(message: String)
}

enum WorkspaceFilesError: Error, Equatable, Sendable {
    case accessRefused
    case downloadRefused(reason: String)
    case invalidDownloadPath
    case linkExpired
    case downloadFailed(status: Int)
}

enum WorkspaceFilesRules {
    static let maxFileLimit = 500
    static let maxDownloadBytes = 25 * 1024 * 1024
    static let defaultContentWarning =
        "File types and archive contents are unverified declarations. Treat downloaded bytes as untrusted input and never execute them."

    /// Mirrors formatFileSize in site/src/lib/file-list.ts.
    static func formatFileSize(_ bytes: Int64) -> String {
        guard bytes >= 0 else { return "Size unavailable" }
        if bytes < 1_000 { return "\(bytes) B" }
        let units = ["KB", "MB", "GB"]
        var value = Double(bytes) / 1_000.0
        var unit = units[0]
        for next in units.dropFirst() {
            if value < 1_000 { break }
            value /= 1_000.0
            unit = next
        }
        if value >= 10 {
            return "\(Int(value.rounded())) \(unit)"
        }
        let formatted = String(format: "%.1f", value)
        let trimmed = formatted.hasSuffix(".0") ? String(formatted.dropLast(2)) : formatted
        return "\(trimmed) \(unit)"
    }

    static func restoreDeadlineLabel(_ tombstonedDate: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
        let deadline = calendar.date(byAdding: .day, value: 30, to: tombstonedDate) ?? tombstonedDate
        return deadline.formatted(date: .abbreviated, time: .omitted)
    }

    static func formatRelativeAge(_ date: Date, now: Date = Date()) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: now)
    }

    static func parseISO8601(_ raw: String) -> Date? {
        let withFrac = ISO8601DateFormatter()
        withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFrac.date(from: raw) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }

    /// Strict fail-closed validation matching Conversations.swift: download_path must match
    /// `/storage/v1/object/sign/swarm-files/<workspace>/<file>/<version>?token=...` on the trusted origin.
    static func validatedDownloadURL(
        downloadPath: String,
        origin: URL,
        workspaceID: UUID,
        fileID: String,
        version: Int
    ) -> URL? {
        guard version > 0, !fileID.isEmpty else { return nil }
        let expectedPath = "/storage/v1/object/sign/swarm-files/"
            + workspaceID.uuidString.lowercased() + "/"
            + fileID.lowercased() + "/"
            + String(version)

        guard let comps = URLComponents(string: downloadPath),
              comps.scheme == nil,
              comps.host == nil,
              comps.fragment == nil,
              comps.percentEncodedPath == expectedPath,
              comps.queryItems?.contains(where: { $0.name == "token" && $0.value?.isEmpty == false }) == true else {
            return nil
        }
        guard let originComps = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              let originScheme = originComps.scheme?.lowercased(),
              let originHost = originComps.host?.lowercased(),
              let resolved = URL(string: downloadPath, relativeTo: origin)?.absoluteURL,
              let resolvedComps = URLComponents(url: resolved, resolvingAgainstBaseURL: false),
              resolvedComps.scheme?.lowercased() == originScheme,
              resolvedComps.host?.lowercased() == originHost,
              resolvedComps.port == originComps.port,
              resolvedComps.percentEncodedPath == expectedPath else {
            return nil
        }
        return resolved
    }

    /// Sanitizes an untrusted workspace file name into a safe single local filename component.
    static func sanitizedLocalFileName(_ rawName: String, fallbackID: String) -> String {
        let replaced = rawName
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
            .replacingOccurrences(of: "\0", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var cleaned = replaced
        while cleaned.hasPrefix(".") {
            cleaned.removeFirst()
        }
        cleaned = cleaned.replacingOccurrences(of: "..", with: "_")
        if cleaned.isEmpty {
            return "file-\(fallbackID)"
        }
        return String(cleaned.prefix(120))
    }

    static func formatUploader(
        kind: WorkspaceFileUploaderKind,
        id rawID: String,
        viewerID: UUID,
        userNames: [UUID: String],
        agentNames: [UUID: String]
    ) -> String {
        let uuid = UUID(uuidString: rawID)
        switch kind {
        case .agent:
            return uuid.flatMap { agentNames[$0] } ?? "Agent"
        case .user:
            if let uuid {
                return uuid == viewerID ? "You" : (userNames[uuid] ?? "Member")
            }
            return "Member"
        }
    }

    static func downloadErrorMessage(_ error: Error) -> String {
        if let filesError = error as? WorkspaceFilesError {
            switch filesError {
            case .accessRefused:
                return "You no longer have access to files in this workspace."
            case .downloadRefused(let reason):
                switch reason {
                case "file_removed", "file_tombstoned":
                    return "This file was removed and cannot be downloaded."
                case "file_not_found", "version_not_found":
                    return "This file version is no longer available."
                case "rate_limited":
                    return "Too many download requests. Wait a moment and try again."
                default:
                    return "File download was refused."
                }
            case .invalidDownloadPath:
                return "The server returned an unusable download link."
            case .linkExpired:
                return "This download link expired."
            case .downloadFailed:
                return "Couldn’t download the file. Tap Download to try again."
            }
        }
        return "Couldn’t download the file. Tap Download to try again."
    }

    static func downloadButtonTitle(for state: WorkspaceFileDownloadState) -> String {
        switch state {
        case .failed: "Retry download"
        case .ready, .downloaded: "Download again"
        case .idle, .preparing: "Download"
        }
    }

    static func downloadButtonAccessibilityLabel(
        state: WorkspaceFileDownloadState,
        fileName: String,
        version: Int
    ) -> String {
        let action: String
        if case .preparing = state {
            action = "Preparing download"
        } else {
            action = downloadButtonTitle(for: state)
        }
        return "\(action) \(fileName), version \(version)"
    }
}

@MainActor
final class WorkspaceFilesStore: ObservableObject {
    @Published private(set) var files: [WorkspaceFileItem] = []
    @Published private(set) var isLoading = false
    @Published private(set) var loadFailed = false
    @Published private(set) var accessUnavailable = false
    @Published private(set) var downloadStates: [WorkspaceFileVersionKey: WorkspaceFileDownloadState] = [:]
    @Published var activeShareItem: DownloadedFileShare?

    private struct TrackedTransfer {
        let id: UUID
        let task: Task<Void, Never>
    }

    let workspaceID: UUID
    private var loadGeneration = 0
    private var accessGeneration = 0
    private var isRetired = false
    private var trackedTasks: [WorkspaceFileVersionKey: TrackedTransfer] = [:]
    private var managedDirectories: Set<URL> = []

    init(workspaceID: UUID) {
        self.workspaceID = workspaceID
    }

    deinit {
        for transfer in trackedTasks.values {
            transfer.task.cancel()
        }
        for dir in managedDirectories {
            try? FileManager.default.removeItem(at: dir)
        }
    }

    func downloadState(for file: WorkspaceFileItem) -> WorkspaceFileDownloadState {
        downloadStates[WorkspaceFileVersionKey(fileID: file.fileID, version: file.currentVersion)] ?? .idle
    }

    func hasTrackedTask(for file: WorkspaceFileItem) -> Bool {
        trackedTasks[WorkspaceFileVersionKey(fileID: file.fileID, version: file.currentVersion)] != nil
    }

    private func isCurrentLiveVersion(fileID: String, version: Int) -> Bool {
        files.contains { $0.fileID == fileID && $0.currentVersion == version && !$0.isRemoved }
    }

    private func canCommitListRead(
        generation: Int,
        capturedAccessGen: Int,
        session: HumanSession
    ) -> Bool {
        !Task.isCancelled
            && !isRetired
            && session.isActive
            && generation == loadGeneration
            && capturedAccessGen == accessGeneration
    }

    private func isTransferStillValid(
        session: HumanSession,
        capturedAccessGen: Int,
        fileID: String,
        version: Int
    ) -> Bool {
        !isRetired
            && !accessUnavailable
            && session.isActive
            && accessGeneration == capturedAccessGen
            && isCurrentLiveVersion(fileID: fileID, version: version)
    }

    private func deleteDirectory(_ dir: URL) {
        managedDirectories.remove(dir)
        try? FileManager.default.removeItem(at: dir)
    }

    private func purgeAllManagedFiles() {
        for dir in managedDirectories {
            try? FileManager.default.removeItem(at: dir)
        }
        managedDirectories.removeAll()
    }

    private func cancelAllTransfers() {
        for transfer in trackedTasks.values {
            transfer.task.cancel()
        }
        trackedTasks.removeAll()
    }

    private func pruneStaleDownloads(against loaded: [WorkspaceFileItem]) {
        let liveKeys = Set(
            loaded
                .filter { !$0.isRemoved }
                .map { WorkspaceFileVersionKey(fileID: $0.fileID, version: $0.currentVersion) }
        )
        for (key, transfer) in trackedTasks where !liveKeys.contains(key) {
            transfer.task.cancel()
            trackedTasks.removeValue(forKey: key)
        }
        for (key, state) in downloadStates where !liveKeys.contains(key) {
            if case .ready(let share) = state {
                deleteDirectory(share.fileURL.deletingLastPathComponent())
            }
        }
        downloadStates = downloadStates.filter { liveKeys.contains($0.key) }
        if let active = activeShareItem,
           !liveKeys.contains(WorkspaceFileVersionKey(fileID: active.fileID, version: active.version)) {
            deleteDirectory(active.fileURL.deletingLastPathComponent())
            activeShareItem = nil
        }
    }

    /// Registers a managed downloaded file for share-sheet presentation.
    func acceptDownloadedShare(_ share: DownloadedFileShare) {
        let key = WorkspaceFileVersionKey(fileID: share.fileID, version: share.version)
        if case .ready(let previous) = downloadStates[key], previous.id != share.id {
            deleteDirectory(previous.fileURL.deletingLastPathComponent())
        }
        managedDirectories.insert(share.fileURL.deletingLastPathComponent())
        downloadStates[key] = .ready(share)
        activeShareItem = share
    }

    /// Retires in-flight downloads, dismisses any active share sheet, and removes all app-managed temporary files.
    func retire() {
        isRetired = true
        loadGeneration += 1
        accessGeneration += 1
        isLoading = false
        cancelAllTransfers()
        activeShareItem = nil
        purgeAllManagedFiles()
        downloadStates = [:]
    }

    /// Re-activates the store when a SwiftUI view re-appears.
    func activate() {
        if isRetired {
            isRetired = false
        }
    }

    /// Deletes the temporary directory owned by `share` and updates ready state only if `share.id` is still current.
    /// Idempotent and safe across completion, cancel, swipe-down, error, replacement, or after SwiftUI clears the binding.
    func finishShare(_ share: DownloadedFileShare) {
        deleteDirectory(share.fileURL.deletingLastPathComponent())
        if activeShareItem?.id == share.id {
            activeShareItem = nil
        }
        let key = WorkspaceFileVersionKey(fileID: share.fileID, version: share.version)
        if case .ready(let current) = downloadStates[key], current.id == share.id {
            downloadStates[key] = .downloaded
        }
    }

    func load(api: WorkspaceFilesAPI) async {
        activate()
        guard api.session.isActive else {
            retire()
            return
        }
        loadGeneration += 1
        let generation = loadGeneration
        let capturedAccessGen = accessGeneration
        let capturedSession = api.session
        isLoading = true
        loadFailed = false
        do {
            let loaded = try await api.listFiles(workspaceID: workspaceID)
            guard canCommitListRead(
                generation: generation,
                capturedAccessGen: capturedAccessGen,
                session: capturedSession
            ) else { return }
            files = loaded
            accessUnavailable = false
            loadFailed = false
            pruneStaleDownloads(against: loaded)
        } catch WorkspaceFilesError.accessRefused {
            guard !Task.isCancelled, !isRetired, capturedSession.isActive,
                  generation == loadGeneration, capturedAccessGen == accessGeneration else { return }
            applyAccessUnavailable()
        } catch is CancellationError {
            if !capturedSession.isActive {
                retire()
            }
        } catch {
            guard canCommitListRead(
                generation: generation,
                capturedAccessGen: capturedAccessGen,
                session: capturedSession
            ) else { return }
            loadFailed = true
        }
        if generation == loadGeneration && capturedAccessGen == accessGeneration {
            isLoading = false
        }
    }

    /// Starts a tracked download bound to the active session, view lifecycle, access generation, and file version.
    func startDownload(_ file: WorkspaceFileItem, api: WorkspaceFilesAPI) {
        let key = WorkspaceFileVersionKey(fileID: file.fileID, version: file.currentVersion)
        if trackedTasks[key] != nil { return }
        let token = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.trackedTasks[key]?.id == token {
                    self.trackedTasks.removeValue(forKey: key)
                }
            }
            await self.performDownload(file, api: api)
        }
        trackedTasks[key] = TrackedTransfer(id: token, task: task)
    }

    func download(_ file: WorkspaceFileItem, api: WorkspaceFilesAPI) async {
        let key = WorkspaceFileVersionKey(fileID: file.fileID, version: file.currentVersion)
        if let existing = trackedTasks[key] {
            await existing.task.value
            return
        }
        startDownload(file, api: api)
        if let running = trackedTasks[key] {
            await running.task.value
        }
    }

    private func performDownload(
        _ file: WorkspaceFileItem,
        api: WorkspaceFilesAPI,
        capturedAccessGen explicitAccessGen: Int? = nil
    ) async {
        let key = WorkspaceFileVersionKey(fileID: file.fileID, version: file.currentVersion)
        let capturedSession = api.session
        let capturedAccessGen = explicitAccessGen ?? accessGeneration

        guard !Task.isCancelled,
              !file.isRemoved,
              isTransferStillValid(
                  session: capturedSession,
                  capturedAccessGen: capturedAccessGen,
                  fileID: file.fileID,
                  version: file.currentVersion
              ) else {
            return
        }
        if case .preparing = downloadStates[key] { return }

        // Clean up any previous local file for this version before replacing
        if case .ready(let existing) = downloadStates[key] {
            deleteDirectory(existing.fileURL.deletingLastPathComponent())
            if activeShareItem?.id == existing.id {
                activeShareItem = nil
            }
        }

        downloadStates[key] = .preparing
        do {
            let grant = try await api.requestDownloadGrant(
                workspaceID: workspaceID,
                fileID: file.fileID,
                version: file.currentVersion,
                expectedSizeBytes: file.sizeBytes,
                commandID: UUID()
            )
            guard !Task.isCancelled,
                  isTransferStillValid(
                      session: capturedSession,
                      capturedAccessGen: capturedAccessGen,
                      fileID: file.fileID,
                      version: file.currentVersion
                  ) else {
                downloadStates.removeValue(forKey: key)
                return
            }
            if let expiresAt = grant.expiresAt, expiresAt <= Date() {
                throw WorkspaceFilesError.linkExpired
            }

            let localURL = try await api.downloadProtectedFile(
                from: grant.url,
                expectedSizeBytes: grant.sizeBytes,
                fileName: file.name,
                fileID: file.fileID,
                version: file.currentVersion
            )
            let tempDir = localURL.deletingLastPathComponent()

            guard !Task.isCancelled,
                  isTransferStillValid(
                      session: capturedSession,
                      capturedAccessGen: capturedAccessGen,
                      fileID: file.fileID,
                      version: file.currentVersion
                  ) else {
                try? FileManager.default.removeItem(at: tempDir)
                downloadStates.removeValue(forKey: key)
                return
            }

            let share = DownloadedFileShare(
                fileID: file.fileID,
                fileName: file.name,
                version: file.currentVersion,
                fileURL: localURL,
                contentWarning: grant.contentWarning
            )
            acceptDownloadedShare(share)
        } catch WorkspaceFilesError.accessRefused {
            if !Task.isCancelled, !isRetired, capturedSession.isActive, capturedAccessGen == accessGeneration {
                applyAccessUnavailable()
            } else {
                downloadStates.removeValue(forKey: key)
            }
        } catch is CancellationError {
            downloadStates.removeValue(forKey: key)
            if !capturedSession.isActive {
                retire()
            }
        } catch {
            if !Task.isCancelled,
               isTransferStillValid(
                   session: capturedSession,
                   capturedAccessGen: capturedAccessGen,
                   fileID: file.fileID,
                   version: file.currentVersion
               ) {
                downloadStates[key] = .failed(message: WorkspaceFilesRules.downloadErrorMessage(error))
            } else {
                downloadStates.removeValue(forKey: key)
                if !capturedSession.isActive {
                    retire()
                }
            }
        }
    }

    /// Reauthorizes live workspace membership and exact file/version access before opening Share / Save.
    /// Never opens a cached file without a fresh live check; purges managed copies on denial or authoritative omission.
    func startShareOrSave(_ file: WorkspaceFileItem, api: WorkspaceFilesAPI) {
        let key = WorkspaceFileVersionKey(fileID: file.fileID, version: file.currentVersion)
        if trackedTasks[key] != nil { return }
        let token = UUID()
        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.trackedTasks[key]?.id == token {
                    self.trackedTasks.removeValue(forKey: key)
                }
            }
            await self.performShareOrSave(for: file, api: api)
        }
        trackedTasks[key] = TrackedTransfer(id: token, task: task)
    }

    func openReadyDownload(for file: WorkspaceFileItem, api: WorkspaceFilesAPI) async {
        let key = WorkspaceFileVersionKey(fileID: file.fileID, version: file.currentVersion)
        if let existing = trackedTasks[key] {
            await existing.task.value
            return
        }
        startShareOrSave(file, api: api)
        if let running = trackedTasks[key] {
            await running.task.value
        }
    }

    private func performShareOrSave(for file: WorkspaceFileItem, api: WorkspaceFilesAPI) async {
        let key = WorkspaceFileVersionKey(fileID: file.fileID, version: file.currentVersion)

        guard !isRetired,
              !accessUnavailable,
              api.session.isActive,
              !file.isRemoved,
              isCurrentLiveVersion(fileID: file.fileID, version: file.currentVersion) else {
            return
        }

        let capturedSession = api.session
        let capturedAccessGen = accessGeneration
        let existingReadyShare: DownloadedFileShare?
        if case .ready(let share) = downloadStates[key],
           share.version == file.currentVersion,
           FileManager.default.fileExists(atPath: share.fileURL.path) {
            existingReadyShare = share
        } else {
            existingReadyShare = nil
        }

        // 1. Live membership & version check through swarm_read.files, fenced with the same loadGeneration + accessGeneration.
        loadGeneration += 1
        let listGeneration = loadGeneration
        do {
            let freshList = try await api.listFiles(workspaceID: workspaceID)
            guard canCommitListRead(
                generation: listGeneration,
                capturedAccessGen: capturedAccessGen,
                session: capturedSession
            ) else {
                if let share = existingReadyShare { deleteDirectory(share.fileURL.deletingLastPathComponent()) }
                return
            }
            files = freshList
            accessUnavailable = false
            loadFailed = false
            isLoading = false
            pruneStaleDownloads(against: freshList)

            guard !Task.isCancelled,
                  let matched = freshList.first(where: {
                      $0.fileID == file.fileID && $0.currentVersion == file.currentVersion && !$0.isRemoved
                  }) else {
                // Authoritative omission, removal, or version bump — ensure any cached copy is purged and do not open sheet.
                if let share = existingReadyShare {
                    deleteDirectory(share.fileURL.deletingLastPathComponent())
                }
                if let share = existingReadyShare, activeShareItem?.id == share.id {
                    activeShareItem = nil
                }
                downloadStates.removeValue(forKey: key)
                return
            }

            // 2. If we still have a live protected copy in memory, verify live command authorization before opening.
            if let existing = existingReadyShare {
                _ = try await api.requestDownloadGrant(
                    workspaceID: workspaceID,
                    fileID: matched.fileID,
                    version: matched.currentVersion,
                    expectedSizeBytes: matched.sizeBytes,
                    commandID: UUID()
                )
                guard !Task.isCancelled,
                      isTransferStillValid(
                          session: capturedSession,
                          capturedAccessGen: capturedAccessGen,
                          fileID: matched.fileID,
                          version: matched.currentVersion
                      ),
                      FileManager.default.fileExists(atPath: existing.fileURL.path) else {
                    deleteDirectory(existing.fileURL.deletingLastPathComponent())
                    if activeShareItem?.id == existing.id {
                        activeShareItem = nil
                    }
                    downloadStates.removeValue(forKey: key)
                    return
                }
                activeShareItem = existing
                return
            }

            // 3. No cached copy on disk (purged on dismissal) -> run a fresh authorized download
            //    while keeping the outer tracked task registered through settlement.
            await performDownload(matched, api: api, capturedAccessGen: capturedAccessGen)
        } catch WorkspaceFilesError.accessRefused {
            if !Task.isCancelled, !isRetired, capturedSession.isActive, capturedAccessGen == accessGeneration {
                applyAccessUnavailable()
            }
        } catch is CancellationError {
            if !capturedSession.isActive {
                retire()
            }
        } catch {
            // Live reauthorization failed (e.g. 503/network) — fail closed, never open cached bytes.
            if let share = existingReadyShare {
                deleteDirectory(share.fileURL.deletingLastPathComponent())
            }
            if let share = existingReadyShare, activeShareItem?.id == share.id {
                activeShareItem = nil
            }
            if listGeneration == loadGeneration && capturedAccessGen == accessGeneration {
                isLoading = false
            }
            if !Task.isCancelled,
               isTransferStillValid(
                   session: capturedSession,
                   capturedAccessGen: capturedAccessGen,
                   fileID: file.fileID,
                   version: file.currentVersion
               ) {
                downloadStates[key] = .failed(message: WorkspaceFilesRules.downloadErrorMessage(error))
            } else if !capturedSession.isActive {
                retire()
            }
        }
    }

    private func applyAccessUnavailable() {
        loadGeneration += 1
        accessGeneration += 1
        isLoading = false
        cancelAllTransfers()
        activeShareItem = nil
        purgeAllManagedFiles()
        files = []
        downloadStates = [:]
        accessUnavailable = true
        loadFailed = false
    }
}
