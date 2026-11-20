import Combine
import Foundation

enum DefinitionCertificationState: String, Equatable, Hashable, Sendable {
    case certified
    case proposalPending = "proposal_pending"
    case proposed

    var label: String {
        switch self {
        case .certified: "Certified"
        case .proposalPending: "Proposal pending"
        case .proposed: "Proposed"
        }
    }
}

struct DefinitionSummary: Identifiable, Hashable, Sendable {
    let objectID: String
    let term: String
    let revision: SharedRevisionRef
    let status: DefinitionCertificationState

    var id: String { objectID }
}

struct DefinitionFields: Equatable, Hashable, Sendable {
    let term: String
    let meaning: String
    let source: String
}

/// Frozen snapshot captured when the user explicitly opens the Edit sheet.
/// Edits ALWAYS send this exact `baseRevision` and `beforeFields` — never re-reading mutable `detail.current`.
struct DefinitionEditSession: Identifiable, Equatable, Sendable {
    let id = UUID()
    let objectID: String
    let baseRevision: SharedRevisionRef
    let beforeFields: DefinitionFields
}

struct DefinitionVersion: Equatable, Hashable, Sendable {
    let revision: SharedRevisionRef
    let term: String
    let meaning: String
    let source: String
    let authorLabel: String
    let authorIsAgent: Bool
    let occurredAtServerMs: Int64

    var fields: DefinitionFields {
        DefinitionFields(term: term, meaning: meaning, source: source)
    }

    var formattedSavedAt: String {
        DefinitionsRules.formatTimestampMs(occurredAtServerMs)
    }
}

struct DefinitionCertifiedVersion: Equatable, Hashable, Sendable {
    let revision: SharedRevisionRef
    let term: String
    let meaning: String
    let source: String
    let certifiedByLabel: String
    let certifiedAtMs: Int64?

    var formattedCertifiedAt: String {
        guard let certifiedAtMs else { return "" }
        return DefinitionsRules.formatTimestampMs(certifiedAtMs)
    }
}

struct DefinitionDetail: Equatable, Hashable, Sendable {
    let objectID: String
    let current: DefinitionVersion
    let certified: DefinitionCertifiedVersion?
    let proposalPending: Bool

    var status: DefinitionCertificationState {
        if !proposalPending && certified != nil {
            return .certified
        }
        return certified != nil ? .proposalPending : .proposed
    }
}

enum DefinitionMutationOutcome: Equatable, Sendable {
    case committed(objectID: String, revision: SharedRevisionRef)
    case conflict(message: String)
    case refused(reason: String, message: String)
    case unconfirmed(message: String)
    case cancelled
}

enum DefinitionsError: Error, Equatable, Sendable {
    case refused(reason: String)
    case unsupported
}

enum DefinitionsRules {
    static let maxTermLength = 80
    static let maxTextLength = 2_000
    static let maxListPages = 5

    static func normalizeTerm(_ raw: String) -> String {
        let singleLine = raw
            .replacingOccurrences(of: "\r\n", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
        return singleLine.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func normalizeBody(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func validateFields(term rawTerm: String, meaning rawMeaning: String, source rawSource: String) -> Result<DefinitionFields, DefinitionValidationError> {
        let term = normalizeTerm(rawTerm)
        let meaning = normalizeBody(rawMeaning)
        let source = normalizeBody(rawSource)
        if term.isEmpty || meaning.isEmpty {
            return .failure(.missingRequired)
        }
        if term.count > maxTermLength || meaning.count > maxTextLength || source.count > maxTextLength {
            return .failure(.lengthExceeded)
        }
        return .success(DefinitionFields(term: term, meaning: meaning, source: source))
    }

    static func makeObjectID(term: String, existingIDs: Set<String>) -> String {
        let lowered = term.lowercased()
        var slug = ""
        var lastWasDash = false
        for scalar in lowered.unicodeScalars {
            if (scalar >= "a" && scalar <= "z") || (scalar >= "0" && scalar <= "9") {
                slug.unicodeScalars.append(scalar)
                lastWasDash = false
            } else if !lastWasDash && !slug.isEmpty {
                slug.append("-")
                lastWasDash = true
            }
        }
        while slug.hasSuffix("-") {
            slug.removeLast()
        }
        let base = slug.isEmpty ? "definition" : String(slug.prefix(48))
        var candidate = "def-\(base)"
        var suffix = 2
        while existingIDs.contains(candidate) {
            candidate = "def-\(base)-\(suffix)"
            suffix += 1
        }
        return candidate
    }

    static func filterDefinitions(_ definitions: [DefinitionSummary], query: String) -> [DefinitionSummary] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return definitions }
        return definitions.filter { $0.term.lowercased().contains(needle) }
    }

    static func formatTimestampMs(_ ms: Int64) -> String {
        guard ms > 0 else { return "" }
        let date = Date(timeIntervalSince1970: Double(ms) / 1000.0)
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    static func parseTimestampMs(string raw: String) -> Int64? {
        let withFrac = ISO8601DateFormatter()
        withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFrac.date(from: raw) {
            return Int64(d.timeIntervalSince1970 * 1000.0)
        }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let d = plain.date(from: raw) {
            return Int64(d.timeIntervalSince1970 * 1000.0)
        }
        return nil
    }

    static func refusalMessage(_ reason: String, fallback: String = "Couldn’t save definition.") -> String {
        switch reason {
        case "definition_term_taken":
            return "A definition with this term already exists in this workspace."
        case "definition_invalid":
            return "Use a one-line term up to 80 characters and a meaning up to 2,000 characters."
        case "definition_not_current":
            return "A newer version was saved since you opened this definition. Reloaded the latest version for review."
        case "human_confirmation_required":
            return "Only a workspace member can certify a definition."
        case "content_read_only":
            return "This action was refused because you have reader access."
        case "content_consent_required":
            return "Confirm Lists & docs access before changing definitions."
        case "patch_base_mismatch":
            return "This definition changed since you loaded it. Reload it to review."
        case "revision_not_found", "not_found", "workspace_not_found":
            return "This definition is no longer available."
        case "object_quota_reached":
            return "This workspace reached its list and document limit."
        case "storage_quota_reached":
            return "The workspace storage limit is full."
        case "unauthorized":
            return "Your session expired. Sign in again to access definitions."
        case "forbidden", "workspace_access_refused", "connection_access_refused":
            return "You don’t have access to definitions in this workspace."
        default:
            return fallback
        }
    }

    static func isAccessLossReason(_ reason: String) -> Bool {
        reason == "workspace_access_refused"
            || reason == "connection_access_refused"
            || reason == "content_consent_required"
            || reason == "forbidden"
            || reason == "unauthorized"
            || reason == "not_found"
            || reason == "workspace_not_found"
    }

    /// Refusals that can occur BEFORE the server checks the idempotency receipt table.
    /// These cannot establish whether an earlier dispatched write committed.
    static func isPreReceiptRefusal(_ reason: String) -> Bool {
        isAccessLossReason(reason)
            || reason == "content_read_only"
            || reason == "human_confirmation_required"
            || reason == "rate_limited"
            || reason == "todo_write_rate_limited"
            || reason == "seat_binding_mismatch"
            || reason == "revision_not_found"
    }

    static func unknownOutcomeAfterRefusalMessage(action: String, refusalMessage: String) -> String {
        "Your earlier \(action) outcome is still unknown and may already have saved; this retry was refused (\(refusalMessage)). Retry unchanged once access is restored to check."
    }
}

enum DefinitionValidationError: Error, Equatable, Sendable {
    case missingRequired
    case lengthExceeded

    var message: String {
        switch self {
        case .missingRequired:
            return "Enter both a term and its meaning."
        case .lengthExceeded:
            return "Use a one-line term up to 80 characters and a meaning or source up to 2,000 characters."
        }
    }
}

@MainActor
private final class DispatchFlag {
    var entered = false
}

@MainActor
final class DefinitionsListStore: ObservableObject {
    struct PendingCreateRecord: Equatable, Sendable {
        let sessionID: ObjectIdentifier
        let fields: DefinitionFields
        let commandID: UUID
        let objectID: String
        var outcomeUnknown: Bool
    }

    @Published private(set) var definitions: [DefinitionSummary] = []
    @Published private(set) var access: SharedAccess?
    @Published private(set) var accessError: String?
    @Published private(set) var needsConsent = false
    @Published private(set) var isUnsupported = false
    @Published private(set) var isLoading = false
    @Published private(set) var loadFailed = false
    @Published private(set) var isCreating = false
    @Published private(set) var createError: String?
    @Published private(set) var statusMessage: String?
    @Published var showingCreateSheet = false
    @Published var searchQuery = ""

    let workspaceID: UUID
    private var loadGeneration = 0
    private var accessGeneration = 0
    private var isRetired = false
    private var activeSessionID: ObjectIdentifier?
    private(set) var pendingCreate: PendingCreateRecord?

    init(workspaceID: UUID) {
        self.workspaceID = workspaceID
    }

    var canEdit: Bool {
        !isRetired && access?.canCreate == true && access?.canUpdate == true
    }

    var hasUnknownPendingCreate: Bool {
        pendingCreate?.outcomeUnknown == true
    }

    var filteredDefinitions: [DefinitionSummary] {
        DefinitionsRules.filterDefinitions(definitions, query: searchQuery)
    }

    func retire() {
        isRetired = true
        loadGeneration += 1
        accessGeneration += 1
        isLoading = false
        showingCreateSheet = false
    }

    func activate() {
        if isRetired {
            isRetired = false
        }
    }

    private func bindSession(_ session: HumanSession) -> Bool {
        let sid = ObjectIdentifier(session)
        if let previous = activeSessionID, previous != sid {
            clearOnAccessLoss(message: DefinitionsRules.refusalMessage("unauthorized"), consent: false, clearPending: true)
        }
        activeSessionID = sid
        guard session.isActive else {
            clearOnAccessLoss(message: DefinitionsRules.refusalMessage("unauthorized"), consent: false, clearPending: true)
            return false
        }
        return true
    }

    private func canCommitRead(generation: Int, capturedAccessGen: Int, session: HumanSession) -> Bool {
        !Task.isCancelled
            && !isRetired
            && session.isActive
            && generation == loadGeneration
            && capturedAccessGen == accessGeneration
            && activeSessionID == ObjectIdentifier(session)
    }

    func load(api: DefinitionsAPI) async {
        activate()
        guard bindSession(api.session) else { return }

        loadGeneration += 1
        let generation = loadGeneration
        var capturedAccessGen = accessGeneration
        let capturedSession = api.session
        let sessionID = ObjectIdentifier(capturedSession)
        isLoading = true
        loadFailed = false
        isUnsupported = false

        let accessGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            return !self.isRetired
                && capturedSession.isActive
                && self.activeSessionID == sessionID
                && self.loadGeneration == generation
                && self.accessGeneration == capturedAccessGen
        }

        do {
            let status = try await api.access(workspaceID: workspaceID, canDispatch: accessGate)
            guard canCommitRead(generation: generation, capturedAccessGen: capturedAccessGen, session: capturedSession) else { return }
            switch status {
            case .needsConfirmation(let reason):
                clearOnAccessLoss(message: DefinitionsRules.refusalMessage(reason), consent: true, clearPending: false)
                return
            case .refused(let reason):
                // Same-login HTTP 401 retires display state while preserving unresolved intent until sign-out or receipt lookup.
                clearOnAccessLoss(
                    message: DefinitionsRules.refusalMessage(reason),
                    consent: false,
                    clearPending: !capturedSession.isActive
                )
                return
            case .granted(let granted):
                let wasEditor = access?.canCreate == true && access?.canUpdate == true
                access = granted
                accessError = nil
                needsConsent = false
                if wasEditor && !canEdit {
                    // Editor -> Reader refresh advances write fence so any in-flight write cannot dispatch or settle.
                    accessGeneration += 1
                    capturedAccessGen = accessGeneration
                    showingCreateSheet = false
                }
            }

            let listAccessGen = capturedAccessGen
            let listGate: @MainActor @Sendable () -> Bool = { [weak self] in
                guard let self else { return false }
                return !self.isRetired
                    && capturedSession.isActive
                    && self.activeSessionID == sessionID
                    && self.loadGeneration == generation
                    && self.accessGeneration == listAccessGen
            }
            let loaded = try await api.listDefinitions(workspaceID: workspaceID, canDispatch: listGate)
            guard canCommitRead(generation: generation, capturedAccessGen: listAccessGen, session: capturedSession) else { return }
            definitions = loaded
            loadFailed = false
            // Bounded definitions_search cannot prove whether an unresolved create committed or was omitted.
            // Keep pendingCreate unresolved until its receipt lookup gives a definite answer.
        } catch DefinitionsError.unsupported {
            guard canCommitRead(generation: generation, capturedAccessGen: capturedAccessGen, session: capturedSession) else { return }
            definitions = []
            isUnsupported = true
            loadFailed = false
        } catch DefinitionsError.refused(let reason) {
            guard !Task.isCancelled, !isRetired,
                  generation == loadGeneration, capturedAccessGen == accessGeneration else { return }
            if DefinitionsRules.isAccessLossReason(reason) {
                clearOnAccessLoss(
                    message: DefinitionsRules.refusalMessage(reason),
                    consent: reason == "content_consent_required",
                    clearPending: !capturedSession.isActive
                )
            } else {
                loadFailed = true
            }
        } catch is CancellationError {
            if !capturedSession.isActive {
                clearOnAccessLoss(message: DefinitionsRules.refusalMessage("unauthorized"), consent: false, clearPending: true)
            }
            return
        } catch {
            guard canCommitRead(generation: generation, capturedAccessGen: capturedAccessGen, session: capturedSession) else { return }
            loadFailed = true
        }

        if generation == loadGeneration && capturedAccessGen == accessGeneration {
            isLoading = false
        }
    }

    func openCreateSheet() {
        guard canEdit else { return }
        if pendingCreate?.outcomeUnknown != true {
            createError = nil
        }
        showingCreateSheet = true
    }

    func retryPendingCreate(api: DefinitionsAPI) async -> String? {
        guard let pending = pendingCreate, pending.outcomeUnknown else { return nil }
        return await createDefinition(
            term: pending.fields.term,
            meaning: pending.fields.meaning,
            source: pending.fields.source,
            api: api
        )
    }

    /// Creates a new definition, gating dispatch right before transport and preserving unresolved command identity
    /// across retired responses, sheet reopen, inconclusive reads, and pre-receipt refusals (including same-login 401).
    func createDefinition(
        term rawTerm: String,
        meaning rawMeaning: String,
        source rawSource: String,
        api: DefinitionsAPI
    ) async -> String? {
        guard !isRetired else { return nil }
        guard bindSession(api.session) else { return nil }
        guard canEdit, !isCreating else { return nil }

        let validated: DefinitionFields
        switch DefinitionsRules.validateFields(term: rawTerm, meaning: rawMeaning, source: rawSource) {
        case .success(let fields):
            validated = fields
        case .failure(let err):
            createError = err.message
            return nil
        }

        let capturedSession = api.session
        let sessionID = ObjectIdentifier(capturedSession)
        let capturedAccessGen = accessGeneration

        let record: PendingCreateRecord
        if let existing = pendingCreate, existing.sessionID == sessionID {
            if existing.fields == validated {
                record = existing
            } else if existing.outcomeUnknown {
                createError = "An earlier create for “\(existing.fields.term)” has an unknown outcome. Retry that unchanged save to check its status before creating a different definition."
                return nil
            } else {
                record = PendingCreateRecord(
                    sessionID: sessionID,
                    fields: validated,
                    commandID: UUID(),
                    objectID: DefinitionsRules.makeObjectID(
                        term: validated.term,
                        existingIDs: Set(definitions.map(\.objectID))
                    ),
                    outcomeUnknown: false
                )
                pendingCreate = record
            }
        } else {
            record = PendingCreateRecord(
                sessionID: sessionID,
                fields: validated,
                commandID: UUID(),
                objectID: DefinitionsRules.makeObjectID(
                    term: validated.term,
                    existingIDs: Set(definitions.map(\.objectID))
                ),
                outcomeUnknown: false
            )
            pendingCreate = record
        }

        let wasAlreadyUnknown = record.outcomeUnknown
        let dispatchFlag = DispatchFlag()

        let writeGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            guard !self.isRetired,
                  capturedSession.isActive,
                  self.activeSessionID == sessionID,
                  self.accessGeneration == capturedAccessGen,
                  self.canEdit else {
                return false
            }
            // Record potential dispatch BEFORE transport sends so a retired first response still leaves outcomeUnknown == true.
            dispatchFlag.entered = true
            if var current = self.pendingCreate, current.commandID == record.commandID {
                current.outcomeUnknown = true
                self.pendingCreate = current
            }
            return true
        }

        isCreating = true
        createError = nil
        statusMessage = nil
        defer { isCreating = false }

        let outcome = await api.createDefinition(
            workspaceID: workspaceID,
            objectID: record.objectID,
            fields: record.fields,
            requestID: record.commandID,
            canDispatch: writeGate
        )

        // If cancelled BEFORE entering transport, roll back an unused non-unknown record.
        if !dispatchFlag.entered {
            if !wasAlreadyUnknown, pendingCreate?.commandID == record.commandID {
                pendingCreate = nil
            }
            if !capturedSession.isActive {
                clearOnAccessLoss(message: DefinitionsRules.refusalMessage("unauthorized"), consent: false, clearPending: true)
            }
            return nil
        }

        guard !Task.isCancelled, !isRetired, capturedSession.isActive, activeSessionID == sessionID else {
            if !capturedSession.isActive {
                clearOnAccessLoss(message: DefinitionsRules.refusalMessage("unauthorized"), consent: false, clearPending: true)
            }
            return nil
        }
        guard capturedAccessGen == accessGeneration else { return nil }

        switch outcome {
        case .committed(let committedID, _):
            pendingCreate = nil
            showingCreateSheet = false
            await load(api: api)
            return committedID
        case .conflict(let message):
            pendingCreate = nil
            createError = message
            await load(api: api)
            return nil
        case .refused(let reason, let message):
            let preReceipt = DefinitionsRules.isPreReceiptRefusal(reason)
            let keepUnknown = wasAlreadyUnknown && preReceipt
            let displayMessage = keepUnknown
                ? DefinitionsRules.unknownOutcomeAfterRefusalMessage(action: "create", refusalMessage: message)
                : message
            if !keepUnknown {
                pendingCreate = nil
            }
            if DefinitionsRules.isAccessLossReason(reason) {
                clearOnAccessLoss(
                    message: displayMessage,
                    consent: reason == "content_consent_required",
                    clearPending: !capturedSession.isActive
                )
                createError = displayMessage
            } else if reason == "content_read_only" {
                downgradeToReader()
                createError = displayMessage
            } else {
                createError = displayMessage
            }
            return nil
        case .unconfirmed(let message):
            createError = message
            return nil
        case .cancelled:
            createError = "Your create outcome is unknown. Retry unchanged to check."
            return nil
        }
    }

    private func clearOnAccessLoss(message: String, consent: Bool, clearPending: Bool) {
        loadGeneration += 1
        accessGeneration += 1
        isLoading = false
        definitions = []
        access = nil
        accessError = message
        needsConsent = consent
        showingCreateSheet = false
        if clearPending {
            pendingCreate = nil
        }
        loadFailed = false
    }

    private func downgradeToReader() {
        accessGeneration += 1
        access = SharedAccess(role: .reader, operations: ["read"])
        showingCreateSheet = false
    }
}

@MainActor
final class DefinitionDetailStore: ObservableObject {
    struct PendingCertifyRecord: Equatable, Sendable {
        let sessionID: ObjectIdentifier
        let revision: SharedRevisionRef
        let commandID: UUID
        var outcomeUnknown: Bool
    }

    struct PendingUpdateRecord: Equatable, Sendable {
        let sessionID: ObjectIdentifier
        let baseRevision: SharedRevisionRef
        let beforeFields: DefinitionFields
        let afterFields: DefinitionFields
        let commandID: UUID
        var outcomeUnknown: Bool
    }

    @Published private(set) var detail: DefinitionDetail?
    @Published private(set) var access: SharedAccess?
    @Published private(set) var accessError: String?
    @Published private(set) var needsConsent = false
    @Published private(set) var isLoading = false
    @Published private(set) var loadFailed = false
    @Published private(set) var isSaving = false
    @Published private(set) var statusMessage: String?
    @Published private(set) var errorMessage: String?
    @Published var activeEditSession: DefinitionEditSession?

    let workspaceID: UUID
    let objectID: String
    private var loadGeneration = 0
    private var accessGeneration = 0
    private var isRetired = false
    private var activeSessionID: ObjectIdentifier?
    private(set) var pendingCertify: PendingCertifyRecord?
    private(set) var pendingUpdate: PendingUpdateRecord?

    init(workspaceID: UUID, objectID: String) {
        self.workspaceID = workspaceID
        self.objectID = objectID
    }

    var canEdit: Bool {
        !isRetired && access?.canUpdate == true && detail != nil
    }

    var canCertify: Bool {
        canEdit && detail?.proposalPending == true
    }

    var hasUnknownPendingCertify: Bool {
        pendingCertify?.outcomeUnknown == true
    }

    var hasUnknownPendingUpdate: Bool {
        pendingUpdate?.outcomeUnknown == true
    }

    func retire() {
        isRetired = true
        loadGeneration += 1
        accessGeneration += 1
        isLoading = false
        activeEditSession = nil
    }

    func activate() {
        if isRetired {
            isRetired = false
        }
    }

    @discardableResult
    func beginEdit() -> DefinitionEditSession? {
        guard canEdit, let current = detail?.current else { return nil }
        let session = DefinitionEditSession(
            objectID: objectID,
            baseRevision: current.revision,
            beforeFields: current.fields
        )
        activeEditSession = session
        if !hasUnknownPendingUpdate {
            errorMessage = nil
        }
        return session
    }

    private func bindSession(_ session: HumanSession) -> Bool {
        let sid = ObjectIdentifier(session)
        if let previous = activeSessionID, previous != sid {
            clearOnAccessLoss(message: DefinitionsRules.refusalMessage("unauthorized"), consent: false, clearPending: true)
        }
        activeSessionID = sid
        guard session.isActive else {
            clearOnAccessLoss(message: DefinitionsRules.refusalMessage("unauthorized"), consent: false, clearPending: true)
            return false
        }
        return true
    }

    private func canCommitRead(generation: Int, capturedAccessGen: Int, session: HumanSession) -> Bool {
        !Task.isCancelled
            && !isRetired
            && session.isActive
            && generation == loadGeneration
            && capturedAccessGen == accessGeneration
            && activeSessionID == ObjectIdentifier(session)
    }

    func load(api: DefinitionsAPI, preserveNotice: Bool = false) async {
        activate()
        guard bindSession(api.session) else { return }

        loadGeneration += 1
        let generation = loadGeneration
        var capturedAccessGen = accessGeneration
        let capturedSession = api.session
        let sessionID = ObjectIdentifier(capturedSession)
        isLoading = true
        loadFailed = false
        if !preserveNotice {
            statusMessage = nil
            errorMessage = nil
        }

        let accessGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            return !self.isRetired
                && capturedSession.isActive
                && self.activeSessionID == sessionID
                && self.loadGeneration == generation
                && self.accessGeneration == capturedAccessGen
        }

        do {
            let status = try await api.access(workspaceID: workspaceID, canDispatch: accessGate)
            guard canCommitRead(generation: generation, capturedAccessGen: capturedAccessGen, session: capturedSession) else { return }
            switch status {
            case .needsConfirmation(let reason):
                clearOnAccessLoss(message: DefinitionsRules.refusalMessage(reason), consent: true, clearPending: false)
                return
            case .refused(let reason):
                // Same-login 401 retires display state without dropping unresolved pending writes.
                clearOnAccessLoss(
                    message: DefinitionsRules.refusalMessage(reason),
                    consent: false,
                    clearPending: !capturedSession.isActive
                )
                return
            case .granted(let granted):
                let wasEditor = access?.canUpdate == true
                access = granted
                accessError = nil
                needsConsent = false
                if wasEditor && !granted.canUpdate {
                    // Editor -> Reader refresh advances write fence so any held write cannot dispatch or settle.
                    accessGeneration += 1
                    capturedAccessGen = accessGeneration
                    activeEditSession = nil
                } else if !granted.canUpdate {
                    activeEditSession = nil
                }
            }

            let readAccessGen = capturedAccessGen
            let readGate: @MainActor @Sendable () -> Bool = { [weak self] in
                guard let self else { return false }
                return !self.isRetired
                    && capturedSession.isActive
                    && self.activeSessionID == sessionID
                    && self.loadGeneration == generation
                    && self.accessGeneration == readAccessGen
            }
            let loaded = try await api.readDefinition(workspaceID: workspaceID, objectID: objectID, canDispatch: readGate)
            guard canCommitRead(generation: generation, capturedAccessGen: readAccessGen, session: capturedSession) else { return }
            detail = loaded
            loadFailed = false

            // If an editor was open on an older revision, retire it so the user reviews the latest revision first.
            if let open = activeEditSession, open.baseRevision.token != loaded.current.revision.token {
                activeEditSession = nil
            }
            // Do NOT clear pendingCertify or pendingUpdate on a generic detail read — only receipt lookup
            // establishes a definite answer for an already-dispatched write.
        } catch DefinitionsError.refused(let reason) {
            guard !Task.isCancelled, !isRetired,
                  generation == loadGeneration, capturedAccessGen == accessGeneration else { return }
            if DefinitionsRules.isAccessLossReason(reason) || reason == "revision_not_found" {
                clearOnAccessLoss(
                    message: DefinitionsRules.refusalMessage(reason),
                    consent: reason == "content_consent_required",
                    clearPending: !capturedSession.isActive
                )
            } else {
                loadFailed = true
            }
        } catch is CancellationError {
            if !capturedSession.isActive {
                clearOnAccessLoss(message: DefinitionsRules.refusalMessage("unauthorized"), consent: false, clearPending: true)
            }
            return
        } catch {
            guard canCommitRead(generation: generation, capturedAccessGen: capturedAccessGen, session: capturedSession) else { return }
            loadFailed = true
        }

        if generation == loadGeneration && capturedAccessGen == accessGeneration {
            isLoading = false
        }
    }

    func retryPendingCertify(api: DefinitionsAPI) async -> Bool {
        guard !isRetired else { return false }
        guard bindSession(api.session) else { return false }
        guard canEdit, !isSaving,
              let pending = pendingCertify,
              pending.sessionID == ObjectIdentifier(api.session),
              pending.outcomeUnknown else {
            return false
        }
        return await executeCertify(record: pending, api: api)
    }

    func certify(api: DefinitionsAPI) async -> Bool {
        guard !isRetired else { return false }
        guard bindSession(api.session) else { return false }
        let sessionID = ObjectIdentifier(api.session)
        // If an unresolved certification already exists for this login, allow replaying it even if detail refreshed.
        if let existing = pendingCertify, existing.sessionID == sessionID, existing.outcomeUnknown {
            if let currentToken = detail?.current.revision.token, existing.revision.token == currentToken {
                return await executeCertify(record: existing, api: api)
            }
            errorMessage = "An earlier certification has an unknown outcome. Retry that pending certification to confirm its result before certifying another version."
            return false
        }
        guard canCertify, !isSaving, let current = detail?.current else { return false }
        let record = PendingCertifyRecord(sessionID: sessionID, revision: current.revision, commandID: UUID(), outcomeUnknown: false)
        pendingCertify = record
        return await executeCertify(record: record, api: api)
    }

    private func executeCertify(record: PendingCertifyRecord, api: DefinitionsAPI) async -> Bool {
        guard canEdit, !isSaving else { return false }
        let capturedSession = api.session
        let sessionID = ObjectIdentifier(capturedSession)
        let capturedAccessGen = accessGeneration
        let wasAlreadyUnknown = record.outcomeUnknown
        let dispatchFlag = DispatchFlag()

        let writeGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            let allowed = wasAlreadyUnknown ? self.canEdit : self.canCertify
            guard !self.isRetired,
                  capturedSession.isActive,
                  self.activeSessionID == sessionID,
                  self.accessGeneration == capturedAccessGen,
                  allowed else {
                return false
            }
            dispatchFlag.entered = true
            if var current = self.pendingCertify, current.commandID == record.commandID {
                current.outcomeUnknown = true
                self.pendingCertify = current
            }
            return true
        }

        isSaving = true
        statusMessage = nil
        errorMessage = nil
        defer { isSaving = false }

        let outcome = await api.certifyDefinition(
            workspaceID: workspaceID,
            objectID: objectID,
            revision: record.revision,
            requestID: record.commandID,
            canDispatch: writeGate
        )

        if !dispatchFlag.entered {
            if !wasAlreadyUnknown, pendingCertify?.commandID == record.commandID {
                pendingCertify = nil
            }
            if !capturedSession.isActive {
                clearOnAccessLoss(message: DefinitionsRules.refusalMessage("unauthorized"), consent: false, clearPending: true)
            }
            return false
        }

        guard !Task.isCancelled, !isRetired, capturedSession.isActive, activeSessionID == sessionID else {
            if !capturedSession.isActive {
                clearOnAccessLoss(message: DefinitionsRules.refusalMessage("unauthorized"), consent: false, clearPending: true)
            }
            return false
        }
        guard capturedAccessGen == accessGeneration else { return false }

        switch outcome {
        case .committed:
            pendingCertify = nil
            statusMessage = "Certified."
            await load(api: api, preserveNotice: true)
            return true
        case .conflict(let message):
            pendingCertify = nil
            errorMessage = message
            await load(api: api, preserveNotice: true)
            return false
        case .refused(let reason, let message):
            let preReceipt = DefinitionsRules.isPreReceiptRefusal(reason)
            let keepUnknown = wasAlreadyUnknown && preReceipt
            let displayMessage = keepUnknown
                ? DefinitionsRules.unknownOutcomeAfterRefusalMessage(action: "certification", refusalMessage: message)
                : message
            if !keepUnknown {
                pendingCertify = nil
            }
            if reason == "definition_not_current" {
                errorMessage = displayMessage
                await load(api: api, preserveNotice: true)
            } else if DefinitionsRules.isAccessLossReason(reason) || reason == "revision_not_found" {
                clearOnAccessLoss(
                    message: displayMessage,
                    consent: reason == "content_consent_required",
                    clearPending: !capturedSession.isActive
                )
                errorMessage = displayMessage
            } else if reason == "content_read_only" {
                downgradeToReader()
                errorMessage = displayMessage
            } else {
                errorMessage = displayMessage
            }
            return false
        case .unconfirmed(let message):
            errorMessage = message
            return false
        case .cancelled:
            errorMessage = "Your certification outcome is unknown. Retry unchanged to check."
            return false
        }
    }

    func retryPendingUpdate(api: DefinitionsAPI) async -> Bool {
        guard !isRetired else { return false }
        guard bindSession(api.session) else { return false }
        guard canEdit, !isSaving,
              let pending = pendingUpdate,
              pending.sessionID == ObjectIdentifier(api.session),
              pending.outcomeUnknown else {
            return false
        }
        return await executeUpdate(record: pending, boundEditSessionID: nil, api: api)
    }

    /// Submits an edit strictly bound to the frozen `session` opened by the user.
    /// Never re-reads `detail.current` to rebase a stale editor onto a newer revision.
    func update(
        session editSession: DefinitionEditSession,
        term rawTerm: String,
        meaning rawMeaning: String,
        source rawSource: String,
        api: DefinitionsAPI
    ) async -> Bool {
        guard !isRetired else { return false }
        guard bindSession(api.session) else { return false }
        guard canEdit, !isSaving else { return false }
        guard activeEditSession?.id == editSession.id,
              editSession.objectID == objectID,
              detail?.current.revision.token == editSession.baseRevision.token else {
            activeEditSession = nil
            errorMessage = "A newer version was loaded. Review it, then tap Edit to start from the latest version."
            return false
        }

        let validated: DefinitionFields
        switch DefinitionsRules.validateFields(term: rawTerm, meaning: rawMeaning, source: rawSource) {
        case .success(let fields):
            validated = fields
        case .failure(let err):
            errorMessage = err.message
            return false
        }

        let sessionID = ObjectIdentifier(api.session)
        let record: PendingUpdateRecord
        if let existing = pendingUpdate, existing.sessionID == sessionID {
            if existing.baseRevision.token == editSession.baseRevision.token
                && existing.beforeFields == editSession.beforeFields
                && existing.afterFields == validated {
                record = existing
            } else if existing.outcomeUnknown {
                errorMessage = "An earlier edit has an unknown outcome. Retry that unchanged save to check its status before saving different changes."
                return false
            } else {
                record = PendingUpdateRecord(
                    sessionID: sessionID,
                    baseRevision: editSession.baseRevision,
                    beforeFields: editSession.beforeFields,
                    afterFields: validated,
                    commandID: UUID(),
                    outcomeUnknown: false
                )
                pendingUpdate = record
            }
        } else {
            record = PendingUpdateRecord(
                sessionID: sessionID,
                baseRevision: editSession.baseRevision,
                beforeFields: editSession.beforeFields,
                afterFields: validated,
                commandID: UUID(),
                outcomeUnknown: false
            )
            pendingUpdate = record
        }

        return await executeUpdate(record: record, boundEditSessionID: editSession.id, api: api)
    }

    private func executeUpdate(
        record: PendingUpdateRecord,
        boundEditSessionID: UUID?,
        api: DefinitionsAPI
    ) async -> Bool {
        let capturedSession = api.session
        let sessionID = ObjectIdentifier(capturedSession)
        let capturedAccessGen = accessGeneration
        let wasAlreadyUnknown = record.outcomeUnknown
        let dispatchFlag = DispatchFlag()

        let writeGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            guard !self.isRetired,
                  capturedSession.isActive,
                  self.activeSessionID == sessionID,
                  self.accessGeneration == capturedAccessGen,
                  self.canEdit else {
                return false
            }
            if let boundEditSessionID {
                guard self.activeEditSession?.id == boundEditSessionID,
                      self.detail?.current.revision.token == record.baseRevision.token else {
                    return false
                }
            }
            dispatchFlag.entered = true
            if var current = self.pendingUpdate, current.commandID == record.commandID {
                current.outcomeUnknown = true
                self.pendingUpdate = current
            }
            return true
        }

        isSaving = true
        statusMessage = nil
        errorMessage = nil
        defer { isSaving = false }

        let outcome = await api.updateDefinition(
            workspaceID: workspaceID,
            objectID: objectID,
            base: record.baseRevision,
            before: record.beforeFields,
            after: record.afterFields,
            requestID: record.commandID,
            canDispatch: writeGate
        )

        if !dispatchFlag.entered {
            if !wasAlreadyUnknown, pendingUpdate?.commandID == record.commandID {
                pendingUpdate = nil
            }
            if !capturedSession.isActive {
                clearOnAccessLoss(message: DefinitionsRules.refusalMessage("unauthorized"), consent: false, clearPending: true)
            }
            return false
        }

        guard !Task.isCancelled, !isRetired, capturedSession.isActive, activeSessionID == sessionID else {
            if !capturedSession.isActive {
                clearOnAccessLoss(message: DefinitionsRules.refusalMessage("unauthorized"), consent: false, clearPending: true)
            }
            return false
        }
        guard capturedAccessGen == accessGeneration else { return false }

        switch outcome {
        case .committed:
            pendingUpdate = nil
            activeEditSession = nil
            statusMessage = "Saved."
            await load(api: api, preserveNotice: true)
            return true
        case .conflict(let message):
            // Conflict reached the reducer past receipt lookup -> definite non-commit; retire stale editor.
            activeEditSession = nil
            pendingUpdate = nil
            errorMessage = message
            await load(api: api, preserveNotice: true)
            return false
        case .refused(let reason, let message):
            let preReceipt = DefinitionsRules.isPreReceiptRefusal(reason)
            let keepUnknown = wasAlreadyUnknown && preReceipt
            let displayMessage = keepUnknown
                ? DefinitionsRules.unknownOutcomeAfterRefusalMessage(action: "edit", refusalMessage: message)
                : message
            if !keepUnknown {
                pendingUpdate = nil
            }
            if DefinitionsRules.isAccessLossReason(reason) || reason == "revision_not_found" {
                clearOnAccessLoss(
                    message: displayMessage,
                    consent: reason == "content_consent_required",
                    clearPending: !capturedSession.isActive
                )
                errorMessage = displayMessage
            } else if reason == "content_read_only" {
                downgradeToReader()
                errorMessage = displayMessage
            } else {
                errorMessage = displayMessage
            }
            return false
        case .unconfirmed(let message):
            errorMessage = message
            return false
        case .cancelled:
            errorMessage = "Your edit outcome is unknown. Retry unchanged to check."
            return false
        }
    }

    private func clearOnAccessLoss(message: String, consent: Bool, clearPending: Bool) {
        loadGeneration += 1
        accessGeneration += 1
        isLoading = false
        detail = nil
        access = nil
        accessError = message
        needsConsent = consent
        activeEditSession = nil
        if clearPending {
            pendingCertify = nil
            pendingUpdate = nil
        }
        loadFailed = false
    }

    private func downgradeToReader() {
        accessGeneration += 1
        access = SharedAccess(role: .reader, operations: ["read"])
        activeEditSession = nil
    }
}
