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
        case "revision_not_found":
            return "The version you started from is no longer available. Reload to review."
        case "object_quota_reached":
            return "This workspace reached its list and document limit."
        case "storage_quota_reached":
            return "The workspace storage limit is full."
        case "workspace_access_refused", "connection_access_refused":
            return "You don’t have access to definitions in this workspace."
        default:
            return fallback
        }
    }

    static func isAccessLossReason(_ reason: String) -> Bool {
        reason == "workspace_access_refused"
            || reason == "connection_access_refused"
            || reason == "content_consent_required"
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
final class DefinitionsListStore: ObservableObject {
    @Published private(set) var definitions: [DefinitionSummary] = []
    @Published private(set) var access: SharedAccess?
    @Published private(set) var accessError: String?
    @Published private(set) var needsConsent = false
    @Published private(set) var isUnsupported = false
    @Published private(set) var isLoading = false
    @Published private(set) var loadFailed = false
    @Published private(set) var isCreating = false
    @Published private(set) var createError: String?
    @Published var searchQuery = ""

    let workspaceID: UUID
    private var loadGeneration = 0
    private var pendingCreate: (fields: DefinitionFields, commandID: UUID, objectID: String)?

    init(workspaceID: UUID) {
        self.workspaceID = workspaceID
    }

    var canEdit: Bool {
        access?.canCreate == true && access?.canUpdate == true
    }

    var filteredDefinitions: [DefinitionSummary] {
        DefinitionsRules.filterDefinitions(definitions, query: searchQuery)
    }

    func load(api: DefinitionsAPI) async {
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        loadFailed = false
        isUnsupported = false

        do {
            let status = try await api.access(workspaceID: workspaceID)
            guard !Task.isCancelled, generation == loadGeneration else { return }
            switch status {
            case .needsConfirmation(let reason):
                clearOnAccessLoss(message: DefinitionsRules.refusalMessage(reason), consent: true)
                isLoading = false
                return
            case .refused(let reason):
                clearOnAccessLoss(message: DefinitionsRules.refusalMessage(reason), consent: false)
                isLoading = false
                return
            case .granted(let granted):
                access = granted
                accessError = nil
                needsConsent = false
            }

            let loaded = try await api.listDefinitions(workspaceID: workspaceID)
            guard !Task.isCancelled, generation == loadGeneration else { return }
            definitions = loaded
            loadFailed = false
        } catch DefinitionsError.unsupported {
            guard !Task.isCancelled, generation == loadGeneration else { return }
            definitions = []
            isUnsupported = true
            loadFailed = false
        } catch DefinitionsError.refused(let reason) {
            guard !Task.isCancelled, generation == loadGeneration else { return }
            if DefinitionsRules.isAccessLossReason(reason) {
                clearOnAccessLoss(
                    message: DefinitionsRules.refusalMessage(reason),
                    consent: reason == "content_consent_required"
                )
            } else {
                loadFailed = true
            }
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, generation == loadGeneration else { return }
            loadFailed = true
        }

        if generation == loadGeneration {
            isLoading = false
        }
    }

    /// Creates a new definition, reusing (commandID, objectID) across retries for identical fields.
    func createDefinition(
        term rawTerm: String,
        meaning rawMeaning: String,
        source rawSource: String,
        api: DefinitionsAPI
    ) async -> String? {
        guard canEdit, !isCreating else { return nil }
        let validated: DefinitionFields
        switch DefinitionsRules.validateFields(term: rawTerm, meaning: rawMeaning, source: rawSource) {
        case .success(let fields):
            validated = fields
        case .failure(let err):
            createError = err.message
            return nil
        }

        let commandID: UUID
        let objectID: String
        if let pending = pendingCreate, pending.fields == validated {
            commandID = pending.commandID
            objectID = pending.objectID
        } else {
            commandID = UUID()
            objectID = DefinitionsRules.makeObjectID(
                term: validated.term,
                existingIDs: Set(definitions.map(\.objectID))
            )
            pendingCreate = (validated, commandID, objectID)
        }

        isCreating = true
        createError = nil
        defer { isCreating = false }

        let outcome = await api.createDefinition(
            workspaceID: workspaceID,
            objectID: objectID,
            fields: validated,
            requestID: commandID
        )
        switch outcome {
        case .committed(let committedID, _):
            pendingCreate = nil
            await load(api: api)
            return committedID
        case .conflict(let message):
            pendingCreate = nil
            createError = message
            await load(api: api)
            return nil
        case .refused(let reason, let message):
            pendingCreate = nil
            if DefinitionsRules.isAccessLossReason(reason) {
                clearOnAccessLoss(message: message, consent: reason == "content_consent_required")
            } else if reason == "content_read_only" {
                downgradeToReader()
                createError = message
            } else {
                createError = message
            }
            return nil
        case .unconfirmed(let message):
            createError = message
            return nil
        }
    }

    func clearCreateError() {
        createError = nil
        pendingCreate = nil
    }

    private func clearOnAccessLoss(message: String, consent: Bool) {
        definitions = []
        access = nil
        accessError = message
        needsConsent = consent
        pendingCreate = nil
        loadFailed = false
    }

    private func downgradeToReader() {
        access = SharedAccess(role: .reader, operations: ["read"])
    }
}

@MainActor
final class DefinitionDetailStore: ObservableObject {
    @Published private(set) var detail: DefinitionDetail?
    @Published private(set) var access: SharedAccess?
    @Published private(set) var accessError: String?
    @Published private(set) var needsConsent = false
    @Published private(set) var isLoading = false
    @Published private(set) var loadFailed = false
    @Published private(set) var isSaving = false
    @Published private(set) var statusMessage: String?
    @Published private(set) var errorMessage: String?

    let workspaceID: UUID
    let objectID: String
    private var loadGeneration = 0
    private var pendingCertify: (token: String, commandID: UUID)?
    private var pendingUpdate: (baseToken: String, fields: DefinitionFields, commandID: UUID)?

    init(workspaceID: UUID, objectID: String) {
        self.workspaceID = workspaceID
        self.objectID = objectID
    }

    var canEdit: Bool {
        access?.canUpdate == true
    }

    var canCertify: Bool {
        canEdit && detail?.proposalPending == true
    }

    func load(api: DefinitionsAPI, preserveNotice: Bool = false) async {
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        loadFailed = false
        if !preserveNotice {
            statusMessage = nil
            errorMessage = nil
        }

        do {
            let status = try await api.access(workspaceID: workspaceID)
            guard !Task.isCancelled, generation == loadGeneration else { return }
            switch status {
            case .needsConfirmation(let reason):
                clearOnAccessLoss(message: DefinitionsRules.refusalMessage(reason), consent: true)
                isLoading = false
                return
            case .refused(let reason):
                clearOnAccessLoss(message: DefinitionsRules.refusalMessage(reason), consent: false)
                isLoading = false
                return
            case .granted(let granted):
                access = granted
                accessError = nil
                needsConsent = false
            }

            let loaded = try await api.readDefinition(workspaceID: workspaceID, objectID: objectID)
            guard !Task.isCancelled, generation == loadGeneration else { return }
            detail = loaded
            loadFailed = false
        } catch DefinitionsError.refused(let reason) {
            guard !Task.isCancelled, generation == loadGeneration else { return }
            if DefinitionsRules.isAccessLossReason(reason) {
                clearOnAccessLoss(
                    message: DefinitionsRules.refusalMessage(reason),
                    consent: reason == "content_consent_required"
                )
            } else {
                loadFailed = true
            }
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, generation == loadGeneration else { return }
            loadFailed = true
        }

        if generation == loadGeneration {
            isLoading = false
        }
    }

    func certify(api: DefinitionsAPI) async -> Bool {
        guard canCertify, !isSaving, let current = detail?.current else { return false }

        let commandID: UUID
        if let pending = pendingCertify, pending.token == current.revision.token {
            commandID = pending.commandID
        } else {
            commandID = UUID()
            pendingCertify = (current.revision.token, commandID)
        }

        isSaving = true
        statusMessage = nil
        errorMessage = nil
        defer { isSaving = false }

        let outcome = await api.certifyDefinition(
            workspaceID: workspaceID,
            objectID: objectID,
            revision: current.revision,
            requestID: commandID
        )
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
            pendingCertify = nil
            if reason == "definition_not_current" {
                errorMessage = message
                await load(api: api, preserveNotice: true)
            } else if DefinitionsRules.isAccessLossReason(reason) {
                clearOnAccessLoss(message: message, consent: reason == "content_consent_required")
            } else if reason == "content_read_only" {
                downgradeToReader()
                errorMessage = message
            } else {
                errorMessage = message
            }
            return false
        case .unconfirmed(let message):
            errorMessage = message
            return false
        }
    }

    func update(
        term rawTerm: String,
        meaning rawMeaning: String,
        source rawSource: String,
        api: DefinitionsAPI
    ) async -> Bool {
        guard canEdit, !isSaving, let current = detail?.current else { return false }
        let validated: DefinitionFields
        switch DefinitionsRules.validateFields(term: rawTerm, meaning: rawMeaning, source: rawSource) {
        case .success(let fields):
            validated = fields
        case .failure(let err):
            errorMessage = err.message
            return false
        }

        let commandID: UUID
        if let pending = pendingUpdate,
           pending.baseToken == current.revision.token,
           pending.fields == validated {
            commandID = pending.commandID
        } else {
            commandID = UUID()
            pendingUpdate = (current.revision.token, validated, commandID)
        }

        isSaving = true
        statusMessage = nil
        errorMessage = nil
        defer { isSaving = false }

        let outcome = await api.updateDefinition(
            workspaceID: workspaceID,
            objectID: objectID,
            base: current.revision,
            before: current.fields,
            after: validated,
            requestID: commandID
        )
        switch outcome {
        case .committed:
            pendingUpdate = nil
            statusMessage = "Saved."
            await load(api: api, preserveNotice: true)
            return true
        case .conflict(let message):
            pendingUpdate = nil
            errorMessage = message
            await load(api: api, preserveNotice: true)
            return false
        case .refused(let reason, let message):
            pendingUpdate = nil
            if DefinitionsRules.isAccessLossReason(reason) {
                clearOnAccessLoss(message: message, consent: reason == "content_consent_required")
            } else if reason == "content_read_only" {
                downgradeToReader()
                errorMessage = message
            } else {
                errorMessage = message
            }
            return false
        case .unconfirmed(let message):
            errorMessage = message
            return false
        }
    }

    private func clearOnAccessLoss(message: String, consent: Bool) {
        detail = nil
        access = nil
        accessError = message
        needsConsent = consent
        pendingCertify = nil
        pendingUpdate = nil
        loadFailed = false
    }

    private func downgradeToReader() {
        access = SharedAccess(role: .reader, operations: ["read"])
    }
}
