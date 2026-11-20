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
    static let maxDownloadBytes = 50 * 1024 * 1024
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

    /// Strict fail-closed validation: download_path must be a relative /storage/v1/ path on the exact trusted API origin.
    static func validatedDownloadURL(downloadPath: String, origin: URL) -> URL? {
        guard downloadPath.hasPrefix("/storage/v1/"),
              !downloadPath.hasPrefix("//"),
              !downloadPath.contains("\\"),
              !downloadPath.contains("..") else {
            return nil
        }
        guard let originComps = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              let originScheme = originComps.scheme?.lowercased(),
              let originHost = originComps.host?.lowercased() else {
            return nil
        }
        guard let resolved = URL(string: downloadPath, relativeTo: origin)?.absoluteURL,
              let resolvedComps = URLComponents(url: resolved, resolvingAgainstBaseURL: false),
              resolvedComps.scheme?.lowercased() == originScheme,
              resolvedComps.host?.lowercased() == originHost,
              resolvedComps.port == originComps.port,
              resolvedComps.path.hasPrefix("/storage/v1/") else {
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
        case .ready: "Download again"
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

    let workspaceID: UUID
    private var loadGeneration = 0

    init(workspaceID: UUID) {
        self.workspaceID = workspaceID
    }

    func downloadState(for file: WorkspaceFileItem) -> WorkspaceFileDownloadState {
        downloadStates[WorkspaceFileVersionKey(fileID: file.fileID, version: file.currentVersion)] ?? .idle
    }

    private func isCurrentLiveVersion(fileID: String, version: Int) -> Bool {
        files.contains { $0.fileID == fileID && $0.currentVersion == version && !$0.isRemoved }
    }

    func load(api: WorkspaceFilesAPI) async {
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        loadFailed = false
        do {
            let loaded = try await api.listFiles(workspaceID: workspaceID)
            guard !Task.isCancelled, generation == loadGeneration else { return }
            files = loaded
            accessUnavailable = false
            loadFailed = false

            // Prune download states for files removed or superseded by a newer version
            let liveKeys = Set(
                loaded
                    .filter { !$0.isRemoved }
                    .map { WorkspaceFileVersionKey(fileID: $0.fileID, version: $0.currentVersion) }
            )
            for (key, state) in downloadStates where !liveKeys.contains(key) {
                if case .ready(let share) = state {
                    try? FileManager.default.removeItem(at: share.fileURL.deletingLastPathComponent())
                }
            }
            downloadStates = downloadStates.filter { liveKeys.contains($0.key) }
            if let active = activeShareItem,
               !liveKeys.contains(WorkspaceFileVersionKey(fileID: active.fileID, version: active.version)) {
                activeShareItem = nil
            }
        } catch WorkspaceFilesError.accessRefused {
            guard !Task.isCancelled, generation == loadGeneration else { return }
            applyAccessUnavailable()
        } catch {
            guard !Task.isCancelled, generation == loadGeneration else { return }
            loadFailed = true
        }
        if generation == loadGeneration {
            isLoading = false
        }
    }

    func download(_ file: WorkspaceFileItem, api: WorkspaceFilesAPI) async {
        guard !file.isRemoved, isCurrentLiveVersion(fileID: file.fileID, version: file.currentVersion) else { return }
        let key = WorkspaceFileVersionKey(fileID: file.fileID, version: file.currentVersion)
        if case .preparing = downloadStates[key] { return }

        downloadStates[key] = .preparing
        do {
            let grant = try await api.requestDownloadGrant(
                workspaceID: workspaceID,
                fileID: file.fileID,
                version: file.currentVersion,
                commandID: UUID()
            )
            guard !Task.isCancelled else {
                downloadStates[key] = nil
                return
            }
            guard isCurrentLiveVersion(fileID: file.fileID, version: file.currentVersion) else {
                downloadStates[key] = nil
                return
            }
            if let expiresAt = grant.expiresAt, expiresAt <= Date() {
                throw WorkspaceFilesError.linkExpired
            }
            let localURL = try await api.downloadBytes(
                from: grant.url,
                fileName: file.name,
                fileID: file.fileID,
                version: file.currentVersion
            )
            guard !Task.isCancelled, isCurrentLiveVersion(fileID: file.fileID, version: file.currentVersion) else {
                try? FileManager.default.removeItem(at: localURL.deletingLastPathComponent())
                downloadStates[key] = nil
                return
            }
            let share = DownloadedFileShare(
                fileID: file.fileID,
                fileName: file.name,
                version: file.currentVersion,
                fileURL: localURL,
                contentWarning: grant.contentWarning
            )
            downloadStates[key] = .ready(share)
            activeShareItem = share
        } catch WorkspaceFilesError.accessRefused {
            if !Task.isCancelled {
                applyAccessUnavailable()
            }
        } catch {
            if !Task.isCancelled {
                if isCurrentLiveVersion(fileID: file.fileID, version: file.currentVersion) {
                    downloadStates[key] = .failed(message: WorkspaceFilesRules.downloadErrorMessage(error))
                } else {
                    downloadStates[key] = nil
                }
            }
        }
    }

    func openReadyDownload(for file: WorkspaceFileItem) {
        guard isCurrentLiveVersion(fileID: file.fileID, version: file.currentVersion) else { return }
        let key = WorkspaceFileVersionKey(fileID: file.fileID, version: file.currentVersion)
        if case .ready(let share) = downloadStates[key], share.version == file.currentVersion {
            activeShareItem = share
        }
    }

    private func applyAccessUnavailable() {
        for (_, state) in downloadStates {
            if case .ready(let share) = state {
                try? FileManager.default.removeItem(at: share.fileURL.deletingLastPathComponent())
            }
        }
        files = []
        downloadStates = [:]
        activeShareItem = nil
        accessUnavailable = true
        loadFailed = false
    }
}
