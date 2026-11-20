import Combine
import CryptoKit
import Foundation

struct WikiAccess: Equatable, Sendable {
    let canRead: Bool
    let canCreate: Bool
    let canUpdate: Bool
}

struct WikiTopic: Hashable, Identifiable, Sendable {
    let fileID: UUID
    let name: String
    let topic: String
    let currentVersion: Int
    let sizeBytes: Int64
    let uploadedByKind: WorkspaceFileUploaderKind
    let uploadedBy: String
    let updaterLabel: String
    let committedAt: String
    let committedDate: Date?

    var id: UUID { fileID }

    var versionLabel: String {
        currentVersion == 1 ? "1 version" : "\(currentVersion) versions"
    }

    var relativeAgeLabel: String {
        guard let committedDate else { return "recently" }
        return WorkspaceFilesRules.formatRelativeAge(committedDate)
    }

    var isAgentUpdater: Bool {
        uploadedByKind == .agent
    }
}

struct WikiLinkSegment: Equatable, Sendable {
    let text: String
    let topic: String?
}

struct WikiEditSession: Identifiable, Equatable, Sendable {
    let id = UUID()
    let fileID: UUID
    let topic: String
    let fileName: String
    let baseVersion: Int
    let initialMarkdown: String
}

struct WikiCreateSession: Identifiable, Equatable, Sendable {
    let id = UUID()
}

struct WikiUploadSlot: Equatable, Sendable {
    let fileID: UUID
    let versionID: UUID
    let versionN: Int
    let uploadPath: String
}

struct WikiPendingSave: Equatable, Sendable {
    let sessionID: ObjectIdentifier
    let workspaceID: UUID
    let fileID: UUID
    let topic: String
    let fileName: String
    let baseVersion: Int
    let markdown: String
    let versionID: UUID
    let createCommandID: UUID
    let commitCommandID: UUID
    var slot: WikiUploadSlot?
    var uploaded: Bool
    let ownerToken: UUID
    var outcomeUnknown: Bool
}

struct WikiPendingSaveRetry: Identifiable, Equatable, Sendable {
    let commandID: UUID
    let fileID: UUID
    let topic: String
    let baseVersion: Int
    let markdown: String

    var id: UUID { commandID }
    var label: String {
        baseVersion == 0 ? "Retry creating “\(topic)”" : "Retry saving “\(topic)”"
    }
}

enum WikiLoadFailure: Equatable, Sendable {
    case failed
    case refused(String)

    var message: String {
        switch self {
        case .failed:
            return "Couldn’t load wiki pages."
        case .refused(let reason):
            switch reason {
            case "unauthorized":
                return "Your session expired. Sign in again to access the wiki."
            case "forbidden", "workspace_access_refused", "content_consent_required", "connection_access_refused", "workspace_not_found":
                return "You don’t have access to the wiki in this workspace."
            default:
                return "Couldn’t load wiki pages."
            }
        }
    }
}

enum WikiSaveOutcome: Sendable {
    case committed(fileID: UUID, version: Int, sizeBytes: Int, replayed: Bool)
    case conflict(currentVersion: Int?, message: String)
    case refused(reason: String, message: String)
    case unconfirmed(message: String, slot: WikiUploadSlot?, uploaded: Bool)
    case cancelled
}

enum WikiReadContentResult: Sendable {
    case loaded(markdown: String, version: Int, versionState: String?)
}

enum WikiError: Error, Equatable, Sendable {
    case refused(String)
    case notFound
    case invalidDownloadPath
    case invalidEncoding
    case linkExpired
    case failed(status: Int)
}

enum WikiRules {
    static let brainFilePrefix = "brain--"
    static let brainFileSuffix = ".md"
    static let maxTopicLength = 255 - brainFilePrefix.count - brainFileSuffix.count
    static let maxMarkdownBytes = WorkspaceFilesRules.maxDownloadBytes
    static let slugSeparators: Set<Character> = ["-", "_", "."]

    /// Matches `canonicalBrainTopic` in `src/cloud/brain.ts`:
    /// lowercase letters, digits, dots, dashes, or underscores, starting with a letter or digit.
    static func canonicalTopic(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty, trimmed.count <= maxTopicLength else { return nil }
        guard let first = trimmed.first, first.isASCII, (first.isLetter || first.isNumber) else { return nil }
        for ch in trimmed {
            guard ch.isASCII else { return nil }
            let ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch == "." || ch == "_" || ch == "-"
            if !ok { return nil }
        }
        return trimmed
    }

    static func fileName(for rawTopic: String) -> String? {
        guard let topic = canonicalTopic(rawTopic) else { return nil }
        return "\(brainFilePrefix)\(topic)\(brainFileSuffix)"
    }

    static func topicFromFileName(_ name: String) -> String? {
        guard name.count <= 255 else { return nil }
        let lower = name.lowercased()
        guard lower.hasPrefix(brainFilePrefix), lower.hasSuffix(brainFileSuffix) else { return nil }
        let start = lower.index(lower.startIndex, offsetBy: brainFilePrefix.count)
        let end = lower.index(lower.endIndex, offsetBy: -brainFileSuffix.count)
        guard start < end else { return nil }
        return canonicalTopic(String(lower[start..<end]))
    }

    static func isSlugShapedTopic(_ topic: String) -> Bool {
        topic.contains(where: { slugSeparators.contains($0) })
    }

    /// Strict parity with `brainLinkSegments` in `site/src/lib/brain-links.ts`:
    /// - Validates every link against the live workspace topic list.
    /// - Slug-shaped topics (`-`, `_`, `.`) link in prose (with sentence-ending punctuation trimmed).
    /// - Bare one-word topics link ONLY inside an inline code span that equals the topic name.
    /// - Keeps URL/path/command punctuation inside one run so URLs never split into false links.
    static func linkSegments(
        in text: String,
        topics: [String],
        codeSpan: String? = nil
    ) -> [WikiLinkSegment] {
        var known: [String: String] = [:]
        for topic in topics where !topic.isEmpty {
            known[topic.lowercased()] = topic
        }
        guard !known.isEmpty, !text.isEmpty else {
            return [WikiLinkSegment(text: text, topic: nil)]
        }

        let trailingPunct: Set<Character> = [".", ":", "~", "?", "#", ";", ","]
        let isRunChar: (Character) -> Bool = { ch in
            guard ch.isASCII else { return false }
            if (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") {
                return true
            }
            return "._~-/\\@:?#=&%+;,.".contains(ch)
        }

        func trimTrailing(_ s: String) -> String {
            var end = s.endIndex
            while end > s.startIndex {
                let prev = s.index(before: end)
                if trailingPunct.contains(s[prev]) {
                    end = prev
                } else {
                    break
                }
            }
            return String(s[..<end])
        }

        func resolveRun(_ run: String) -> (topic: String, length: Int)? {
            if let exact = known[run.lowercased()] {
                return (exact, run.count)
            }
            let trimmed = trimTrailing(run)
            if trimmed.isEmpty || trimmed.count == run.count { return nil }
            if let fallback = known[trimmed.lowercased()] {
                return (fallback, trimmed.count)
            }
            return nil
        }

        func isLinkable(_ topic: String) -> Bool {
            if isSlugShapedTopic(topic) { return true }
            guard let codeSpan else { return false }
            let span = codeSpan.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return span == topic.lowercased() || trimTrailing(span) == topic.lowercased()
        }

        var segments: [WikiLinkSegment] = []
        var cursor = text.startIndex
        var idx = text.startIndex
        while idx < text.endIndex {
            if !isRunChar(text[idx]) {
                idx = text.index(after: idx)
                continue
            }
            let runStart = idx
            while idx < text.endIndex && isRunChar(text[idx]) {
                idx = text.index(after: idx)
            }
            let run = String(text[runStart..<idx])
            guard let resolved = resolveRun(run), isLinkable(resolved.topic) else { continue }
            if runStart > cursor {
                segments.append(WikiLinkSegment(text: String(text[cursor..<runStart]), topic: nil))
            }
            let matchEnd = text.index(runStart, offsetBy: resolved.length)
            segments.append(WikiLinkSegment(text: String(text[runStart..<matchEnd]), topic: resolved.topic))
            cursor = matchEnd
        }

        if segments.isEmpty {
            return [WikiLinkSegment(text: text, topic: nil)]
        }
        if cursor < text.endIndex {
            segments.append(WikiLinkSegment(text: String(text[cursor...]), topic: nil))
        }
        return segments
    }

    /// Strict fail-closed validation matching `FileUpload.swift`:
    /// `/storage/v1/object/upload/sign/swarm-files/<workspace>/<file>/<version>?token=...` on the trusted origin.
    static func validatedUploadURL(
        uploadPath: String,
        origin: URL,
        workspaceID: UUID,
        fileID: UUID,
        version: Int
    ) -> URL? {
        guard version > 0 else { return nil }
        let expectedPath = "/storage/v1/object/upload/sign/swarm-files/"
            + workspaceID.uuidString.lowercased() + "/"
            + fileID.uuidString.lowercased() + "/"
            + String(version)

        guard let comps = URLComponents(string: uploadPath),
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
              let resolved = URL(string: uploadPath, relativeTo: origin)?.absoluteURL,
              let resolvedComps = URLComponents(url: resolved, resolvingAgainstBaseURL: false),
              resolvedComps.scheme?.lowercased() == originScheme,
              resolvedComps.host?.lowercased() == originHost,
              resolvedComps.port == originComps.port,
              resolvedComps.percentEncodedPath == expectedPath else {
            return nil
        }
        return resolved
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Renders inline Markdown while stripping `.link` from any URL whose scheme is not `http`/`https`
    /// with a non-empty host (blocking `tel:`, `sms:`, `javascript:`, custom schemes, and hostless links).
    static func sanitizedInlineMarkdown(_ text: String) -> AttributedString {
        guard var parsed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else {
            return AttributedString(text)
        }
        for run in parsed.runs {
            if let url = run.link {
                let scheme = url.scheme?.lowercased()
                let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let allowed = (scheme == "http" || scheme == "https") && !host.isEmpty
                if !allowed {
                    parsed[run.range].link = nil
                }
            }
        }
        return parsed
    }

    static func isAccessLossReason(_ reason: String) -> Bool {
        switch reason {
        case "unauthorized", "forbidden", "workspace_access_refused",
             "content_consent_required", "connection_access_refused", "workspace_not_found":
            return true
        default:
            return false
        }
    }

    static func refusalMessage(_ reason: String, fallback: String = "Couldn’t save wiki page.") -> String {
        switch reason {
        case "unauthorized":
            return "Your session expired. Sign in again to continue."
        case "forbidden", "workspace_access_refused", "content_consent_required", "connection_access_refused":
            return "You don’t have access to the wiki in this workspace."
        case "content_read_only":
            return "You have read-only access to the wiki in this workspace."
        case "file_version_precondition_failed":
            return "Someone else updated this wiki page. Review the latest version and edit again."
        case "workspace_quota_exceeded":
            return "This workspace has reached its storage limit."
        case "file_not_found", "object_not_found":
            return "This wiki page is no longer available."
        case "file_tombstoned":
            return "This wiki page was removed."
        default:
            return fallback
        }
    }

    static func unknownOutcomeAfterRefusalMessage(action: String, refusalMessage: String) -> String {
        "The earlier \(action) outcome is still unknown. \(refusalMessage)"
    }
}

@MainActor
private final class WikiDispatchFlag {
    var entered = false
}

@MainActor
final class WikiStore: ObservableObject {
    let api: WikiAPI
    let workspaceID: UUID

    @Published private(set) var topics: [WikiTopic]?
    @Published private(set) var access: WikiAccess?
    @Published private(set) var isLoading = false
    @Published private(set) var loadFailure: WikiLoadFailure?
    @Published var searchQuery = ""

    @Published private(set) var activeFileID: UUID?
    @Published private(set) var activeVersion: Int?
    @Published private(set) var activeMarkdown: String?
    @Published private(set) var activeVersionState: String?
    @Published private(set) var isLoadingContent = false
    @Published private(set) var contentError: String?
    @Published private(set) var linkNotice: String?

    @Published private(set) var isSaving = false
    @Published private(set) var statusMessage: String?
    @Published private(set) var actionError: String?
    @Published var activeEditSession: WikiEditSession?
    @Published var activeCreateSession: WikiCreateSession?
    @Published private(set) var pendingSaves: [UUID: WikiPendingSave] = [:]

    private var listGeneration = 0
    private var readGeneration = 0
    private var accessGeneration = 0
    private var isRetired = false
    private let sessionID: ObjectIdentifier

    init(api: WikiAPI, workspaceID: UUID) {
        self.api = api
        self.workspaceID = workspaceID
        self.sessionID = ObjectIdentifier(api.session)
    }

    var canCreate: Bool {
        !isRetired && api.session.isActive && access?.canCreate == true
    }

    var canUpdate: Bool {
        !isRetired && api.session.isActive && access?.canUpdate == true
    }

    var filteredTopics: [WikiTopic] {
        guard let topics else { return [] }
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return topics }
        return topics.filter {
            $0.topic.lowercased().contains(query) || $0.updaterLabel.lowercased().contains(query)
        }
    }

    var activeTopic: WikiTopic? {
        guard let activeFileID, let topics else { return nil }
        return topics.first(where: { $0.fileID == activeFileID })
    }

    var isViewingLatest: Bool {
        guard let topic = activeTopic, let activeVersion else { return false }
        return activeVersion == topic.currentVersion
    }

    func canEditTopic(_ fileID: UUID) -> Bool {
        guard canUpdate,
              let topic = topics?.first(where: { $0.fileID == fileID }),
              activeFileID == fileID,
              activeVersion == topic.currentVersion,
              activeMarkdown != nil else { return false }
        return true
    }

    /// Eligible pending save retries, independent of `actionError` so normal refreshes never hide them.
    func eligiblePendingRetries(for fileID: UUID? = nil) -> [WikiPendingSaveRetry] {
        guard !isRetired, api.session.isActive else { return [] }
        return pendingSaves.values
            .filter { pending in
                guard pending.outcomeUnknown, pending.sessionID == sessionID, pending.workspaceID == workspaceID else {
                    return false
                }
                if let fileID, pending.fileID != fileID { return false }
                return pending.baseVersion == 0 ? canCreate : canUpdate
            }
            .sorted { $0.topic < $1.topic }
            .map {
                WikiPendingSaveRetry(
                    commandID: $0.commitCommandID,
                    fileID: $0.fileID,
                    topic: $0.topic,
                    baseVersion: $0.baseVersion,
                    markdown: $0.markdown
                )
            }
    }

    func activate() {
        isRetired = false
        if !api.session.isActive {
            clearOnAccessLoss(reason: "unauthorized", clearPending: true)
        }
    }

    func retire() {
        isRetired = true
        listGeneration += 1
        readGeneration += 1
        accessGeneration += 1
        isLoading = false
        isLoadingContent = false
        activeEditSession = nil
        activeCreateSession = nil
        if !api.session.isActive {
            pendingSaves.removeAll()
        }
    }

    @discardableResult
    func openCreateSheet() -> WikiCreateSession? {
        guard canCreate else { return nil }
        actionError = nil
        let session = WikiCreateSession()
        activeCreateSession = session
        return session
    }

    func dismissCreateSession(_ id: UUID) {
        if activeCreateSession?.id == id {
            activeCreateSession = nil
        }
    }

    @discardableResult
    func beginEdit(fileID: UUID) -> WikiEditSession? {
        guard canEditTopic(fileID),
              let topic = topics?.first(where: { $0.fileID == fileID }),
              let markdown = activeMarkdown else { return nil }
        let session = WikiEditSession(
            fileID: topic.fileID,
            topic: topic.topic,
            fileName: topic.name,
            baseVersion: topic.currentVersion,
            initialMarkdown: markdown
        )
        activeEditSession = session
        if pendingSaves[fileID]?.outcomeUnknown != true {
            actionError = nil
        }
        return session
    }

    func dismissEditSession(_ id: UUID) {
        if activeEditSession?.id == id {
            activeEditSession = nil
        }
    }

    func clearLinkNotice() {
        linkNotice = nil
    }

    @discardableResult
    func loadTopics(preserveNotice: Bool = false) async -> Bool {
        activate()
        guard api.session.isActive else {
            clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            return false
        }
        listGeneration += 1
        let generation = listGeneration
        var capturedAccessGen = accessGeneration
        let capturedSession = api.session
        isLoading = true
        loadFailure = nil
        if !preserveNotice {
            statusMessage = nil
            actionError = nil
        }

        let accessGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            return !self.isRetired
                && capturedSession.isActive
                && self.listGeneration == generation
                && self.accessGeneration == capturedAccessGen
        }

        do {
            let accessStatus = try await api.access(workspaceID: workspaceID, canDispatch: accessGate)
            guard !Task.isCancelled, !isRetired, capturedSession.isActive,
                  listGeneration == generation, accessGeneration == capturedAccessGen else { return false }

            switch accessStatus {
            case .refused(let reason):
                clearOnAccessLoss(reason: reason, clearPending: !capturedSession.isActive)
                return false
            case .unavailable:
                let hadWrite = (access?.canCreate == true) || (access?.canUpdate == true)
                access = WikiAccess(canRead: true, canCreate: false, canUpdate: false)
                if hadWrite {
                    accessGeneration += 1
                    capturedAccessGen = accessGeneration
                    closeWriteSurfaces()
                }
            case .granted(let granted):
                guard granted.canRead else {
                    clearOnAccessLoss(reason: "workspace_access_refused", clearPending: !capturedSession.isActive)
                    return false
                }
                let lostWrite = (access?.canCreate == true && !granted.canCreate)
                    || (access?.canUpdate == true && !granted.canUpdate)
                access = granted
                if lostWrite {
                    accessGeneration += 1
                    capturedAccessGen = accessGeneration
                    if !granted.canUpdate { activeEditSession = nil }
                    if !granted.canCreate { activeCreateSession = nil }
                } else {
                    if !granted.canUpdate { activeEditSession = nil }
                    if !granted.canCreate { activeCreateSession = nil }
                }
            }

            let readAccessGen = capturedAccessGen
            let listGate: @MainActor @Sendable () -> Bool = { [weak self] in
                guard let self else { return false }
                return !self.isRetired
                    && capturedSession.isActive
                    && self.listGeneration == generation
                    && self.accessGeneration == readAccessGen
            }
            let loaded = try await api.listTopics(workspaceID: workspaceID, canDispatch: listGate)
            try Task.checkCancellation()
            guard !isRetired, capturedSession.isActive,
                  listGeneration == generation, accessGeneration == readAccessGen else { return false }

            topics = loaded
            isLoading = false

            // Retire stale edit session if the open topic vanished or advanced to a newer version.
            if let openEdit = activeEditSession {
                guard let latest = loaded.first(where: { $0.fileID == openEdit.fileID }),
                      latest.currentVersion == openEdit.baseVersion else {
                    activeEditSession = nil
                    return true
                }
            }
            // Clear active content if the active topic was deleted from the workspace.
            if let activeID = activeFileID, !loaded.contains(where: { $0.fileID == activeID }) {
                activeFileID = nil
                activeVersion = nil
                activeMarkdown = nil
                activeVersionState = nil
                contentError = "This wiki page is no longer in this workspace."
            }
            return true
        } catch WikiError.refused(let reason) {
            if !Task.isCancelled && !isRetired && listGeneration == generation && accessGeneration == capturedAccessGen {
                if WikiRules.isAccessLossReason(reason) {
                    clearOnAccessLoss(reason: reason, clearPending: !capturedSession.isActive)
                } else {
                    loadFailure = .refused(reason)
                    isLoading = false
                }
            }
            return false
        } catch {
            if !Task.isCancelled && !isRetired && listGeneration == generation && accessGeneration == capturedAccessGen {
                if !capturedSession.isActive {
                    clearOnAccessLoss(reason: "unauthorized", clearPending: true)
                } else {
                    loadFailure = .failed
                    isLoading = false
                }
            }
            return false
        }
    }

    func openTopic(fileID: UUID, version requestedVersion: Int? = nil) async {
        activate()
        guard api.session.isActive else {
            clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            return
        }
        guard let topic = topics?.first(where: { $0.fileID == fileID }) else {
            contentError = "This wiki page is no longer in this workspace."
            return
        }
        let targetVersion = requestedVersion ?? topic.currentVersion
        guard targetVersion >= 1 && targetVersion <= topic.currentVersion else { return }

        readGeneration += 1
        let generation = readGeneration
        let capturedAccessGen = accessGeneration
        let capturedSession = api.session

        let switchingFile = activeFileID != fileID
        let switchingVersion = activeVersion != targetVersion
        activeFileID = fileID
        activeVersion = targetVersion
        if switchingFile || switchingVersion {
            activeMarkdown = nil
            activeVersionState = nil
            activeEditSession = nil
        }
        isLoadingContent = true
        contentError = nil
        linkNotice = nil

        let readGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            return !self.isRetired
                && capturedSession.isActive
                && self.readGeneration == generation
                && self.accessGeneration == capturedAccessGen
                && self.activeFileID == fileID
                && self.activeVersion == targetVersion
        }

        do {
            let result = try await api.readTopicContent(
                workspaceID: workspaceID,
                fileID: fileID,
                version: targetVersion,
                expectedSizeBytes: topic.sizeBytes,
                canDispatch: readGate
            )
            try Task.checkCancellation()
            guard !isRetired, capturedSession.isActive,
                  readGeneration == generation,
                  accessGeneration == capturedAccessGen,
                  activeFileID == fileID,
                  activeVersion == targetVersion else { return }
            switch result {
            case .loaded(let markdown, _, let versionState):
                activeMarkdown = markdown
                activeVersionState = versionState
                isLoadingContent = false
                contentError = nil
            }
        } catch WikiError.refused(let reason) {
            guard !Task.isCancelled, !isRetired,
                  readGeneration == generation, accessGeneration == capturedAccessGen else { return }
            if WikiRules.isAccessLossReason(reason) {
                clearOnAccessLoss(reason: reason, clearPending: !capturedSession.isActive)
            } else {
                contentError = WikiRules.refusalMessage(reason, fallback: "Couldn’t load this wiki page.")
                isLoadingContent = false
            }
        } catch WikiError.notFound {
            guard !Task.isCancelled, !isRetired,
                  readGeneration == generation, accessGeneration == capturedAccessGen else { return }
            contentError = "This wiki version is no longer available."
            isLoadingContent = false
        } catch WikiError.linkExpired {
            guard !Task.isCancelled, !isRetired,
                  readGeneration == generation, accessGeneration == capturedAccessGen else { return }
            contentError = "The page link expired. Try again."
            isLoadingContent = false
        } catch is CancellationError {
            if !capturedSession.isActive {
                clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            }
        } catch {
            guard !Task.isCancelled, !isRetired, capturedSession.isActive,
                  readGeneration == generation, accessGeneration == capturedAccessGen else { return }
            contentError = "Couldn’t load this wiki page. Try again."
            isLoadingContent = false
        }
    }

    /// Re-reads the workspace topic list before following a topic link (`brainLinkClickOutcome` parity).
    /// Never opens a deleted topic or relies on a failed/stale snapshot.
    func followTopicLink(_ topicName: String) async -> WikiTopic? {
        guard !isRetired, api.session.isActive else { return nil }
        linkNotice = nil
        let fresh = await loadTopics(preserveNotice: true)
        guard !isRetired, api.session.isActive else { return nil }
        guard fresh, let currentTopics = topics else {
            linkNotice = "\(topicName) could not be opened: the wiki list couldn’t be refreshed right now. Check your connection and try again."
            return nil
        }
        guard let target = currentTopics.first(where: { $0.topic.lowercased() == topicName.lowercased() }) else {
            linkNotice = "\(topicName) is no longer in this workspace. It may have been deleted."
            return nil
        }
        await openTopic(fileID: target.fileID, version: target.currentVersion)
        return target
    }

    func saveEdit(session editSession: WikiEditSession, markdown: String) async -> Bool {
        guard !isRetired else { return false }
        guard api.session.isActive else {
            clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            return false
        }
        guard !isSaving, canUpdate else { return false }
        guard activeEditSession?.id == editSession.id,
              let liveTopic = topics?.first(where: { $0.fileID == editSession.fileID }),
              liveTopic.currentVersion == editSession.baseVersion else {
            activeEditSession = nil
            actionError = "This wiki page changed since you opened Edit. Review the latest version and edit again."
            return false
        }
        guard !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            actionError = "A wiki page cannot be empty. Nothing was saved."
            return false
        }
        guard markdown.utf8.count <= WikiRules.maxMarkdownBytes else {
            actionError = "This wiki page exceeds the 25 MiB limit."
            return false
        }

        let attemptToken = UUID()
        guard let claimed = claimPendingSave(
            fileID: editSession.fileID,
            topic: editSession.topic,
            fileName: editSession.fileName,
            baseVersion: editSession.baseVersion,
            markdown: markdown,
            ownerToken: attemptToken
        ) else {
            actionError = "An earlier save for “\(editSession.topic)” has an unknown outcome. Retry it unchanged to check before saving different changes."
            return false
        }

        return await executeSave(
            record: claimed,
            ownerToken: attemptToken,
            wasAlreadyUnknown: claimed.outcomeUnknown,
            boundEditSessionID: editSession.id,
            boundCreateSessionID: nil
        )
    }

    func createTopic(session createSession: WikiCreateSession, rawTopic: String, markdown: String) async -> WikiTopic? {
        guard !isRetired else { return nil }
        guard api.session.isActive else {
            clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            return nil
        }
        guard !isSaving, canCreate else { return nil }
        guard activeCreateSession?.id == createSession.id else { return nil }

        guard let topic = WikiRules.canonicalTopic(rawTopic),
              let fileName = WikiRules.fileName(for: topic) else {
            actionError = "Topic names use lowercase letters, numbers, dots, dashes, or underscores, starting with a letter or number."
            return nil
        }
        guard !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            actionError = "A wiki page cannot be empty. Nothing was saved."
            return nil
        }
        guard markdown.utf8.count <= WikiRules.maxMarkdownBytes else {
            actionError = "This wiki page exceeds the 25 MiB limit."
            return nil
        }
        if let existingTopic = topics?.first(where: { $0.topic == topic }) {
            actionError = "“\(existingTopic.topic)” already exists. Open it to edit instead."
            return nil
        }

        // Reuse existing pending create for this exact topic if one is already in pendingSaves.
        let targetFileID: UUID
        if let existingPending = pendingSaves.values.first(where: { $0.baseVersion == 0 && $0.topic == topic }) {
            targetFileID = existingPending.fileID
        } else if let otherUnknown = pendingSaves.values.first(where: { $0.baseVersion == 0 && $0.outcomeUnknown }) {
            actionError = "An earlier creation for “\(otherUnknown.topic)” has an unknown outcome. Retry it unchanged to check first."
            return nil
        } else {
            targetFileID = UUID()
        }

        let attemptToken = UUID()
        guard let claimed = claimPendingSave(
            fileID: targetFileID,
            topic: topic,
            fileName: fileName,
            baseVersion: 0,
            markdown: markdown,
            ownerToken: attemptToken
        ) else {
            actionError = "An earlier creation for “\(topic)” has an unknown outcome. Retry it unchanged to check first."
            return nil
        }

        let ok = await executeSave(
            record: claimed,
            ownerToken: attemptToken,
            wasAlreadyUnknown: claimed.outcomeUnknown,
            boundEditSessionID: nil,
            boundCreateSessionID: createSession.id
        )
        guard ok else { return nil }
        return topics?.first(where: { $0.fileID == claimed.fileID || $0.topic == topic })
    }

    /// Bound retry strictly tied to the named action's commandID, fileID, baseVersion, and markdown.
    func retryPendingSave(_ item: WikiPendingSaveRetry) async -> Bool {
        guard !isRetired else { return false }
        guard api.session.isActive else {
            clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            return false
        }
        guard !isSaving else { return false }
        let permitted = item.baseVersion == 0 ? canCreate : canUpdate
        guard permitted else { return false }
        guard let existing = pendingSaves[item.fileID],
              existing.outcomeUnknown,
              existing.commitCommandID == item.commandID,
              existing.topic == item.topic,
              existing.baseVersion == item.baseVersion,
              existing.markdown == item.markdown else { return false }

        let attemptToken = UUID()
        let updated = WikiPendingSave(
            sessionID: existing.sessionID,
            workspaceID: existing.workspaceID,
            fileID: existing.fileID,
            topic: existing.topic,
            fileName: existing.fileName,
            baseVersion: existing.baseVersion,
            markdown: existing.markdown,
            versionID: existing.versionID,
            createCommandID: existing.createCommandID,
            commitCommandID: existing.commitCommandID,
            slot: existing.slot,
            uploaded: existing.uploaded,
            ownerToken: attemptToken,
            outcomeUnknown: true
        )
        pendingSaves[item.fileID] = updated
        return await executeSave(
            record: updated,
            ownerToken: attemptToken,
            wasAlreadyUnknown: true,
            boundEditSessionID: nil,
            boundCreateSessionID: nil
        )
    }

    private func claimPendingSave(
        fileID: UUID,
        topic: String,
        fileName: String,
        baseVersion: Int,
        markdown: String,
        ownerToken: UUID
    ) -> WikiPendingSave? {
        if let existing = pendingSaves[fileID], existing.sessionID == sessionID, existing.workspaceID == workspaceID {
            if existing.topic == topic && existing.baseVersion == baseVersion && existing.markdown == markdown {
                let claimed = WikiPendingSave(
                    sessionID: sessionID,
                    workspaceID: workspaceID,
                    fileID: fileID,
                    topic: topic,
                    fileName: fileName,
                    baseVersion: baseVersion,
                    markdown: markdown,
                    versionID: existing.versionID,
                    createCommandID: existing.createCommandID,
                    commitCommandID: existing.commitCommandID,
                    slot: existing.slot,
                    uploaded: existing.uploaded,
                    ownerToken: ownerToken,
                    outcomeUnknown: existing.outcomeUnknown
                )
                pendingSaves[fileID] = claimed
                return claimed
            } else if existing.outcomeUnknown {
                return nil
            }
        }
        let fresh = WikiPendingSave(
            sessionID: sessionID,
            workspaceID: workspaceID,
            fileID: fileID,
            topic: topic,
            fileName: fileName,
            baseVersion: baseVersion,
            markdown: markdown,
            versionID: UUID(),
            createCommandID: UUID(),
            commitCommandID: UUID(),
            slot: nil,
            uploaded: false,
            ownerToken: ownerToken,
            outcomeUnknown: false
        )
        pendingSaves[fileID] = fresh
        return fresh
    }

    private func executeSave(
        record: WikiPendingSave,
        ownerToken: UUID,
        wasAlreadyUnknown: Bool,
        boundEditSessionID: UUID?,
        boundCreateSessionID: UUID?
    ) async -> Bool {
        let capturedSession = api.session
        let capturedAccessGen = accessGeneration
        let dispatchFlag = WikiDispatchFlag()

        let writeGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            guard !self.isRetired,
                  capturedSession.isActive,
                  self.accessGeneration == capturedAccessGen else { return false }
            let permitted = record.baseVersion == 0 ? self.canCreate : self.canUpdate
            guard permitted else { return false }
            if let boundEditSessionID {
                guard self.activeEditSession?.id == boundEditSessionID,
                      let live = self.topics?.first(where: { $0.fileID == record.fileID }),
                      live.currentVersion == record.baseVersion else { return false }
            }
            if let boundCreateSessionID {
                guard self.activeCreateSession?.id == boundCreateSessionID else { return false }
            }
            dispatchFlag.entered = true
            if var current = self.pendingSaves[record.fileID], current.commitCommandID == record.commitCommandID {
                current.outcomeUnknown = true
                self.pendingSaves[record.fileID] = current
            }
            return true
        }

        isSaving = true
        statusMessage = nil
        actionError = nil
        defer { isSaving = false }

        let outcome = await api.saveTopicVersion(
            workspaceID: workspaceID,
            fileID: record.fileID,
            fileName: record.fileName,
            ifVersion: record.baseVersion,
            markdown: record.markdown,
            versionID: record.versionID,
            createCommandID: record.createCommandID,
            commitCommandID: record.commitCommandID,
            existingSlot: record.slot,
            alreadyUploaded: record.uploaded,
            canDispatch: writeGate
        )

        if !dispatchFlag.entered {
            if !wasAlreadyUnknown,
               let current = pendingSaves[record.fileID],
               current.commitCommandID == record.commitCommandID,
               current.ownerToken == ownerToken,
               !current.outcomeUnknown {
                pendingSaves.removeValue(forKey: record.fileID)
            }
            if !capturedSession.isActive {
                clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            }
            return false
        }

        guard !Task.isCancelled, !isRetired, capturedSession.isActive, accessGeneration == capturedAccessGen else {
            if !capturedSession.isActive {
                clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            }
            return false
        }

        let actionName = record.baseVersion == 0 ? "wiki page creation" : "wiki edit"
        switch outcome {
        case .committed(let savedFileID, let savedVersion, _, let replayed):
            if pendingSaves[record.fileID]?.commitCommandID == record.commitCommandID {
                pendingSaves.removeValue(forKey: record.fileID)
            }
            activeEditSession = nil
            activeCreateSession = nil

            let existingVersion = topics?.first(where: { $0.fileID == savedFileID })?.currentVersion ?? 0
            let regressed = savedVersion < existingVersion
            statusMessage = regressed
                ? "Earlier \(actionName) (v\(savedVersion)) was already saved."
                : "Saved \(record.topic) as v\(savedVersion)."

            if !regressed {
                _ = await loadTopics(preserveNotice: true)
                if activeFileID == savedFileID || record.baseVersion == 0 {
                    if let refreshed = topics?.first(where: { $0.fileID == savedFileID }),
                       refreshed.currentVersion >= savedVersion {
                        if !replayed || refreshed.currentVersion == savedVersion {
                            activeFileID = savedFileID
                            activeVersion = refreshed.currentVersion
                            activeMarkdown = refreshed.currentVersion == savedVersion ? record.markdown : activeMarkdown
                            if refreshed.currentVersion > savedVersion {
                                await openTopic(fileID: savedFileID, version: refreshed.currentVersion)
                            }
                        }
                    }
                }
            }
            return true

        case .conflict(_, let message):
            if pendingSaves[record.fileID]?.commitCommandID == record.commitCommandID {
                pendingSaves.removeValue(forKey: record.fileID)
            }
            activeEditSession = nil
            actionError = message
            _ = await loadTopics(preserveNotice: true)
            if activeFileID == record.fileID,
               let refreshed = topics?.first(where: { $0.fileID == record.fileID }) {
                await openTopic(fileID: record.fileID, version: refreshed.currentVersion)
            }
            return false

        case .refused(let reason, let message):
            let keepUnknown = wasAlreadyUnknown
            let display = keepUnknown
                ? WikiRules.unknownOutcomeAfterRefusalMessage(action: actionName, refusalMessage: message)
                : message
            if !keepUnknown,
               let current = pendingSaves[record.fileID],
               current.commitCommandID == record.commitCommandID,
               current.ownerToken == ownerToken {
                pendingSaves.removeValue(forKey: record.fileID)
            }
            if WikiRules.isAccessLossReason(reason) {
                clearOnAccessLoss(reason: reason, clearPending: !capturedSession.isActive)
            } else if reason == "content_read_only" {
                accessGeneration += 1
                access = WikiAccess(canRead: true, canCreate: false, canUpdate: false)
                closeWriteSurfaces()
            }
            actionError = display
            return false

        case .unconfirmed(let message, let slot, let uploaded):
            if var current = pendingSaves[record.fileID], current.commitCommandID == record.commitCommandID {
                current.slot = slot ?? current.slot
                current.uploaded = current.uploaded || uploaded
                current.outcomeUnknown = true
                pendingSaves[record.fileID] = current
            }
            actionError = message
            return false

        case .cancelled:
            actionError = "Your \(actionName) outcome is unknown. Retry unchanged to check."
            return false
        }
    }

    private func closeWriteSurfaces() {
        activeEditSession = nil
        activeCreateSession = nil
    }

    private func clearOnAccessLoss(reason: String, clearPending: Bool) {
        listGeneration += 1
        readGeneration += 1
        accessGeneration += 1
        isLoading = false
        isLoadingContent = false
        topics = nil
        access = nil
        activeFileID = nil
        activeVersion = nil
        activeMarkdown = nil
        activeVersionState = nil
        contentError = nil
        linkNotice = nil
        closeWriteSurfaces()
        loadFailure = .refused(reason)
        if clearPending {
            pendingSaves.removeAll()
        }
    }
}
