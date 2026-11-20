import Combine
import Foundation

enum TodoState: String, Codable, Hashable, CaseIterable, Sendable {
    case open
    case doing
    case done
    case dropped

    var label: String {
        switch self {
        case .open: "Open"
        case .doing: "Doing"
        case .done: "Done"
        case .dropped: "Dropped"
        }
    }

    var isOpen: Bool {
        self == .open || self == .doing
    }

    var listRank: Int {
        switch self {
        case .open, .doing: 0
        case .done: 1
        case .dropped: 2
        }
    }
}

enum TodoFilter: String, CaseIterable, Identifiable, Sendable {
    case open
    case all

    var id: String { rawValue }

    var label: String {
        switch self {
        case .open: "Open"
        case .all: "All"
        }
    }
}

struct TodoParty: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Hashable, Sendable {
        case user
        case agent
    }

    let kind: Kind
    let id: UUID
}

/// Decodes both `{ user_id, principal_id }` (todo detail actors) and `{ kind: "user"|"agent", id }` (server comment authors).
struct TodoActor: Codable, Hashable, Sendable {
    let user_id: UUID?
    let principal_id: UUID?

    init(user_id: UUID, principal_id: UUID? = nil) {
        self.user_id = user_id
        self.principal_id = principal_id
    }

    private enum CodingKeys: String, CodingKey {
        case user_id, principal_id, kind, id
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let uid = try container.decodeIfPresent(UUID.self, forKey: .user_id) {
            self.user_id = uid
            self.principal_id = try container.decodeIfPresent(UUID.self, forKey: .principal_id)
            return
        }
        if let kind = try container.decodeIfPresent(TodoParty.Kind.self, forKey: .kind),
           let id = try container.decodeIfPresent(UUID.self, forKey: .id) {
            switch kind {
            case .user:
                self.user_id = id
                self.principal_id = nil
            case .agent:
                self.user_id = nil
                self.principal_id = id
            }
            return
        }
        throw DecodingError.dataCorrupted(
            DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Invalid TodoActor shape")
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(user_id, forKey: .user_id)
        try container.encodeIfPresent(principal_id, forKey: .principal_id)
    }
}

struct TodoOfferSummary: Decodable, Hashable, Sendable {
    let offer_id: UUID
    let to: TodoParty
    let decider_user_id: UUID
    let start: String
}

enum TodoOfferAnswer: String, Sendable {
    case accept
    case decline
    case withdraw
}

struct TodoGateSummary: Decodable, Hashable, Sendable {
    let kind: String
    let clear: Bool
    let todo_id: UUID?
    let at: String?
}

struct TodoGateDetail: Decodable, Hashable, Sendable {
    let kind: String
    let note: String?
    let todo_id: UUID?
    let at: String?
}

struct TodoSummary: Decodable, Hashable, Identifiable, Sendable {
    let todo_id: UUID
    let version: Int
    let title: String
    let state: TodoState
    let due_on: String?
    let assignee: TodoParty?
    let offer: TodoOfferSummary?
    let gate: TodoGateSummary?
    let queue_position: Int?
    let comment_count: Int
    let state_at: String

    var id: UUID { todo_id }
}

struct TodoDetail: Decodable, Hashable, Identifiable, Sendable {
    let workspace_id: UUID
    let todo_id: UUID
    let version: Int
    let title: String
    let notes: String
    let state: TodoState
    let due_on: String?
    let created_by: TodoActor
    let created_at: String
    let assignee: TodoParty?
    let assigned_by: TodoActor?
    let assigned_at: String?
    let offer: TodoOfferSummary?
    let gate: TodoGateDetail?
    let gate_clear: Bool
    let queue_position: Int?
    let state_by: TodoActor
    let state_at: String
    let comment_count: Int

    var id: UUID { todo_id }

    var summary: TodoSummary {
        TodoSummary(
            todo_id: todo_id,
            version: version,
            title: title,
            state: state,
            due_on: due_on,
            assignee: assignee,
            offer: offer,
            gate: gate.map { TodoGateSummary(kind: $0.kind, clear: gate_clear, todo_id: $0.todo_id, at: $0.at) },
            queue_position: queue_position,
            comment_count: comment_count,
            state_at: state_at
        )
    }
}

struct TodoComment: Decodable, Hashable, Identifiable, Sendable {
    let comment_id: UUID
    let author: TodoActor
    let body: String
    let created_at: String

    var id: UUID { comment_id }
}

struct TodoListPage: Sendable {
    let todos: [TodoSummary]
    let nextOffset: Int?
}

struct TodoReadResponse: Sendable {
    let todo: TodoDetail
    let comments: [TodoComment]
    let nextCommentOffset: Int?
}

enum TodoWriteOutcome<Value: Sendable>: Sendable {
    case committed(Value)
    case conflict(current: TodoDetail?, message: String)
    case refused(reason: String, message: String)
    case unconfirmed(message: String)
}

struct TodoDirectoryEntry: Identifiable, Hashable, Sendable {
    let party: TodoParty
    let label: String

    var id: TodoParty { party }
}

struct TodoDirectory: Hashable, Sendable {
    let viewerUserID: UUID
    let people: [UUID: String]
    let agents: [UUID: String]

    static func empty(viewerUserID: UUID) -> TodoDirectory {
        TodoDirectory(viewerUserID: viewerUserID, people: [:], agents: [:])
    }

    var sortedPeople: [TodoDirectoryEntry] {
        people.keys
            .map { id in
                let party = TodoParty(kind: .user, id: id)
                return TodoDirectoryEntry(party: party, label: assigneeLabel(party))
            }
            .sorted { lhs, rhs in
                if (lhs.party.id == viewerUserID) != (rhs.party.id == viewerUserID) {
                    return lhs.party.id == viewerUserID
                }
                return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
            }
    }

    var sortedAgents: [TodoDirectoryEntry] {
        agents.keys
            .map { id in
                let party = TodoParty(kind: .agent, id: id)
                return TodoDirectoryEntry(party: party, label: assigneeLabel(party))
            }
            .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }

    func assigneeLabel(_ party: TodoParty?) -> String {
        guard let party else { return "Unassigned" }
        switch party.kind {
        case .user:
            let name = people[party.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if party.id == viewerUserID {
                if name.isEmpty || name.caseInsensitiveCompare("You") == .orderedSame {
                    return "You"
                }
                return "\(name) (you)"
            }
            return name.isEmpty ? "Member" : name
        case .agent:
            let name = agents[party.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return name.isEmpty ? "Agent" : name
        }
    }

    func assigneeSymbol(_ party: TodoParty?) -> String {
        guard let party else { return "person.crop.circle.badge.questionmark" }
        switch party.kind {
        case .user: return "person.crop.circle"
        case .agent: return "cpu"
        }
    }

    func actorLabel(_ actor: TodoActor) -> String {
        if let principalID = actor.principal_id {
            return assigneeLabel(TodoParty(kind: .agent, id: principalID))
        }
        if let userID = actor.user_id {
            return assigneeLabel(TodoParty(kind: .user, id: userID))
        }
        return "Member"
    }
}

enum TodoRules {
    static let maxTitleLength = 200
    static let maxNotesLength = 4_000
    static let maxCommentLength = 4_000
    static let maxMentions = 8

    static func cleanTitle(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: "\r\n", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func cleanBody(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
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

    static func unknownOutcomeAfterRefusalMessage(action: String, refusalMessage: String) -> String {
        "Your earlier \(action) outcome is still unknown and may already have saved; this retry was refused (\(refusalMessage)). Reload once access is restored to check."
    }

    static func refusalMessage(_ reason: String, fallback: String = "Couldn’t complete that action.") -> String {
        switch reason {
        case "unauthorized":
            return "Your session expired. Sign in again to access to-dos."
        case "forbidden", "workspace_access_refused", "connection_access_refused":
            return "You don’t have access to to-dos in this workspace."
        case "content_consent_required":
            return "Confirm workspace access before changing to-dos."
        case "content_read_only":
            return "You have read-only access in this workspace."
        case "todo_not_found", "target_not_found", "not_found", "workspace_not_found":
            return "This to-do is no longer available."
        case "title_invalid":
            return "Enter a title up to 200 characters."
        case "notes_invalid":
            return "Notes must be 4,000 characters or fewer."
        case "due_invalid":
            return "Enter a valid due date."
        case "comment_invalid":
            return "Enter a comment up to 4,000 characters."
        case "mentions_invalid":
            return "One or more tagged people or agents are no longer available."
        case "assignee_not_member", "assignee_removed":
            return "That person or agent is no longer in this workspace."
        case "invalid_transition":
            return "This to-do can’t move to that state right now."
        case "not_assignee", "not_permitted", "owner_only", "not_decider":
            return "You don’t have permission to make that change."
        case "offer_not_pending":
            return "That work request is no longer pending."
        case "queue_full":
            return "That agent’s work queue is full."
        case "todo_limit_reached":
            return "This workspace reached its open to-do limit."
        case "todo_write_rate_limited":
            return "Too many changes at once. Wait a moment and try again."
        default:
            return fallback
        }
    }
}

enum TodoCalendarDate {
    static func formatLocal(_ date: Date, calendar: Calendar = .current) -> String {
        let comps = calendar.dateComponents([.year, .month, .day], from: date)
        let year = comps.year ?? 2026
        let month = comps.month ?? 1
        let day = comps.day ?? 1
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    static func parseLocal(_ value: String?, calendar: Calendar = .current) -> Date? {
        guard let value else { return nil }
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              (1...12).contains(month), (1...31).contains(day) else { return nil }
        var components = DateComponents()
        components.calendar = calendar
        components.timeZone = calendar.timeZone
        components.year = year
        components.month = month
        components.day = day
        guard let date = calendar.date(from: components) else { return nil }
        let verified = calendar.dateComponents([.year, .month, .day], from: date)
        guard verified.year == year, verified.month == month, verified.day == day else { return nil }
        return date
    }

    static func formatDate(_ value: String?, now: Date = Date(), calendar: Calendar = .current) -> String? {
        guard let date = parseLocal(value, calendar: calendar) else { return nil }
        let startToday = calendar.startOfDay(for: now)
        let startDue = calendar.startOfDay(for: date)
        let offset = calendar.dateComponents([.day], from: startToday, to: startDue).day
        if offset == 0 { return "Today" }
        if offset == 1 { return "Tomorrow" }
        if offset == -1 { return "Yesterday" }

        let currentYear = calendar.component(.year, from: now)
        let dueYear = calendar.component(.year, from: date)
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = currentYear == dueYear ? "EEE, MMM d" : "EEE, MMM d, yyyy"
        return formatter.string(from: date)
    }

    static func formatDue(_ value: String?, now: Date = Date(), calendar: Calendar = .current) -> String? {
        guard let formatted = formatDate(value, now: now, calendar: calendar) else { return nil }
        switch formatted {
        case "Today", "Tomorrow", "Yesterday":
            return "Due " + formatted.lowercased()
        default:
            return "Due " + formatted
        }
    }

    static func formatTimestamp(_ iso: String) -> String? {
        let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(iso))
            ?? (try? Date.ISO8601FormatStyle().parse(iso))
        guard let date else { return nil }
        return date.formatted(.dateTime.month().day().hour().minute())
    }
}

/// Frozen snapshot captured when the user opens Edit to-do; submits strictly against `baseVersion`.
struct TodoEditSession: Identifiable, Equatable, Sendable {
    let id = UUID()
    let todoID: UUID
    let baseVersion: Int
    let initialTitle: String
    let initialNotes: String
    let initialDueOn: String?
}

enum TodoLoadFailure: Equatable, Sendable {
    case failed
    case refused(String)
    case notFound

    func message(subject: String) -> String {
        switch self {
        case .notFound:
            return "This to-do is no longer available."
        case .refused(let reason):
            switch reason {
            case "unauthorized":
                return "Your session expired. Sign in again to access to-dos."
            case "forbidden", "workspace_access_refused", "content_consent_required", "connection_access_refused":
                return "You don’t have access to to-dos in this workspace."
            case "todo_not_found", "not_found", "workspace_not_found":
                return "This to-do is no longer available."
            default:
                return "Couldn’t load \(subject)."
            }
        case .failed:
            return "Couldn’t load \(subject)."
        }
    }
}

@MainActor
final class TodoListViewModel: ObservableObject {
    @Published var filter: TodoFilter = .open
    @Published private(set) var todos: [TodoSummary]?
    @Published private(set) var directory: TodoDirectory
    @Published private(set) var isLoading = false
    @Published private(set) var failure: TodoLoadFailure?
    @Published private(set) var isCreating = false
    @Published private(set) var createError: String?
    @Published private(set) var isReadOnly = false
    @Published var showingCreateSheet = false

    struct PendingCreate: Equatable, Sendable {
        let sessionID: ObjectIdentifier
        let title: String
        let notes: String
        let dueOn: String?
        let assignee: TodoParty?
        let commandID: UUID
        var outcomeUnknown: Bool
    }
    private(set) var pendingCreate: PendingCreate?
    private var loadGeneration = 0
    private var accessGeneration = 0
    private var isRetired = false
    private var activeSessionID: ObjectIdentifier?

    init(viewerUserID: UUID) {
        self.directory = .empty(viewerUserID: viewerUserID)
    }

    var orderedTodos: [TodoSummary] {
        guard let todos else { return [] }
        let filtered = filter == .open ? todos.filter { $0.state.isOpen } : todos
        return filtered.enumerated()
            .sorted { lhs, rhs in
                if lhs.element.state.listRank != rhs.element.state.listRank {
                    return lhs.element.state.listRank < rhs.element.state.listRank
                }
                return lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    func retire() {
        isRetired = true
        loadGeneration += 1
        accessGeneration += 1
        isLoading = false
        showingCreateSheet = false
    }

    func openCreateSheet() {
        guard !isReadOnly else { return }
        if pendingCreate?.outcomeUnknown != true {
            createError = nil
        }
        showingCreateSheet = true
    }

    private func bindSession(_ session: HumanSession) -> Bool {
        let sid = ObjectIdentifier(session)
        if let prev = activeSessionID, prev != sid {
            clearOnAccessLoss(reason: "unauthorized", clearPending: true)
        }
        activeSessionID = sid
        guard session.isActive else {
            clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            return false
        }
        return true
    }

    func load(api: TodoAPI, workspaceID: UUID) async {
        isRetired = false
        guard bindSession(api.session) else { return }
        loadGeneration += 1
        let generation = loadGeneration
        let capturedAccessGen = accessGeneration
        let capturedSession = api.session
        isLoading = true
        failure = nil
        let requestedScope = filter
        do {
            async let pageTask = api.listTodos(workspace: workspaceID, scope: requestedScope)
            async let directoryTask = api.directory(workspace: workspaceID)
            let page = try await pageTask
            let resolvedDirectory = (try? await directoryTask) ?? directory
            try Task.checkCancellation()
            guard !isRetired,
                  capturedSession.isActive,
                  filter == requestedScope,
                  generation == loadGeneration,
                  capturedAccessGen == accessGeneration else { return }
            todos = page.todos
            directory = resolvedDirectory
            isLoading = false
            // Reconcile any unknown pending create once an authorized read settles
            if let pending = pendingCreate, pending.sessionID == ObjectIdentifier(capturedSession), pending.outcomeUnknown {
                pendingCreate = nil
                createError = nil
            }
        } catch TodoAPIError.refused(let reason) {
            if !Task.isCancelled && !isRetired && filter == requestedScope && generation == loadGeneration && capturedAccessGen == accessGeneration {
                if TodoRules.isAccessLossReason(reason) {
                    clearOnAccessLoss(reason: reason, clearPending: reason == "unauthorized")
                } else {
                    failure = .refused(reason)
                    isLoading = false
                }
            }
        } catch {
            if !Task.isCancelled && !isRetired && filter == requestedScope && generation == loadGeneration && capturedAccessGen == accessGeneration {
                if !capturedSession.isActive {
                    clearOnAccessLoss(reason: "unauthorized", clearPending: true)
                } else {
                    failure = .failed
                    isLoading = false
                }
            }
        }
    }

    func createTodo(
        title rawTitle: String,
        notes rawNotes: String,
        dueOn: String?,
        assignee: TodoParty?,
        api: TodoAPI,
        workspaceID: UUID
    ) async -> TodoDetail? {
        guard bindSession(api.session) else { return nil }
        guard !isCreating, !isReadOnly else { return nil }
        let title = TodoRules.cleanTitle(rawTitle)
        let notes = TodoRules.cleanBody(rawNotes)
        guard !title.isEmpty, title.count <= TodoRules.maxTitleLength else {
            createError = TodoRules.refusalMessage("title_invalid")
            return nil
        }
        guard notes.count <= TodoRules.maxNotesLength else {
            createError = TodoRules.refusalMessage("notes_invalid")
            return nil
        }
        if let dueOn, TodoCalendarDate.parseLocal(dueOn) == nil {
            createError = TodoRules.refusalMessage("due_invalid")
            return nil
        }

        let capturedSession = api.session
        let sessionID = ObjectIdentifier(capturedSession)
        let capturedAccessGen = accessGeneration

        let record: PendingCreate
        if let existing = pendingCreate, existing.sessionID == sessionID {
            if existing.title == title && existing.notes == notes && existing.dueOn == dueOn && existing.assignee == assignee {
                record = existing
            } else if existing.outcomeUnknown {
                createError = "An earlier add for “\(existing.title)” has an unknown outcome. Retry it unchanged or reload to check before adding a different to-do."
                return nil
            } else {
                record = PendingCreate(sessionID: sessionID, title: title, notes: notes, dueOn: dueOn, assignee: assignee, commandID: UUID(), outcomeUnknown: false)
                pendingCreate = record
            }
        } else {
            record = PendingCreate(sessionID: sessionID, title: title, notes: notes, dueOn: dueOn, assignee: assignee, commandID: UUID(), outcomeUnknown: false)
            pendingCreate = record
        }

        let wasAlreadyUnknown = record.outcomeUnknown
        isCreating = true
        createError = nil
        defer { isCreating = false }

        let outcome = await api.createTodo(
            workspace: workspaceID,
            title: record.title,
            notes: record.notes.isEmpty ? nil : record.notes,
            dueOn: record.dueOn,
            assignee: record.assignee,
            requestID: record.commandID
        )
        guard !Task.isCancelled, !isRetired, capturedSession.isActive, capturedAccessGen == accessGeneration else {
            if !capturedSession.isActive {
                clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            }
            return nil
        }

        switch outcome {
        case .committed(let created):
            pendingCreate = nil
            showingCreateSheet = false
            await load(api: api, workspaceID: workspaceID)
            return created
        case .conflict(_, let message):
            if !wasAlreadyUnknown { pendingCreate = nil }
            createError = wasAlreadyUnknown
                ? TodoRules.unknownOutcomeAfterRefusalMessage(action: "add", refusalMessage: message)
                : message
            await load(api: api, workspaceID: workspaceID)
            return nil
        case .refused(let reason, let message):
            let display = wasAlreadyUnknown
                ? TodoRules.unknownOutcomeAfterRefusalMessage(action: "add", refusalMessage: message)
                : message
            if !wasAlreadyUnknown { pendingCreate = nil }
            if TodoRules.isAccessLossReason(reason) {
                clearOnAccessLoss(reason: reason, clearPending: reason == "unauthorized")
            } else if reason == "content_read_only" {
                accessGeneration += 1
                isReadOnly = true
                showingCreateSheet = false
            }
            createError = display
            return nil
        case .unconfirmed(let message):
            var unknown = record
            unknown.outcomeUnknown = true
            pendingCreate = unknown
            createError = message
            return nil
        }
    }

    private func clearOnAccessLoss(reason: String, clearPending: Bool) {
        loadGeneration += 1
        accessGeneration += 1
        isLoading = false
        todos = nil
        showingCreateSheet = false
        failure = .refused(reason)
        if clearPending {
            pendingCreate = nil
        }
    }
}

@MainActor
final class TodoDetailViewModel: ObservableObject {
    @Published private(set) var detail: TodoDetail?
    @Published private(set) var comments: [TodoComment] = []
    @Published private(set) var nextCommentOffset: Int?
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMoreComments = false
    @Published private(set) var failure: TodoLoadFailure?
    @Published private(set) var isMutating = false
    @Published private(set) var isPostingComment = false
    @Published private(set) var isReadOnly = false
    @Published private(set) var statusMessage: String?
    @Published private(set) var actionError: String?
    @Published var activeEditSession: TodoEditSession?
    @Published var showingAssignSheet = false

    private var loadGeneration = 0
    private var accessGeneration = 0
    private var isRetired = false
    private var activeSessionID: ObjectIdentifier?

    private var pendingState: (sessionID: ObjectIdentifier, version: Int, state: TodoState, commandID: UUID, outcomeUnknown: Bool)?
    private var pendingAssign: (sessionID: ObjectIdentifier, version: Int, to: TodoParty?, commandID: UUID, outcomeUnknown: Bool)?
    private var pendingOffer: (sessionID: ObjectIdentifier, offerID: UUID, answer: TodoOfferAnswer, commandID: UUID, outcomeUnknown: Bool)?
    private var pendingUpdate: (sessionID: ObjectIdentifier, version: Int, title: String, notes: String, dueOn: String?, commandID: UUID, outcomeUnknown: Bool)?
    private var pendingComment: (sessionID: ObjectIdentifier, body: String, mentions: [TodoParty], commandID: UUID, outcomeUnknown: Bool)?

    func retire() {
        isRetired = true
        loadGeneration += 1
        accessGeneration += 1
        isLoading = false
        activeEditSession = nil
        showingAssignSheet = false
    }

    @discardableResult
    func beginEdit() -> TodoEditSession? {
        guard !isReadOnly, let current = detail else { return nil }
        let session = TodoEditSession(
            todoID: current.todo_id,
            baseVersion: current.version,
            initialTitle: current.title,
            initialNotes: current.notes,
            initialDueOn: current.due_on
        )
        activeEditSession = session
        if pendingUpdate?.outcomeUnknown != true {
            actionError = nil
        }
        return session
    }

    private func bindSession(_ session: HumanSession) -> Bool {
        let sid = ObjectIdentifier(session)
        if let prev = activeSessionID, prev != sid {
            clearOnAccessLoss(reason: "unauthorized", clearPending: true)
        }
        activeSessionID = sid
        guard session.isActive else {
            clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            return false
        }
        return true
    }

    func load(api: TodoAPI, workspaceID: UUID, todoID: UUID, preserveNotice: Bool = false) async {
        isRetired = false
        guard bindSession(api.session) else { return }
        loadGeneration += 1
        let generation = loadGeneration
        let capturedAccessGen = accessGeneration
        let capturedSession = api.session
        isLoading = true
        failure = nil
        if !preserveNotice {
            statusMessage = nil
            actionError = nil
        }
        do {
            let response = try await api.readTodo(workspace: workspaceID, todoID: todoID)
            try Task.checkCancellation()
            guard !isRetired, capturedSession.isActive, generation == loadGeneration, capturedAccessGen == accessGeneration else { return }
            detail = response.todo
            comments = response.comments
            nextCommentOffset = response.nextCommentOffset
            isLoading = false
            if let open = activeEditSession, open.baseVersion != response.todo.version {
                activeEditSession = nil
            }
            // Authorized read reconciles any previously unknown outcomes
            pendingState = nil
            pendingAssign = nil
            pendingOffer = nil
            pendingUpdate = nil
            pendingComment = nil
        } catch TodoAPIError.refused(let reason) {
            if !Task.isCancelled && !isRetired && generation == loadGeneration && capturedAccessGen == accessGeneration {
                if TodoRules.isAccessLossReason(reason) || reason == "todo_not_found" {
                    clearOnAccessLoss(reason: reason, clearPending: reason == "unauthorized")
                } else {
                    failure = .refused(reason)
                    isLoading = false
                }
            }
        } catch {
            if !Task.isCancelled && !isRetired && generation == loadGeneration && capturedAccessGen == accessGeneration {
                if !capturedSession.isActive {
                    clearOnAccessLoss(reason: "unauthorized", clearPending: true)
                } else {
                    failure = .failed
                    isLoading = false
                }
            }
        }
    }

    func loadMoreComments(api: TodoAPI, workspaceID: UUID) async {
        guard bindSession(api.session) else { return }
        guard !isLoadingMoreComments,
              let current = detail,
              let offset = nextCommentOffset else { return }
        let capturedAccessGen = accessGeneration
        isLoadingMoreComments = true
        defer { isLoadingMoreComments = false }
        do {
            let response = try await api.readTodo(workspace: workspaceID, todoID: current.todo_id, commentOffset: offset)
            try Task.checkCancellation()
            guard !isRetired, api.session.isActive, capturedAccessGen == accessGeneration else { return }
            let existingIDs = Set(comments.map(\.comment_id))
            let newItems = response.comments.filter { !existingIDs.contains($0.comment_id) }
            comments.append(contentsOf: newItems)
            if let next = response.nextCommentOffset, next > offset {
                nextCommentOffset = next
            } else {
                nextCommentOffset = nil
            }
        } catch TodoAPIError.refused(let reason) {
            if TodoRules.isAccessLossReason(reason) || reason == "todo_not_found" {
                clearOnAccessLoss(reason: reason, clearPending: reason == "unauthorized")
            } else {
                actionError = TodoRules.refusalMessage(reason, fallback: "Couldn’t load earlier comments.")
            }
        } catch {
            actionError = "Couldn’t load earlier comments."
        }
    }

    func setState(_ target: TodoState, api: TodoAPI, workspaceID: UUID) async -> Bool {
        guard bindSession(api.session) else { return false }
        guard !isMutating, !isReadOnly, let current = detail else { return false }
        let sid = ObjectIdentifier(api.session)
        let capturedAccessGen = accessGeneration
        let commandID: UUID
        let wasAlreadyUnknown: Bool
        if let existing = pendingState, existing.sessionID == sid {
            if existing.version == current.version && existing.state == target {
                commandID = existing.commandID
                wasAlreadyUnknown = existing.outcomeUnknown
            } else if existing.outcomeUnknown {
                actionError = "An earlier state change has an unknown outcome. Reload to check before making another change."
                return false
            } else {
                commandID = UUID()
                wasAlreadyUnknown = false
                pendingState = (sid, current.version, target, commandID, false)
            }
        } else {
            commandID = UUID()
            wasAlreadyUnknown = false
            pendingState = (sid, current.version, target, commandID, false)
        }

        isMutating = true
        statusMessage = nil
        actionError = nil
        defer { isMutating = false }

        let outcome = await api.setTodoState(
            workspace: workspaceID,
            todoID: current.todo_id,
            baseVersion: current.version,
            state: target,
            requestID: commandID
        )
        guard !Task.isCancelled, !isRetired, api.session.isActive, capturedAccessGen == accessGeneration else { return false }
        return handleTodoWrite(
            outcome,
            actionName: "state change",
            wasAlreadyUnknown: wasAlreadyUnknown,
            markUnknown: { self.pendingState?.outcomeUnknown = true },
            clearPending: { self.pendingState = nil },
            successMessage: stateMessage(for: target)
        )
    }

    func assign(to party: TodoParty?, api: TodoAPI, workspaceID: UUID) async -> Bool {
        guard bindSession(api.session) else { return false }
        guard !isMutating, !isReadOnly, let current = detail else { return false }
        let sid = ObjectIdentifier(api.session)
        let capturedAccessGen = accessGeneration
        let commandID: UUID
        let wasAlreadyUnknown: Bool
        if let existing = pendingAssign, existing.sessionID == sid {
            if existing.version == current.version && existing.to == party {
                commandID = existing.commandID
                wasAlreadyUnknown = existing.outcomeUnknown
            } else if existing.outcomeUnknown {
                actionError = "An earlier assignment change has an unknown outcome. Reload to check before changing it again."
                return false
            } else {
                commandID = UUID()
                wasAlreadyUnknown = false
                pendingAssign = (sid, current.version, party, commandID, false)
            }
        } else {
            commandID = UUID()
            wasAlreadyUnknown = false
            pendingAssign = (sid, current.version, party, commandID, false)
        }

        isMutating = true
        statusMessage = nil
        actionError = nil
        defer { isMutating = false }

        let outcome = await api.assignTodo(
            workspace: workspaceID,
            todoID: current.todo_id,
            baseVersion: current.version,
            to: party,
            requestID: commandID
        )
        guard !Task.isCancelled, !isRetired, api.session.isActive, capturedAccessGen == accessGeneration else { return false }
        let ok = handleTodoWrite(
            outcome,
            actionName: "assignment",
            wasAlreadyUnknown: wasAlreadyUnknown,
            markUnknown: { self.pendingAssign?.outcomeUnknown = true },
            clearPending: { self.pendingAssign = nil },
            successMessage: party == nil ? "Unassigned." : "Assignment updated."
        )
        if ok { showingAssignSheet = false }
        return ok
    }

    func answerOffer(_ answer: TodoOfferAnswer, api: TodoAPI, workspaceID: UUID) async -> Bool {
        guard bindSession(api.session) else { return false }
        guard !isMutating, !isReadOnly, let current = detail, let offer = current.offer else { return false }
        let sid = ObjectIdentifier(api.session)
        let capturedAccessGen = accessGeneration
        let commandID: UUID
        let wasAlreadyUnknown: Bool
        if let existing = pendingOffer, existing.sessionID == sid {
            if existing.offerID == offer.offer_id && existing.answer == answer {
                commandID = existing.commandID
                wasAlreadyUnknown = existing.outcomeUnknown
            } else if existing.outcomeUnknown {
                actionError = "An earlier response to this request has an unknown outcome. Reload to check first."
                return false
            } else {
                commandID = UUID()
                wasAlreadyUnknown = false
                pendingOffer = (sid, offer.offer_id, answer, commandID, false)
            }
        } else {
            commandID = UUID()
            wasAlreadyUnknown = false
            pendingOffer = (sid, offer.offer_id, answer, commandID, false)
        }

        isMutating = true
        statusMessage = nil
        actionError = nil
        defer { isMutating = false }

        let outcome = await api.answerOffer(
            workspace: workspaceID,
            todoID: current.todo_id,
            offerID: offer.offer_id,
            answer: answer,
            requestID: commandID
        )
        guard !Task.isCancelled, !isRetired, api.session.isActive, capturedAccessGen == accessGeneration else { return false }
        let msg: String
        switch answer {
        case .accept: msg = "Request accepted."
        case .decline: msg = "Request declined."
        case .withdraw: msg = "Request withdrawn."
        }
        return handleTodoWrite(
            outcome,
            actionName: "request response",
            wasAlreadyUnknown: wasAlreadyUnknown,
            markUnknown: { self.pendingOffer?.outcomeUnknown = true },
            clearPending: { self.pendingOffer = nil },
            successMessage: msg
        )
    }

    func updateDetails(
        session editSession: TodoEditSession,
        title rawTitle: String,
        notes rawNotes: String,
        dueOn: String?,
        api: TodoAPI,
        workspaceID: UUID
    ) async -> Bool {
        guard bindSession(api.session) else { return false }
        guard !isMutating, !isReadOnly else { return false }
        guard activeEditSession?.id == editSession.id,
              detail?.todo_id == editSession.todoID,
              detail?.version == editSession.baseVersion else {
            activeEditSession = nil
            actionError = "Someone else updated this to-do. Review the latest version, then tap Edit again."
            return false
        }

        let title = TodoRules.cleanTitle(rawTitle)
        let notes = TodoRules.cleanBody(rawNotes)
        guard !title.isEmpty, title.count <= TodoRules.maxTitleLength else {
            actionError = TodoRules.refusalMessage("title_invalid")
            return false
        }
        guard notes.count <= TodoRules.maxNotesLength else {
            actionError = TodoRules.refusalMessage("notes_invalid")
            return false
        }
        if let dueOn, TodoCalendarDate.parseLocal(dueOn) == nil {
            actionError = TodoRules.refusalMessage("due_invalid")
            return false
        }

        let sid = ObjectIdentifier(api.session)
        let capturedAccessGen = accessGeneration
        let commandID: UUID
        let wasAlreadyUnknown: Bool
        if let existing = pendingUpdate, existing.sessionID == sid {
            if existing.version == editSession.baseVersion
                && existing.title == title
                && existing.notes == notes
                && existing.dueOn == dueOn {
                commandID = existing.commandID
                wasAlreadyUnknown = existing.outcomeUnknown
            } else if existing.outcomeUnknown {
                actionError = "An earlier edit has an unknown outcome. Retry it unchanged or reload to check before saving different changes."
                return false
            } else {
                commandID = UUID()
                wasAlreadyUnknown = false
                pendingUpdate = (sid, editSession.baseVersion, title, notes, dueOn, commandID, false)
            }
        } else {
            commandID = UUID()
            wasAlreadyUnknown = false
            pendingUpdate = (sid, editSession.baseVersion, title, notes, dueOn, commandID, false)
        }

        isMutating = true
        statusMessage = nil
        actionError = nil
        defer { isMutating = false }

        let outcome = await api.updateTodo(
            workspace: workspaceID,
            todoID: editSession.todoID,
            baseVersion: editSession.baseVersion,
            title: title,
            notes: notes,
            dueOn: dueOn,
            requestID: commandID
        )
        guard !Task.isCancelled, !isRetired, api.session.isActive, capturedAccessGen == accessGeneration else { return false }
        let ok = handleTodoWrite(
            outcome,
            actionName: "edit",
            wasAlreadyUnknown: wasAlreadyUnknown,
            markUnknown: { self.pendingUpdate?.outcomeUnknown = true },
            clearPending: { self.pendingUpdate = nil },
            successMessage: "Saved."
        )
        if ok { activeEditSession = nil }
        return ok
    }

    func postComment(
        body rawBody: String,
        mentions: [TodoParty] = [],
        api: TodoAPI,
        workspaceID: UUID
    ) async -> Bool {
        guard bindSession(api.session) else { return false }
        guard !isPostingComment, !isReadOnly, let current = detail else { return false }
        let body = TodoRules.cleanBody(rawBody)
        guard !body.isEmpty, body.count <= TodoRules.maxCommentLength else {
            actionError = TodoRules.refusalMessage("comment_invalid")
            return false
        }
        let cappedMentions = Array(mentions.prefix(TodoRules.maxMentions))
        let sid = ObjectIdentifier(api.session)
        let capturedAccessGen = accessGeneration
        let commandID: UUID
        let wasAlreadyUnknown: Bool
        if let existing = pendingComment, existing.sessionID == sid {
            if existing.body == body && existing.mentions == cappedMentions {
                commandID = existing.commandID
                wasAlreadyUnknown = existing.outcomeUnknown
            } else if existing.outcomeUnknown {
                actionError = "An earlier comment has an unknown outcome. Retry it unchanged or reload to check first."
                return false
            } else {
                commandID = UUID()
                wasAlreadyUnknown = false
                pendingComment = (sid, body, cappedMentions, commandID, false)
            }
        } else {
            commandID = UUID()
            wasAlreadyUnknown = false
            pendingComment = (sid, body, cappedMentions, commandID, false)
        }

        isPostingComment = true
        statusMessage = nil
        actionError = nil
        defer { isPostingComment = false }

        let outcome = await api.postComment(
            workspace: workspaceID,
            todoID: current.todo_id,
            body: body,
            mentions: cappedMentions,
            requestID: commandID
        )
        guard !Task.isCancelled, !isRetired, api.session.isActive, capturedAccessGen == accessGeneration else { return false }
        switch outcome {
        case .committed(let comment):
            pendingComment = nil
            if !comments.contains(where: { $0.comment_id == comment.comment_id }) {
                comments.append(comment)
            }
            statusMessage = "Comment posted."
            return true
        case .conflict(let latest, let message):
            if !wasAlreadyUnknown { pendingComment = nil }
            if let latest { detail = latest }
            actionError = wasAlreadyUnknown
                ? TodoRules.unknownOutcomeAfterRefusalMessage(action: "comment", refusalMessage: message)
                : message
            return false
        case .refused(let reason, let message):
            let display = wasAlreadyUnknown
                ? TodoRules.unknownOutcomeAfterRefusalMessage(action: "comment", refusalMessage: message)
                : message
            if !wasAlreadyUnknown { pendingComment = nil }
            applyRefusal(reason: reason, message: display)
            return false
        case .unconfirmed(let message):
            pendingComment?.outcomeUnknown = true
            actionError = message
            return false
        }
    }

    private func stateMessage(for state: TodoState) -> String {
        switch state {
        case .done: "Marked done."
        case .doing: "Moved to Doing."
        case .open: "Reopened."
        case .dropped: "Dropped."
        }
    }

    private func handleTodoWrite(
        _ outcome: TodoWriteOutcome<TodoDetail>,
        actionName: String,
        wasAlreadyUnknown: Bool,
        markUnknown: () -> Void,
        clearPending: () -> Void,
        successMessage: String
    ) -> Bool {
        switch outcome {
        case .committed(let updated):
            clearPending()
            detail = updated
            statusMessage = successMessage
            return true
        case .conflict(let latest, let message):
            activeEditSession = nil
            showingAssignSheet = false
            if !wasAlreadyUnknown { clearPending() }
            if let latest { detail = latest }
            actionError = wasAlreadyUnknown
                ? TodoRules.unknownOutcomeAfterRefusalMessage(action: actionName, refusalMessage: message)
                : message
            return false
        case .refused(let reason, let message):
            let display = wasAlreadyUnknown
                ? TodoRules.unknownOutcomeAfterRefusalMessage(action: actionName, refusalMessage: message)
                : message
            if !wasAlreadyUnknown { clearPending() }
            applyRefusal(reason: reason, message: display)
            return false
        case .unconfirmed(let message):
            markUnknown()
            actionError = message
            return false
        }
    }

    private func applyRefusal(reason: String, message: String) {
        if TodoRules.isAccessLossReason(reason) || reason == "todo_not_found" {
            clearOnAccessLoss(reason: reason, clearPending: reason == "unauthorized")
        } else if reason == "content_read_only" {
            accessGeneration += 1
            isReadOnly = true
            activeEditSession = nil
            showingAssignSheet = false
        }
        actionError = message
    }

    private func clearOnAccessLoss(reason: String, clearPending: Bool) {
        loadGeneration += 1
        accessGeneration += 1
        isLoading = false
        detail = nil
        comments = []
        nextCommentOffset = nil
        activeEditSession = nil
        showingAssignSheet = false
        failure = reason == "todo_not_found" ? .notFound : .refused(reason)
        if clearPending {
            pendingState = nil
            pendingAssign = nil
            pendingOffer = nil
            pendingUpdate = nil
            pendingComment = nil
        }
    }
}
