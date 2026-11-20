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

struct TodoAccess: Equatable, Sendable {
    let canRead: Bool
    let canCreate: Bool
    let canUpdate: Bool
    let isWorkspaceAdmin: Bool
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
    let by: TodoActor?
    let at: String?
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
}

/// Stored to-do shape returned in production write receipts (`committed.value`) and conflict (`current`).
/// `gate_clear` and `queue_position` are derived on read only and are optional here.
struct TodoWriteRecord: Decodable, Hashable, Identifiable, Sendable {
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
    let gate_clear: Bool?
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
            gate: gate.map { TodoGateSummary(kind: $0.kind, clear: gate_clear ?? true, todo_id: $0.todo_id, at: $0.at) },
            queue_position: queue_position,
            comment_count: comment_count,
            state_at: state_at
        )
    }

    func toDetail(preserving previous: TodoDetail?) -> TodoDetail {
        TodoDetail(
            workspace_id: workspace_id,
            todo_id: todo_id,
            version: version,
            title: title,
            notes: notes,
            state: state,
            due_on: due_on,
            created_by: created_by,
            created_at: created_at,
            assignee: assignee,
            assigned_by: assigned_by,
            assigned_at: assigned_at,
            offer: offer,
            gate: gate,
            gate_clear: gate_clear ?? (previous?.gate == gate ? (previous?.gate_clear ?? true) : true),
            queue_position: queue_position ?? (previous?.assignee == assignee && previous?.state == state ? previous?.queue_position : nil),
            state_by: state_by,
            state_at: state_at,
            comment_count: comment_count
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
    case committed(Value, replayed: Bool)
    case conflict(current: TodoWriteRecord?, message: String)
    case refused(reason: String, message: String)
    case unconfirmed(message: String)
    case cancelled
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

    /// Canonical, deterministic mention list so unordered Set selections always match across unchanged retries.
    static func canonicalMentions<S: Sequence>(_ mentions: S) -> [TodoParty] where S.Element == TodoParty {
        var seen = Set<TodoParty>()
        var unique: [TodoParty] = []
        for party in mentions where seen.insert(party).inserted {
            unique.append(party)
        }
        unique.sort { lhs, rhs in
            if lhs.kind.rawValue != rhs.kind.rawValue {
                return lhs.kind.rawValue < rhs.kind.rawValue
            }
            return lhs.id.uuidString.lowercased() < rhs.id.uuidString.lowercased()
        }
        return Array(unique.prefix(maxMentions))
    }

    static func commentDraftMatchesConfirmed(
        draftText: String,
        draftMentions: Set<TodoParty>,
        confirmedBody: String,
        confirmedMentions: [TodoParty]
    ) -> Bool {
        cleanBody(draftText) == cleanBody(confirmedBody)
            && canonicalMentions(draftMentions) == canonicalMentions(confirmedMentions)
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
        "Your earlier \(action) outcome is still unknown and may already have saved; this retry was refused (\(refusalMessage)). Retry unchanged once access is restored to check."
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

/// Presentation identity captured when New to-do opens.
struct TodoCreateSession: Identifiable, Equatable, Sendable {
    let id = UUID()
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

enum TodoFieldKey: String, Hashable, CaseIterable, Sendable {
    case title
    case notes
    case dueOn

    var label: String {
        switch self {
        case .title: "Title"
        case .notes: "Notes"
        case .dueOn: "Due date"
        }
    }
}

struct TodoConflictMergeResult: Equatable, Sendable {
    let title: String
    let notes: String
    let dueOn: String?
    let appliedFields: Set<TodoFieldKey>
    let conflictingFields: Set<TodoFieldKey>
}

/// Exact field values captured when the author opened Edit, retained across lost-response retries
/// so conflict recovery never mistakes a refetched teammate update for the original base.
struct TodoEditBase: Equatable, Sendable {
    let title: String
    let notes: String
    let dueOn: String?
}

/// Preserves both the version the author opened (`base`) and their unsent edits (`edited*`)
/// so conflict recovery restores ONLY fields the author changed and carries forward any
/// teammate updates to other fields (e.g. a teammate's newer title or due date).
/// If `base` is unavailable (`nil`), `merge(...)` never auto-applies fields and keeps recovery manual.
struct TodoConflictDraft: Equatable, Sendable {
    let base: TodoEditBase?
    let editedTitle: String
    let editedNotes: String
    let editedDueOn: String?

    init(
        base: TodoEditBase?,
        editedTitle: String,
        editedNotes: String,
        editedDueOn: String?
    ) {
        self.base = base
        self.editedTitle = editedTitle
        self.editedNotes = editedNotes
        self.editedDueOn = editedDueOn
    }

    init(
        baseTitle: String,
        baseNotes: String,
        baseDueOn: String?,
        editedTitle: String,
        editedNotes: String,
        editedDueOn: String?
    ) {
        self.base = TodoEditBase(title: baseTitle, notes: baseNotes, dueOn: baseDueOn)
        self.editedTitle = editedTitle
        self.editedNotes = editedNotes
        self.editedDueOn = editedDueOn
    }

    var editedKeys: Set<TodoFieldKey> {
        guard let base else {
            var keys: Set<TodoFieldKey> = [.title]
            if !editedNotes.isEmpty { keys.insert(.notes) }
            if editedDueOn != nil { keys.insert(.dueOn) }
            return keys
        }
        var keys: Set<TodoFieldKey> = []
        if editedTitle != base.title { keys.insert(.title) }
        if editedNotes != base.notes { keys.insert(.notes) }
        if editedDueOn != base.dueOn { keys.insert(.dueOn) }
        return keys
    }

    func merge(onto latestTitle: String, latestNotes: String, latestDueOn: String?) -> TodoConflictMergeResult {
        guard let base else {
            var conflicts: Set<TodoFieldKey> = []
            if editedTitle != latestTitle { conflicts.insert(.title) }
            if editedNotes != latestNotes { conflicts.insert(.notes) }
            if editedDueOn != latestDueOn { conflicts.insert(.dueOn) }
            return TodoConflictMergeResult(
                title: latestTitle,
                notes: latestNotes,
                dueOn: latestDueOn,
                appliedFields: [],
                conflictingFields: conflicts
            )
        }

        var applied: Set<TodoFieldKey> = []
        var conflicts: Set<TodoFieldKey> = []

        func resolveString(_ key: TodoFieldKey, base: String, edited: String, current: String) -> String {
            guard edited != base else { return current }
            if current == base || current == edited {
                applied.insert(key)
                return edited
            }
            conflicts.insert(key)
            return current
        }

        func resolveOptional(_ key: TodoFieldKey, base: String?, edited: String?, current: String?) -> String? {
            guard edited != base else { return current }
            if current == base || current == edited {
                applied.insert(key)
                return edited
            }
            conflicts.insert(key)
            return current
        }

        let mergedTitle = resolveString(.title, base: base.title, edited: editedTitle, current: latestTitle)
        let mergedNotes = resolveString(.notes, base: base.notes, edited: editedNotes, current: latestNotes)
        let mergedDue = resolveOptional(.dueOn, base: base.dueOn, edited: editedDueOn, current: latestDueOn)
        return TodoConflictMergeResult(
            title: mergedTitle,
            notes: mergedNotes,
            dueOn: mergedDue,
            appliedFields: applied,
            conflictingFields: conflicts
        )
    }
}

/// Frozen snapshot captured when the user opens Assign; submits strictly against `baseVersion`.
struct TodoAssignSession: Identifiable, Equatable, Sendable {
    let id = UUID()
    let todoID: UUID
    let baseVersion: Int
    let currentAssignee: TodoParty?
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
private final class TodoDispatchFlag {
    var entered = false
}

struct TodoPendingCreateRetry: Identifiable, Equatable, Sendable {
    let commandID: UUID
    let title: String
    let notes: String
    let dueOn: String?
    let assignee: TodoParty?

    var id: UUID { commandID }
    var label: String { "Retry adding “\(title)”" }
}

enum TodoPendingDetailAction: Equatable, Sendable {
    case offer(todoID: UUID, offerID: UUID, answer: TodoOfferAnswer)
    case state(todoID: UUID, baseVersion: Int, state: TodoState)
    case assign(todoID: UUID, baseVersion: Int, to: TodoParty?)
    case update(todoID: UUID, baseVersion: Int, title: String, notes: String, dueOn: String?)
    case comment(todoID: UUID, body: String, mentions: [TodoParty])
}

struct TodoPendingDetailRetry: Identifiable, Equatable, Sendable {
    let commandID: UUID
    let action: TodoPendingDetailAction

    var id: UUID { commandID }

    var label: String {
        switch action {
        case .offer(_, _, let answer):
            switch answer {
            case .accept: return "Retry Accept request"
            case .decline: return "Retry Decline request"
            case .withdraw: return "Retry Withdraw request"
            }
        case .state(_, _, let state):
            switch state {
            case .done: return "Retry Mark done"
            case .doing: return "Retry Start"
            case .open: return "Retry Reopen"
            case .dropped: return "Retry Drop"
            }
        case .assign(_, _, let to):
            return to == nil ? "Retry Unassign" : "Retry assignment"
        case .update:
            return "Retry edit"
        case .comment:
            return "Retry comment"
        }
    }
}

/// Live-session in-memory store for unresolved write command IDs so Back/reopen in the same login
/// recovers the exact original command ID and payload, while retiring or switching logins wipes it immediately.
@MainActor
final class TodoPendingWriteStore {
    static let shared = TodoPendingWriteStore()

    struct DetailKey: Hashable {
        let workspaceID: UUID
        let todoID: UUID
    }

    struct DetailBucket {
        var state: TodoDetailViewModel.PendingState?
        var assign: TodoDetailViewModel.PendingAssign?
        var offer: TodoDetailViewModel.PendingOffer?
        var update: TodoDetailViewModel.PendingUpdate?
        var comment: TodoDetailViewModel.PendingComment?

        var isEmpty: Bool {
            state == nil && assign == nil && offer == nil && update == nil && comment == nil
        }
    }

    private struct SessionEntry {
        weak var session: HumanSession?
        var creates: [UUID: TodoListViewModel.PendingCreate] = [:]
        var details: [DetailKey: DetailBucket] = [:]

        var isEmpty: Bool {
            creates.isEmpty && details.isEmpty
        }
    }

    private var entries: [ObjectIdentifier: SessionEntry] = [:]
    private var signOutRegistered: Set<ObjectIdentifier> = []

    private init() {}

    private func pruneInactive() {
        entries = entries.filter { sid, entry in
            guard let session = entry.session, session.isActive else {
                signOutRegistered.remove(sid)
                return false
            }
            return !entry.isEmpty
        }
    }

    private func ensureSignOutHook(for session: HumanSession, sid: ObjectIdentifier) {
        guard !signOutRegistered.contains(sid) else { return }
        signOutRegistered.insert(sid)
        session.onSignOut { [weak self] in
            self?.clearSession(sid)
        }
    }

    func clearSession(_ sessionID: ObjectIdentifier) {
        entries.removeValue(forKey: sessionID)
        signOutRegistered.remove(sessionID)
    }

    /// Direct inspection without lazy pruning — verifies `HumanSession.signOut()` eagerly erased payloads.
    func hasStoredEntriesUnpruned(for sessionID: ObjectIdentifier) -> Bool {
        guard let entry = entries[sessionID] else { return false }
        return !entry.isEmpty
    }

    func pendingCreate(for session: HumanSession, workspaceID: UUID) -> TodoListViewModel.PendingCreate? {
        pruneInactive()
        guard session.isActive else { return nil }
        return entries[ObjectIdentifier(session)]?.creates[workspaceID]
    }

    func updatePendingCreate(
        for session: HumanSession?,
        workspaceID: UUID?,
        mutate: (inout TodoListViewModel.PendingCreate?) -> Void
    ) -> TodoListViewModel.PendingCreate? {
        pruneInactive()
        guard let session, let workspaceID else { return nil }
        let sid = ObjectIdentifier(session)
        guard session.isActive else {
            clearSession(sid)
            return nil
        }
        var entry = entries[sid] ?? SessionEntry(session: session)
        entry.session = session
        var current = entry.creates[workspaceID]
        mutate(&current)
        if let updated = current {
            ensureSignOutHook(for: session, sid: sid)
            entry.creates[workspaceID] = updated
        } else {
            entry.creates.removeValue(forKey: workspaceID)
        }
        if entry.isEmpty {
            entries.removeValue(forKey: sid)
        } else {
            entries[sid] = entry
        }
        return current
    }

    func detailBucket(for session: HumanSession, workspaceID: UUID, todoID: UUID) -> DetailBucket {
        pruneInactive()
        guard session.isActive else { return DetailBucket() }
        return entries[ObjectIdentifier(session)]?.details[DetailKey(workspaceID: workspaceID, todoID: todoID)] ?? DetailBucket()
    }

    @discardableResult
    func updateDetailBucket(
        for session: HumanSession?,
        workspaceID: UUID?,
        todoID: UUID?,
        mutate: (inout DetailBucket) -> Void
    ) -> DetailBucket {
        pruneInactive()
        guard let session, let workspaceID, let todoID else { return DetailBucket() }
        let sid = ObjectIdentifier(session)
        guard session.isActive else {
            clearSession(sid)
            return DetailBucket()
        }
        var entry = entries[sid] ?? SessionEntry(session: session)
        entry.session = session
        let key = DetailKey(workspaceID: workspaceID, todoID: todoID)
        var bucket = entry.details[key] ?? DetailBucket()
        mutate(&bucket)
        if bucket.isEmpty {
            entry.details.removeValue(forKey: key)
        } else {
            ensureSignOutHook(for: session, sid: sid)
            entry.details[key] = bucket
        }
        if entry.isEmpty {
            entries.removeValue(forKey: sid)
        } else {
            entries[sid] = entry
        }
        return bucket
    }
}

@MainActor
final class TodoListViewModel: ObservableObject {
    @Published var filter: TodoFilter = .open
    @Published private(set) var todos: [TodoSummary]?
    @Published private(set) var directory: TodoDirectory
    @Published private(set) var access: TodoAccess?
    @Published private(set) var isLoading = false
    @Published private(set) var failure: TodoLoadFailure?
    @Published private(set) var isCreating = false
    @Published private(set) var createError: String?
    @Published var activeCreateSession: TodoCreateSession?
    @Published private(set) var pendingCreate: PendingCreate?

    struct PendingCreate: Equatable, Sendable {
        let sessionID: ObjectIdentifier
        let workspaceID: UUID
        let title: String
        let notes: String
        let dueOn: String?
        let assignee: TodoParty?
        let commandID: UUID
        let ownerToken: UUID
        var outcomeUnknown: Bool
    }

    private let viewerUserID: UUID
    private var loadGeneration = 0
    private var accessGeneration = 0
    private var isRetired = false
    private var activeSessionID: ObjectIdentifier?
    private weak var activeSession: HumanSession?
    private var activeWorkspaceID: UUID?

    init(viewerUserID: UUID) {
        self.viewerUserID = viewerUserID
        self.directory = .empty(viewerUserID: viewerUserID)
    }

    var canCreate: Bool {
        !isRetired && access?.canCreate == true
    }

    var hasUnknownPendingCreate: Bool {
        pendingCreate?.outcomeUnknown == true
    }

    var eligiblePendingCreateRetry: TodoPendingCreateRetry? {
        guard canCreate, let pending = pendingCreate, pending.outcomeUnknown else { return nil }
        return TodoPendingCreateRetry(
            commandID: pending.commandID,
            title: pending.title,
            notes: pending.notes,
            dueOn: pending.dueOn,
            assignee: pending.assignee
        )
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
        activeCreateSession = nil
    }

    func activate() {
        isRetired = false
    }

    @discardableResult
    func openCreateSheet() -> TodoCreateSession? {
        guard canCreate else { return nil }
        if pendingCreate?.outcomeUnknown != true {
            createError = nil
        }
        let session = TodoCreateSession()
        activeCreateSession = session
        return session
    }

    func dismissCreateSession(_ sessionID: UUID) {
        if activeCreateSession?.id == sessionID {
            activeCreateSession = nil
        }
    }

    private func claimPendingCreate(
        session: HumanSession,
        workspaceID: UUID,
        title: String,
        notes: String,
        dueOn: String?,
        assignee: TodoParty?,
        ownerToken: UUID
    ) -> PendingCreate? {
        let sid = ObjectIdentifier(session)
        var claimed: PendingCreate?
        let latest = TodoPendingWriteStore.shared.updatePendingCreate(for: session, workspaceID: workspaceID) { current in
            if let existing = current, existing.sessionID == sid, existing.workspaceID == workspaceID {
                if existing.title == title && existing.notes == notes && existing.dueOn == dueOn && existing.assignee == assignee {
                    let next = PendingCreate(
                        sessionID: sid,
                        workspaceID: workspaceID,
                        title: title,
                        notes: notes,
                        dueOn: dueOn,
                        assignee: assignee,
                        commandID: existing.commandID,
                        ownerToken: ownerToken,
                        outcomeUnknown: existing.outcomeUnknown
                    )
                    current = next
                    claimed = next
                } else if existing.outcomeUnknown {
                    claimed = nil
                } else {
                    let next = PendingCreate(
                        sessionID: sid,
                        workspaceID: workspaceID,
                        title: title,
                        notes: notes,
                        dueOn: dueOn,
                        assignee: assignee,
                        commandID: UUID(),
                        ownerToken: ownerToken,
                        outcomeUnknown: false
                    )
                    current = next
                    claimed = next
                }
            } else {
                let next = PendingCreate(
                    sessionID: sid,
                    workspaceID: workspaceID,
                    title: title,
                    notes: notes,
                    dueOn: dueOn,
                    assignee: assignee,
                    commandID: UUID(),
                    ownerToken: ownerToken,
                    outcomeUnknown: false
                )
                current = next
                claimed = next
            }
        }
        pendingCreate = latest
        return claimed
    }

    private func markPendingCreateUnknown(session: HumanSession, workspaceID: UUID, commandID: UUID, ownerToken: UUID) -> Bool {
        var transitioned = false
        pendingCreate = TodoPendingWriteStore.shared.updatePendingCreate(for: session, workspaceID: workspaceID) { current in
            guard let existing = current,
                  existing.commandID == commandID,
                  existing.ownerToken == ownerToken else { return }
            current = PendingCreate(
                sessionID: existing.sessionID,
                workspaceID: existing.workspaceID,
                title: existing.title,
                notes: existing.notes,
                dueOn: existing.dueOn,
                assignee: existing.assignee,
                commandID: existing.commandID,
                ownerToken: ownerToken,
                outcomeUnknown: true
            )
            transitioned = true
        }
        return transitioned
    }

    private func clearPreDispatchPendingCreate(session: HumanSession, workspaceID: UUID, commandID: UUID, ownerToken: UUID) {
        pendingCreate = TodoPendingWriteStore.shared.updatePendingCreate(for: session, workspaceID: workspaceID) { current in
            guard let existing = current,
                  existing.commandID == commandID,
                  existing.ownerToken == ownerToken,
                  !existing.outcomeUnknown else { return }
            current = nil
        }
    }

    private func resolvePendingCreate(session: HumanSession, workspaceID: UUID, commandID: UUID) {
        pendingCreate = TodoPendingWriteStore.shared.updatePendingCreate(for: session, workspaceID: workspaceID) { current in
            guard current?.commandID == commandID else { return }
            current = nil
        }
    }

    private func clearOwnedPendingCreate(session: HumanSession, workspaceID: UUID, commandID: UUID, ownerToken: UUID) {
        pendingCreate = TodoPendingWriteStore.shared.updatePendingCreate(for: session, workspaceID: workspaceID) { current in
            guard let existing = current,
                  existing.commandID == commandID,
                  existing.ownerToken == ownerToken else { return }
            current = nil
        }
    }

    private func bindContext(session: HumanSession, workspaceID: UUID) -> Bool {
        let sid = ObjectIdentifier(session)
        if let prev = activeSessionID, prev != sid {
            TodoPendingWriteStore.shared.clearSession(prev)
            clearOnAccessLoss(reason: "unauthorized", clearPending: true)
        }
        activeSessionID = sid
        activeSession = session
        activeWorkspaceID = workspaceID
        guard session.isActive else {
            TodoPendingWriteStore.shared.clearSession(sid)
            clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            return false
        }
        pendingCreate = TodoPendingWriteStore.shared.pendingCreate(for: session, workspaceID: workspaceID)
        return true
    }

    func load(api: TodoAPI, workspaceID: UUID) async {
        activate()
        guard bindContext(session: api.session, workspaceID: workspaceID) else { return }
        loadGeneration += 1
        let generation = loadGeneration
        var capturedAccessGen = accessGeneration
        let capturedSession = api.session
        let sessionID = ObjectIdentifier(capturedSession)
        isLoading = true
        failure = nil
        let requestedScope = filter

        let accessGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            return !self.isRetired
                && capturedSession.isActive
                && self.activeSessionID == sessionID
                && self.filter == requestedScope
                && self.loadGeneration == generation
                && self.accessGeneration == capturedAccessGen
        }

        do {
            let accessStatus = try await api.access(workspace: workspaceID, canDispatch: accessGate)
            guard !Task.isCancelled, !isRetired, capturedSession.isActive,
                  filter == requestedScope, generation == loadGeneration, capturedAccessGen == accessGeneration else { return }
            switch accessStatus {
            case .refused(let reason):
                clearOnAccessLoss(reason: reason, clearPending: !capturedSession.isActive)
                return
            case .unavailable:
                let wasCreator = access?.canCreate == true
                access = TodoAccess(canRead: true, canCreate: false, canUpdate: false, isWorkspaceAdmin: false)
                if wasCreator {
                    accessGeneration += 1
                    capturedAccessGen = accessGeneration
                    activeCreateSession = nil
                }
            case .granted(let granted):
                guard granted.canRead else {
                    clearOnAccessLoss(reason: "workspace_access_refused", clearPending: !capturedSession.isActive)
                    return
                }
                let wasCreator = access?.canCreate == true
                access = granted
                if wasCreator && !granted.canCreate {
                    accessGeneration += 1
                    capturedAccessGen = accessGeneration
                    activeCreateSession = nil
                }
            }

            let readAccessGen = capturedAccessGen
            let readGate: @MainActor @Sendable () -> Bool = { [weak self] in
                guard let self else { return false }
                return !self.isRetired
                    && capturedSession.isActive
                    && self.activeSessionID == sessionID
                    && self.filter == requestedScope
                    && self.loadGeneration == generation
                    && self.accessGeneration == readAccessGen
            }
            async let pageTask = api.listTodos(workspace: workspaceID, scope: requestedScope, canDispatch: readGate)
            async let directoryTask = api.directory(workspace: workspaceID, canDispatch: readGate)
            let page = try await pageTask
            let resolvedDirectory = (try? await directoryTask) ?? directory
            try Task.checkCancellation()
            guard !isRetired,
                  capturedSession.isActive,
                  filter == requestedScope,
                  generation == loadGeneration,
                  readAccessGen == accessGeneration else { return }
            todos = page.todos
            directory = resolvedDirectory
            isLoading = false
        } catch TodoAPIError.refused(let reason) {
            if !Task.isCancelled && !isRetired && filter == requestedScope && generation == loadGeneration && capturedAccessGen == accessGeneration {
                if TodoRules.isAccessLossReason(reason) {
                    clearOnAccessLoss(reason: reason, clearPending: !capturedSession.isActive)
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

    func retryPendingCreate(_ item: TodoPendingCreateRetry, api: TodoAPI, workspaceID: UUID) async -> TodoWriteRecord? {
        guard !isRetired else { return nil }
        guard bindContext(session: api.session, workspaceID: workspaceID) else { return nil }
        guard let pending = pendingCreate,
              pending.outcomeUnknown,
              pending.commandID == item.commandID,
              pending.title == item.title,
              pending.notes == item.notes,
              pending.dueOn == item.dueOn,
              pending.assignee == item.assignee else { return nil }
        return await createTodo(
            session: nil,
            title: item.title,
            notes: item.notes,
            dueOn: item.dueOn,
            assignee: item.assignee,
            api: api,
            workspaceID: workspaceID
        )
    }

    func retryPendingCreate(api: TodoAPI, workspaceID: UUID) async -> TodoWriteRecord? {
        guard let item = eligiblePendingCreateRetry else { return nil }
        return await retryPendingCreate(item, api: api, workspaceID: workspaceID)
    }

    func createTodo(
        session createSession: TodoCreateSession? = nil,
        title rawTitle: String,
        notes rawNotes: String,
        dueOn: String?,
        assignee: TodoParty?,
        api: TodoAPI,
        workspaceID: UUID
    ) async -> TodoWriteRecord? {
        guard !isRetired else { return nil }
        guard bindContext(session: api.session, workspaceID: workspaceID) else { return nil }
        guard !isCreating, canCreate else { return nil }
        if let createSession, activeCreateSession?.id != createSession.id { return nil }

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
        let attemptToken = UUID()

        guard let record = claimPendingCreate(
            session: capturedSession,
            workspaceID: workspaceID,
            title: title,
            notes: notes,
            dueOn: dueOn,
            assignee: assignee,
            ownerToken: attemptToken
        ) else {
            if let existing = pendingCreate {
                createError = "An earlier add for “\(existing.title)” has an unknown outcome. Retry it unchanged to confirm its status before adding a different to-do."
            }
            return nil
        }

        let wasAlreadyUnknown = record.outcomeUnknown
        let dispatchFlag = TodoDispatchFlag()
        let writeGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            guard !self.isRetired,
                  capturedSession.isActive,
                  self.activeSessionID == sessionID,
                  self.accessGeneration == capturedAccessGen,
                  self.canCreate else {
                return false
            }
            if let createSession, self.activeCreateSession?.id != createSession.id {
                return false
            }
            guard self.markPendingCreateUnknown(
                session: capturedSession,
                workspaceID: workspaceID,
                commandID: record.commandID,
                ownerToken: attemptToken
            ) else {
                return false
            }
            dispatchFlag.entered = true
            return true
        }

        isCreating = true
        createError = nil
        defer { isCreating = false }

        let outcome = await api.createTodo(
            workspace: workspaceID,
            title: record.title,
            notes: record.notes.isEmpty ? nil : record.notes,
            dueOn: record.dueOn,
            assignee: record.assignee,
            requestID: record.commandID,
            canDispatch: writeGate
        )
        if !dispatchFlag.entered {
            if !wasAlreadyUnknown {
                clearPreDispatchPendingCreate(
                    session: capturedSession,
                    workspaceID: workspaceID,
                    commandID: record.commandID,
                    ownerToken: attemptToken
                )
            }
            if !capturedSession.isActive {
                clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            }
            return nil
        }
        guard !Task.isCancelled, !isRetired, capturedSession.isActive, capturedAccessGen == accessGeneration else {
            if !capturedSession.isActive {
                clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            }
            return nil
        }

        switch outcome {
        case .committed(let created, _):
            resolvePendingCreate(session: capturedSession, workspaceID: workspaceID, commandID: record.commandID)
            activeCreateSession = nil
            await load(api: api, workspaceID: workspaceID)
            return created
        case .conflict(_, let message):
            resolvePendingCreate(session: capturedSession, workspaceID: workspaceID, commandID: record.commandID)
            createError = message
            await load(api: api, workspaceID: workspaceID)
            return nil
        case .refused(let reason, let message):
            let keepUnknown = wasAlreadyUnknown
            let display = keepUnknown
                ? TodoRules.unknownOutcomeAfterRefusalMessage(action: "add", refusalMessage: message)
                : message
            if !keepUnknown {
                clearOwnedPendingCreate(
                    session: capturedSession,
                    workspaceID: workspaceID,
                    commandID: record.commandID,
                    ownerToken: attemptToken
                )
            }
            if TodoRules.isAccessLossReason(reason) {
                clearOnAccessLoss(reason: reason, clearPending: !capturedSession.isActive)
            } else if reason == "content_read_only" {
                downgradeToReader()
            }
            createError = display
            return nil
        case .unconfirmed(let message):
            createError = message
            return nil
        case .cancelled:
            createError = "Your add outcome is unknown. Retry unchanged to check."
            return nil
        }
    }

    private func clearOnAccessLoss(reason: String, clearPending: Bool) {
        loadGeneration += 1
        accessGeneration += 1
        isLoading = false
        todos = nil
        directory = .empty(viewerUserID: viewerUserID)
        access = nil
        activeCreateSession = nil
        failure = .refused(reason)
        if clearPending {
            if let sid = activeSessionID {
                TodoPendingWriteStore.shared.clearSession(sid)
            }
            pendingCreate = nil
        }
    }

    private func downgradeToReader() {
        accessGeneration += 1
        let wasAdmin = access?.isWorkspaceAdmin ?? false
        access = TodoAccess(canRead: true, canCreate: false, canUpdate: false, isWorkspaceAdmin: wasAdmin)
        activeCreateSession = nil
    }
}

@MainActor
final class TodoDetailViewModel: ObservableObject {
    struct PendingState: Equatable, Sendable {
        let sessionID: ObjectIdentifier
        let workspaceID: UUID
        let todoID: UUID
        let version: Int
        let state: TodoState
        let commandID: UUID
        let ownerToken: UUID
        var outcomeUnknown: Bool
    }

    struct PendingAssign: Equatable, Sendable {
        let sessionID: ObjectIdentifier
        let workspaceID: UUID
        let todoID: UUID
        let version: Int
        let to: TodoParty?
        let commandID: UUID
        let ownerToken: UUID
        var outcomeUnknown: Bool
    }

    struct PendingOffer: Equatable, Sendable {
        let sessionID: ObjectIdentifier
        let workspaceID: UUID
        let todoID: UUID
        let offerID: UUID
        let answer: TodoOfferAnswer
        let commandID: UUID
        let ownerToken: UUID
        var outcomeUnknown: Bool
    }

    struct PendingUpdate: Equatable, Sendable {
        let sessionID: ObjectIdentifier
        let workspaceID: UUID
        let todoID: UUID
        let version: Int
        let base: TodoEditBase?
        let title: String
        let notes: String
        let dueOn: String?
        let commandID: UUID
        let ownerToken: UUID
        var outcomeUnknown: Bool
    }

    struct PendingComment: Equatable, Sendable {
        let sessionID: ObjectIdentifier
        let workspaceID: UUID
        let todoID: UUID
        let body: String
        let mentions: [TodoParty]
        let commandID: UUID
        let ownerToken: UUID
        var outcomeUnknown: Bool
    }

    @Published private(set) var detail: TodoDetail?
    @Published private(set) var comments: [TodoComment] = []
    @Published private(set) var nextCommentOffset: Int?
    @Published private(set) var access: TodoAccess?
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMoreComments = false
    @Published private(set) var failure: TodoLoadFailure?
    @Published private(set) var isMutating = false
    @Published private(set) var isPostingComment = false
    @Published private(set) var statusMessage: String?
    @Published private(set) var actionError: String?
    @Published private(set) var conflictDraft: TodoConflictDraft?
    @Published var commentDraftText = ""
    @Published var commentDraftMentions: Set<TodoParty> = []
    @Published var activeEditSession: TodoEditSession?
    @Published var activeAssignSession: TodoAssignSession?
    @Published var showingMentionPicker = false
    @Published private(set) var pendingState: PendingState?
    @Published private(set) var pendingAssign: PendingAssign?
    @Published private(set) var pendingOffer: PendingOffer?
    @Published private(set) var pendingUpdate: PendingUpdate?
    @Published private(set) var pendingComment: PendingComment?

    private var loadGeneration = 0
    private var accessGeneration = 0
    private var isRetired = false
    private var activeSessionID: ObjectIdentifier?
    private weak var activeSession: HumanSession?
    private var activeWorkspaceID: UUID?
    private var activeTodoID: UUID?

    var canCreateComment: Bool {
        !isRetired && access?.canCreate == true && detail != nil
    }

    var canPostCommentDraft: Bool {
        canCreateComment && !isPostingComment && !TodoRules.cleanBody(commentDraftText).isEmpty
    }

    var canUpdate: Bool {
        !isRetired && access?.canUpdate == true && detail != nil
    }

    /// Matches server `todo_start` / `todo_set_state(doing)` authority:
    /// open state, clear gate, and either unassigned or assigned to the human viewer.
    func canStart(_ detail: TodoDetail, viewerUserID: UUID) -> Bool {
        guard canUpdate, detail.state == .open, detail.gate_clear else { return false }
        guard let assignee = detail.assignee else { return true }
        return assignee == TodoParty(kind: .user, id: viewerUserID)
    }

    func dismissConflictDraft() {
        conflictDraft = nil
    }

    var hasUnknownPendingState: Bool { pendingState?.outcomeUnknown == true }
    var hasUnknownPendingAssign: Bool { pendingAssign?.outcomeUnknown == true }
    var hasUnknownPendingOffer: Bool { pendingOffer?.outcomeUnknown == true }
    var hasUnknownPendingUpdate: Bool { pendingUpdate?.outcomeUnknown == true }
    var hasUnknownPendingComment: Bool { pendingComment?.outcomeUnknown == true }

    func canAcceptOrDeclineOffer(_ offer: TodoOfferSummary, viewerUserID: UUID) -> Bool {
        canUpdate && offer.decider_user_id == viewerUserID
    }

    func canWithdrawOffer(_ offer: TodoOfferSummary, viewerUserID: UUID) -> Bool {
        guard canUpdate else { return false }
        return offer.by?.user_id == viewerUserID || access?.isWorkspaceAdmin == true
    }

    private func offerRolePermitted(_ offer: TodoOfferSummary, answer: TodoOfferAnswer, viewerUserID: UUID) -> Bool {
        answer == .withdraw
            ? (offer.by?.user_id == viewerUserID || access?.isWorkspaceAdmin == true)
            : (offer.decider_user_id == viewerUserID)
    }

    /// Returns true if retrying `answer` on `(todoID, offerID)` is currently authorized:
    /// - If the exact original offer is still present on `detail`, live offer-specific authority is required.
    /// - If the offer disappeared or was replaced, explicit receipt reconciliation remains allowed when `canUpdate`.
    private func isOfferRetryAuthorized(todoID: UUID, offerID: UUID, answer: TodoOfferAnswer, viewerUserID: UUID) -> Bool {
        guard canUpdate else { return false }
        if let current = detail,
           current.todo_id == todoID,
           let liveOffer = current.offer,
           liveOffer.offer_id == offerID {
            return offerRolePermitted(liveOffer, answer: answer, viewerUserID: viewerUserID)
        }
        return true
    }

    private func reconcilePendingOfferAuthority(viewerUserID: UUID) {
        guard let pending = pendingOffer,
              let current = detail,
              current.todo_id == pending.todoID,
              let liveOffer = current.offer,
              liveOffer.offer_id == pending.offerID else { return }
        if !offerRolePermitted(liveOffer, answer: pending.answer, viewerUserID: viewerUserID) {
            resolvePendingOffer(session: activeSession, workspaceID: activeWorkspaceID, todoID: pending.todoID, commandID: pending.commandID)
        }
    }

    /// Action-specific eligible retries, strictly independent of `actionError` so normal refreshes never hide them.
    func eligiblePendingRetries(viewerUserID: UUID) -> [TodoPendingDetailRetry] {
        var items: [TodoPendingDetailRetry] = []
        if let p = pendingOffer, p.outcomeUnknown,
           isOfferRetryAuthorized(todoID: p.todoID, offerID: p.offerID, answer: p.answer, viewerUserID: viewerUserID) {
            items.append(TodoPendingDetailRetry(commandID: p.commandID, action: .offer(todoID: p.todoID, offerID: p.offerID, answer: p.answer)))
        }
        if let p = pendingState, p.outcomeUnknown, canUpdate {
            items.append(TodoPendingDetailRetry(commandID: p.commandID, action: .state(todoID: p.todoID, baseVersion: p.version, state: p.state)))
        }
        if let p = pendingAssign, p.outcomeUnknown, canUpdate {
            items.append(TodoPendingDetailRetry(commandID: p.commandID, action: .assign(todoID: p.todoID, baseVersion: p.version, to: p.to)))
        }
        if let p = pendingUpdate, p.outcomeUnknown, canUpdate {
            items.append(TodoPendingDetailRetry(commandID: p.commandID, action: .update(todoID: p.todoID, baseVersion: p.version, title: p.title, notes: p.notes, dueOn: p.dueOn)))
        }
        if let p = pendingComment, p.outcomeUnknown, canCreateComment {
            items.append(TodoPendingDetailRetry(commandID: p.commandID, action: .comment(todoID: p.todoID, body: p.body, mentions: p.mentions)))
        }
        return items
    }

    /// Dispatches ONLY the exact action, immutable commandID, and payload named by `item`.
    func retryPending(_ item: TodoPendingDetailRetry, api: TodoAPI, workspaceID: UUID) async -> Bool {
        guard !isRetired else { return false }
        let targetTodoID: UUID
        switch item.action {
        case .offer(let todoID, _, _),
             .state(let todoID, _, _),
             .assign(let todoID, _, _),
             .update(let todoID, _, _, _, _),
             .comment(let todoID, _, _):
            targetTodoID = todoID
        }
        guard bindContext(session: api.session, workspaceID: workspaceID, todoID: targetTodoID) else { return false }

        switch item.action {
        case .offer(let todoID, let offerID, let answer):
            guard let pending = pendingOffer,
                  pending.outcomeUnknown,
                  pending.commandID == item.commandID,
                  pending.todoID == todoID,
                  pending.offerID == offerID,
                  pending.answer == answer else { return false }
            let attemptToken = UUID()
            guard let claimed = claimPendingOffer(session: api.session, workspaceID: workspaceID, todoID: todoID, offerID: offerID, answer: answer, ownerToken: attemptToken),
                  claimed.commandID == item.commandID else { return false }
            return await executeAnswerOffer(
                todoID: todoID,
                offerID: offerID,
                answer: answer,
                commandID: item.commandID,
                ownerToken: attemptToken,
                wasAlreadyUnknown: true,
                requireDisplayedOffer: false,
                api: api,
                workspaceID: workspaceID
            )
        case .state(let todoID, let baseVersion, let state):
            guard let pending = pendingState,
                  pending.outcomeUnknown,
                  pending.commandID == item.commandID,
                  pending.todoID == todoID,
                  pending.version == baseVersion,
                  pending.state == state else { return false }
            let attemptToken = UUID()
            guard let claimed = claimPendingState(session: api.session, workspaceID: workspaceID, todoID: todoID, baseVersion: baseVersion, target: state, ownerToken: attemptToken),
                  claimed.commandID == item.commandID else { return false }
            return await executeSetState(
                todoID: todoID,
                baseVersion: baseVersion,
                target: state,
                commandID: item.commandID,
                ownerToken: attemptToken,
                wasAlreadyUnknown: true,
                requireCurrentMatch: false,
                api: api,
                workspaceID: workspaceID
            )
        case .assign(let todoID, let baseVersion, let to):
            guard let pending = pendingAssign,
                  pending.outcomeUnknown,
                  pending.commandID == item.commandID,
                  pending.todoID == todoID,
                  pending.version == baseVersion,
                  pending.to == to else { return false }
            let attemptToken = UUID()
            guard let claimed = claimPendingAssign(session: api.session, workspaceID: workspaceID, todoID: todoID, baseVersion: baseVersion, to: to, ownerToken: attemptToken),
                  claimed.commandID == item.commandID else { return false }
            return await executeAssign(
                todoID: todoID,
                baseVersion: baseVersion,
                to: to,
                commandID: item.commandID,
                ownerToken: attemptToken,
                wasAlreadyUnknown: true,
                boundAssignSessionID: nil,
                api: api,
                workspaceID: workspaceID
            )
        case .update(let todoID, let baseVersion, let title, let notes, let dueOn):
            guard let pending = pendingUpdate,
                  pending.outcomeUnknown,
                  pending.commandID == item.commandID,
                  pending.todoID == todoID,
                  pending.version == baseVersion,
                  pending.title == title,
                  pending.notes == notes,
                  pending.dueOn == dueOn else { return false }
            let attemptToken = UUID()
            guard let claimed = claimPendingUpdate(session: api.session, workspaceID: workspaceID, todoID: todoID, baseVersion: baseVersion, base: pending.base, title: title, notes: notes, dueOn: dueOn, ownerToken: attemptToken),
                  claimed.commandID == item.commandID else { return false }
            return await executeUpdate(
                todoID: todoID,
                baseVersion: baseVersion,
                base: claimed.base,
                title: title,
                notes: notes,
                dueOn: dueOn,
                commandID: item.commandID,
                ownerToken: attemptToken,
                wasAlreadyUnknown: true,
                boundEditSessionID: nil,
                api: api,
                workspaceID: workspaceID
            )
        case .comment(let todoID, let body, let mentions):
            guard let pending = pendingComment,
                  pending.outcomeUnknown,
                  pending.commandID == item.commandID,
                  pending.todoID == todoID,
                  pending.body == body,
                  pending.mentions == mentions else { return false }
            return await postComment(
                body: body,
                mentions: mentions,
                api: api,
                workspaceID: workspaceID
            )
        }
    }

    func retire() {
        isRetired = true
        loadGeneration += 1
        accessGeneration += 1
        isLoading = false
        activeEditSession = nil
        activeAssignSession = nil
        showingMentionPicker = false
    }

    func activate() {
        isRetired = false
    }

    @discardableResult
    func beginEdit() -> TodoEditSession? {
        guard canUpdate, let current = detail else { return nil }
        let session = TodoEditSession(
            todoID: current.todo_id,
            baseVersion: current.version,
            initialTitle: current.title,
            initialNotes: current.notes,
            initialDueOn: current.due_on
        )
        activeEditSession = session
        if !hasUnknownPendingUpdate {
            actionError = nil
        }
        return session
    }

    @discardableResult
    func beginAssign() -> TodoAssignSession? {
        guard canUpdate, let current = detail else { return nil }
        let session = TodoAssignSession(
            todoID: current.todo_id,
            baseVersion: current.version,
            currentAssignee: current.assignee
        )
        activeAssignSession = session
        if !hasUnknownPendingAssign {
            actionError = nil
        }
        return session
    }

    func dismissAssignSession(_ sessionID: UUID) {
        if activeAssignSession?.id == sessionID {
            activeAssignSession = nil
        }
    }

    func dismissEditSession(_ sessionID: UUID) {
        if activeEditSession?.id == sessionID {
            activeEditSession = nil
        }
    }

    // MARK: - Live-store-guarded pending write helpers (owner-token fenced)

    private func syncBucket(_ bucket: TodoPendingWriteStore.DetailBucket) {
        pendingState = bucket.state
        pendingAssign = bucket.assign
        pendingOffer = bucket.offer
        pendingUpdate = bucket.update
        pendingComment = bucket.comment
    }

    private func claimPendingState(session: HumanSession, workspaceID: UUID, todoID: UUID, baseVersion: Int, target: TodoState, ownerToken: UUID) -> PendingState? {
        let sid = ObjectIdentifier(session)
        var claimed: PendingState?
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            if let existing = b.state, existing.sessionID == sid, existing.workspaceID == workspaceID {
                if existing.todoID == todoID && existing.version == baseVersion && existing.state == target {
                    let next = PendingState(sessionID: sid, workspaceID: workspaceID, todoID: todoID, version: baseVersion, state: target, commandID: existing.commandID, ownerToken: ownerToken, outcomeUnknown: existing.outcomeUnknown)
                    b.state = next
                    claimed = next
                } else if existing.outcomeUnknown {
                    claimed = nil
                } else {
                    let next = PendingState(sessionID: sid, workspaceID: workspaceID, todoID: todoID, version: baseVersion, state: target, commandID: UUID(), ownerToken: ownerToken, outcomeUnknown: false)
                    b.state = next
                    claimed = next
                }
            } else {
                let next = PendingState(sessionID: sid, workspaceID: workspaceID, todoID: todoID, version: baseVersion, state: target, commandID: UUID(), ownerToken: ownerToken, outcomeUnknown: false)
                b.state = next
                claimed = next
            }
        }
        syncBucket(bucket)
        return claimed
    }

    private func markPendingStateUnknown(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) -> Bool {
        var transitioned = false
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.state, existing.commandID == commandID, existing.ownerToken == ownerToken else { return }
            b.state = PendingState(sessionID: existing.sessionID, workspaceID: existing.workspaceID, todoID: existing.todoID, version: existing.version, state: existing.state, commandID: existing.commandID, ownerToken: ownerToken, outcomeUnknown: true)
            transitioned = true
        }
        syncBucket(bucket)
        return transitioned
    }

    private func clearPreDispatchPendingState(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.state, existing.commandID == commandID, existing.ownerToken == ownerToken, !existing.outcomeUnknown else { return }
            b.state = nil
        }
        syncBucket(bucket)
    }

    private func resolvePendingState(session: HumanSession?, workspaceID: UUID?, todoID: UUID?, commandID: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard b.state?.commandID == commandID else { return }
            b.state = nil
        }
        syncBucket(bucket)
    }

    private func clearOwnedPendingState(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.state, existing.commandID == commandID, existing.ownerToken == ownerToken else { return }
            b.state = nil
        }
        syncBucket(bucket)
    }

    private func claimPendingAssign(session: HumanSession, workspaceID: UUID, todoID: UUID, baseVersion: Int, to: TodoParty?, ownerToken: UUID) -> PendingAssign? {
        let sid = ObjectIdentifier(session)
        var claimed: PendingAssign?
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            if let existing = b.assign, existing.sessionID == sid, existing.workspaceID == workspaceID {
                if existing.todoID == todoID && existing.version == baseVersion && existing.to == to {
                    let next = PendingAssign(sessionID: sid, workspaceID: workspaceID, todoID: todoID, version: baseVersion, to: to, commandID: existing.commandID, ownerToken: ownerToken, outcomeUnknown: existing.outcomeUnknown)
                    b.assign = next
                    claimed = next
                } else if existing.outcomeUnknown {
                    claimed = nil
                } else {
                    let next = PendingAssign(sessionID: sid, workspaceID: workspaceID, todoID: todoID, version: baseVersion, to: to, commandID: UUID(), ownerToken: ownerToken, outcomeUnknown: false)
                    b.assign = next
                    claimed = next
                }
            } else {
                let next = PendingAssign(sessionID: sid, workspaceID: workspaceID, todoID: todoID, version: baseVersion, to: to, commandID: UUID(), ownerToken: ownerToken, outcomeUnknown: false)
                b.assign = next
                claimed = next
            }
        }
        syncBucket(bucket)
        return claimed
    }

    private func markPendingAssignUnknown(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) -> Bool {
        var transitioned = false
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.assign, existing.commandID == commandID, existing.ownerToken == ownerToken else { return }
            b.assign = PendingAssign(sessionID: existing.sessionID, workspaceID: existing.workspaceID, todoID: existing.todoID, version: existing.version, to: existing.to, commandID: existing.commandID, ownerToken: ownerToken, outcomeUnknown: true)
            transitioned = true
        }
        syncBucket(bucket)
        return transitioned
    }

    private func clearPreDispatchPendingAssign(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.assign, existing.commandID == commandID, existing.ownerToken == ownerToken, !existing.outcomeUnknown else { return }
            b.assign = nil
        }
        syncBucket(bucket)
    }

    private func resolvePendingAssign(session: HumanSession?, workspaceID: UUID?, todoID: UUID?, commandID: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard b.assign?.commandID == commandID else { return }
            b.assign = nil
        }
        syncBucket(bucket)
    }

    private func clearOwnedPendingAssign(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.assign, existing.commandID == commandID, existing.ownerToken == ownerToken else { return }
            b.assign = nil
        }
        syncBucket(bucket)
    }

    private func claimPendingOffer(session: HumanSession, workspaceID: UUID, todoID: UUID, offerID: UUID, answer: TodoOfferAnswer, ownerToken: UUID) -> PendingOffer? {
        let sid = ObjectIdentifier(session)
        var claimed: PendingOffer?
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            if let existing = b.offer, existing.sessionID == sid, existing.workspaceID == workspaceID {
                if existing.todoID == todoID && existing.offerID == offerID && existing.answer == answer {
                    let next = PendingOffer(sessionID: sid, workspaceID: workspaceID, todoID: todoID, offerID: offerID, answer: answer, commandID: existing.commandID, ownerToken: ownerToken, outcomeUnknown: existing.outcomeUnknown)
                    b.offer = next
                    claimed = next
                } else if existing.outcomeUnknown {
                    claimed = nil
                } else {
                    let next = PendingOffer(sessionID: sid, workspaceID: workspaceID, todoID: todoID, offerID: offerID, answer: answer, commandID: UUID(), ownerToken: ownerToken, outcomeUnknown: false)
                    b.offer = next
                    claimed = next
                }
            } else {
                let next = PendingOffer(sessionID: sid, workspaceID: workspaceID, todoID: todoID, offerID: offerID, answer: answer, commandID: UUID(), ownerToken: ownerToken, outcomeUnknown: false)
                b.offer = next
                claimed = next
            }
        }
        syncBucket(bucket)
        return claimed
    }

    private func markPendingOfferUnknown(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) -> Bool {
        var transitioned = false
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.offer, existing.commandID == commandID, existing.ownerToken == ownerToken else { return }
            b.offer = PendingOffer(sessionID: existing.sessionID, workspaceID: existing.workspaceID, todoID: existing.todoID, offerID: existing.offerID, answer: existing.answer, commandID: existing.commandID, ownerToken: ownerToken, outcomeUnknown: true)
            transitioned = true
        }
        syncBucket(bucket)
        return transitioned
    }

    private func clearPreDispatchPendingOffer(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.offer, existing.commandID == commandID, existing.ownerToken == ownerToken, !existing.outcomeUnknown else { return }
            b.offer = nil
        }
        syncBucket(bucket)
    }

    private func resolvePendingOffer(session: HumanSession?, workspaceID: UUID?, todoID: UUID?, commandID: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard b.offer?.commandID == commandID else { return }
            b.offer = nil
        }
        syncBucket(bucket)
    }

    private func clearOwnedPendingOffer(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.offer, existing.commandID == commandID, existing.ownerToken == ownerToken else { return }
            b.offer = nil
        }
        syncBucket(bucket)
    }

    private func claimPendingUpdate(session: HumanSession, workspaceID: UUID, todoID: UUID, baseVersion: Int, base: TodoEditBase?, title: String, notes: String, dueOn: String?, ownerToken: UUID) -> PendingUpdate? {
        let sid = ObjectIdentifier(session)
        var claimed: PendingUpdate?
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            if let existing = b.update, existing.sessionID == sid, existing.workspaceID == workspaceID {
                if existing.todoID == todoID && existing.version == baseVersion && existing.title == title && existing.notes == notes && existing.dueOn == dueOn {
                    let next = PendingUpdate(sessionID: sid, workspaceID: workspaceID, todoID: todoID, version: baseVersion, base: existing.base ?? base, title: title, notes: notes, dueOn: dueOn, commandID: existing.commandID, ownerToken: ownerToken, outcomeUnknown: existing.outcomeUnknown)
                    b.update = next
                    claimed = next
                } else if existing.outcomeUnknown {
                    claimed = nil
                } else {
                    let next = PendingUpdate(sessionID: sid, workspaceID: workspaceID, todoID: todoID, version: baseVersion, base: base, title: title, notes: notes, dueOn: dueOn, commandID: UUID(), ownerToken: ownerToken, outcomeUnknown: false)
                    b.update = next
                    claimed = next
                }
            } else {
                let next = PendingUpdate(sessionID: sid, workspaceID: workspaceID, todoID: todoID, version: baseVersion, base: base, title: title, notes: notes, dueOn: dueOn, commandID: UUID(), ownerToken: ownerToken, outcomeUnknown: false)
                b.update = next
                claimed = next
            }
        }
        syncBucket(bucket)
        return claimed
    }

    private func markPendingUpdateUnknown(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) -> Bool {
        var transitioned = false
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.update, existing.commandID == commandID, existing.ownerToken == ownerToken else { return }
            b.update = PendingUpdate(sessionID: existing.sessionID, workspaceID: existing.workspaceID, todoID: existing.todoID, version: existing.version, base: existing.base, title: existing.title, notes: existing.notes, dueOn: existing.dueOn, commandID: existing.commandID, ownerToken: ownerToken, outcomeUnknown: true)
            transitioned = true
        }
        syncBucket(bucket)
        return transitioned
    }

    private func clearPreDispatchPendingUpdate(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.update, existing.commandID == commandID, existing.ownerToken == ownerToken, !existing.outcomeUnknown else { return }
            b.update = nil
        }
        syncBucket(bucket)
    }

    private func resolvePendingUpdate(session: HumanSession?, workspaceID: UUID?, todoID: UUID?, commandID: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard b.update?.commandID == commandID else { return }
            b.update = nil
        }
        syncBucket(bucket)
    }

    private func clearOwnedPendingUpdate(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.update, existing.commandID == commandID, existing.ownerToken == ownerToken else { return }
            b.update = nil
        }
        syncBucket(bucket)
    }

    private func claimPendingComment(session: HumanSession, workspaceID: UUID, todoID: UUID, body: String, mentions: [TodoParty], ownerToken: UUID) -> PendingComment? {
        let sid = ObjectIdentifier(session)
        var claimed: PendingComment?
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            if let existing = b.comment, existing.sessionID == sid, existing.workspaceID == workspaceID {
                if existing.todoID == todoID && existing.body == body && existing.mentions == mentions {
                    let next = PendingComment(sessionID: sid, workspaceID: workspaceID, todoID: todoID, body: body, mentions: mentions, commandID: existing.commandID, ownerToken: ownerToken, outcomeUnknown: existing.outcomeUnknown)
                    b.comment = next
                    claimed = next
                } else if existing.outcomeUnknown {
                    claimed = nil
                } else {
                    let next = PendingComment(sessionID: sid, workspaceID: workspaceID, todoID: todoID, body: body, mentions: mentions, commandID: UUID(), ownerToken: ownerToken, outcomeUnknown: false)
                    b.comment = next
                    claimed = next
                }
            } else {
                let next = PendingComment(sessionID: sid, workspaceID: workspaceID, todoID: todoID, body: body, mentions: mentions, commandID: UUID(), ownerToken: ownerToken, outcomeUnknown: false)
                b.comment = next
                claimed = next
            }
        }
        syncBucket(bucket)
        return claimed
    }

    private func markPendingCommentUnknown(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) -> Bool {
        var transitioned = false
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.comment, existing.commandID == commandID, existing.ownerToken == ownerToken else { return }
            b.comment = PendingComment(sessionID: existing.sessionID, workspaceID: existing.workspaceID, todoID: existing.todoID, body: existing.body, mentions: existing.mentions, commandID: existing.commandID, ownerToken: ownerToken, outcomeUnknown: true)
            transitioned = true
        }
        syncBucket(bucket)
        return transitioned
    }

    private func clearPreDispatchPendingComment(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.comment, existing.commandID == commandID, existing.ownerToken == ownerToken, !existing.outcomeUnknown else { return }
            b.comment = nil
        }
        syncBucket(bucket)
    }

    private func resolvePendingComment(session: HumanSession?, workspaceID: UUID?, todoID: UUID?, commandID: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard b.comment?.commandID == commandID else { return }
            b.comment = nil
        }
        syncBucket(bucket)
    }

    private func clearOwnedPendingComment(session: HumanSession, workspaceID: UUID, todoID: UUID, commandID: UUID, ownerToken: UUID) {
        let bucket = TodoPendingWriteStore.shared.updateDetailBucket(for: session, workspaceID: workspaceID, todoID: todoID) { b in
            guard let existing = b.comment, existing.commandID == commandID, existing.ownerToken == ownerToken else { return }
            b.comment = nil
        }
        syncBucket(bucket)
    }

    private func hydratePending(session: HumanSession, workspaceID: UUID, todoID: UUID) {
        syncBucket(TodoPendingWriteStore.shared.detailBucket(for: session, workspaceID: workspaceID, todoID: todoID))
    }

    private func bindContext(session: HumanSession, workspaceID: UUID, todoID: UUID) -> Bool {
        let sid = ObjectIdentifier(session)
        if let prev = activeSessionID, prev != sid {
            TodoPendingWriteStore.shared.clearSession(prev)
            clearOnAccessLoss(reason: "unauthorized", clearPending: true)
        }
        activeSessionID = sid
        activeSession = session
        activeWorkspaceID = workspaceID
        activeTodoID = todoID
        guard session.isActive else {
            TodoPendingWriteStore.shared.clearSession(sid)
            clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            return false
        }
        hydratePending(session: session, workspaceID: workspaceID, todoID: todoID)
        return true
    }

    func load(api: TodoAPI, workspaceID: UUID, todoID: UUID, preserveNotice: Bool = false) async {
        activate()
        guard bindContext(session: api.session, workspaceID: workspaceID, todoID: todoID) else { return }
        loadGeneration += 1
        let generation = loadGeneration
        var capturedAccessGen = accessGeneration
        let capturedSession = api.session
        let sessionID = ObjectIdentifier(capturedSession)
        isLoading = true
        failure = nil
        if !preserveNotice {
            statusMessage = nil
            actionError = nil
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
            let accessStatus = try await api.access(workspace: workspaceID, canDispatch: accessGate)
            guard !Task.isCancelled, !isRetired, capturedSession.isActive,
                  generation == loadGeneration, capturedAccessGen == accessGeneration else { return }
            switch accessStatus {
            case .refused(let reason):
                clearOnAccessLoss(reason: reason, clearPending: !capturedSession.isActive)
                return
            case .unavailable:
                let hadWrite = (access?.canCreate == true) || (access?.canUpdate == true)
                access = TodoAccess(canRead: true, canCreate: false, canUpdate: false, isWorkspaceAdmin: false)
                if hadWrite {
                    accessGeneration += 1
                    capturedAccessGen = accessGeneration
                    closeWriteSurfaces()
                }
            case .granted(let granted):
                guard granted.canRead else {
                    clearOnAccessLoss(reason: "workspace_access_refused", clearPending: !capturedSession.isActive)
                    return
                }
                let lostWrite = (access?.canCreate == true && !granted.canCreate)
                    || (access?.canUpdate == true && !granted.canUpdate)
                    || (access?.isWorkspaceAdmin == true && !granted.isWorkspaceAdmin)
                access = granted
                if lostWrite {
                    accessGeneration += 1
                    capturedAccessGen = accessGeneration
                    if !granted.canUpdate {
                        activeEditSession = nil
                        activeAssignSession = nil
                    }
                    if !granted.canCreate {
                        showingMentionPicker = false
                    }
                } else {
                    if !granted.canUpdate {
                        activeEditSession = nil
                        activeAssignSession = nil
                    }
                    if !granted.canCreate {
                        showingMentionPicker = false
                    }
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
            let response = try await api.readTodo(workspace: workspaceID, todoID: todoID, canDispatch: readGate)
            try Task.checkCancellation()
            guard !isRetired, capturedSession.isActive, generation == loadGeneration, readAccessGen == accessGeneration else { return }
            detail = response.todo
            comments = response.comments
            nextCommentOffset = response.nextCommentOffset
            isLoading = false
            reconcilePendingOfferAuthority(viewerUserID: api.viewerUserID)
            if let openEdit = activeEditSession, openEdit.baseVersion != response.todo.version {
                activeEditSession = nil
            }
            if let openAssign = activeAssignSession, openAssign.baseVersion != response.todo.version {
                activeAssignSession = nil
            }
        } catch TodoAPIError.refused(let reason) {
            if !Task.isCancelled && !isRetired && generation == loadGeneration && capturedAccessGen == accessGeneration {
                if TodoRules.isAccessLossReason(reason) || reason == "todo_not_found" {
                    clearOnAccessLoss(reason: reason, clearPending: !capturedSession.isActive)
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
        guard !isRetired, let current = detail else { return }
        guard bindContext(session: api.session, workspaceID: workspaceID, todoID: current.todo_id) else { return }
        guard !isLoadingMoreComments, let offset = nextCommentOffset else { return }
        let capturedSession = api.session
        let sessionID = ObjectIdentifier(capturedSession)
        let capturedLoadGen = loadGeneration
        let capturedAccessGen = accessGeneration
        let pageGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            return !self.isRetired
                && capturedSession.isActive
                && self.activeSessionID == sessionID
                && self.loadGeneration == capturedLoadGen
                && self.accessGeneration == capturedAccessGen
        }
        isLoadingMoreComments = true
        defer { isLoadingMoreComments = false }
        do {
            let response = try await api.readTodo(workspace: workspaceID, todoID: current.todo_id, commentOffset: offset, canDispatch: pageGate)
            try Task.checkCancellation()
            guard !isRetired, capturedSession.isActive,
                  loadGeneration == capturedLoadGen, accessGeneration == capturedAccessGen else { return }
            let existingIDs = Set(comments.map(\.comment_id))
            let newItems = response.comments.filter { !existingIDs.contains($0.comment_id) }
            comments.append(contentsOf: newItems)
            if let next = response.nextCommentOffset, next > offset {
                nextCommentOffset = next
            } else {
                nextCommentOffset = nil
            }
        } catch TodoAPIError.refused(let reason) {
            guard !Task.isCancelled, !isRetired,
                  loadGeneration == capturedLoadGen, accessGeneration == capturedAccessGen else { return }
            if TodoRules.isAccessLossReason(reason) || reason == "todo_not_found" {
                clearOnAccessLoss(reason: reason, clearPending: !capturedSession.isActive)
            } else {
                actionError = TodoRules.refusalMessage(reason, fallback: "Couldn’t load earlier comments.")
            }
        } catch is CancellationError {
            if !capturedSession.isActive {
                clearOnAccessLoss(reason: "unauthorized", clearPending: true)
            }
        } catch {
            guard !Task.isCancelled, !isRetired, capturedSession.isActive,
                  loadGeneration == capturedLoadGen, accessGeneration == capturedAccessGen else { return }
            actionError = "Couldn’t load earlier comments."
        }
    }

    func retryPendingState(api: TodoAPI, workspaceID: UUID) async -> Bool {
        guard let pending = pendingState, pending.outcomeUnknown else { return false }
        let item = TodoPendingDetailRetry(
            commandID: pending.commandID,
            action: .state(todoID: pending.todoID, baseVersion: pending.version, state: pending.state)
        )
        return await retryPending(item, api: api, workspaceID: workspaceID)
    }

    func setState(
        _ target: TodoState,
        todoID: UUID,
        baseVersion: Int,
        api: TodoAPI,
        workspaceID: UUID
    ) async -> Bool {
        guard !isRetired else { return false }
        guard bindContext(session: api.session, workspaceID: workspaceID, todoID: todoID) else { return false }
        guard !isMutating, canUpdate else { return false }
        guard detail?.todo_id == todoID, detail?.version == baseVersion else {
            actionError = "This to-do changed since you loaded it. Review the latest version and try again."
            return false
        }
        let attemptToken = UUID()
        guard let claimed = claimPendingState(session: api.session, workspaceID: workspaceID, todoID: todoID, baseVersion: baseVersion, target: target, ownerToken: attemptToken) else {
            actionError = "An earlier state change has an unknown outcome. Retry it unchanged to check before making another change."
            return false
        }
        return await executeSetState(
            todoID: todoID,
            baseVersion: baseVersion,
            target: target,
            commandID: claimed.commandID,
            ownerToken: attemptToken,
            wasAlreadyUnknown: claimed.outcomeUnknown,
            requireCurrentMatch: true,
            api: api,
            workspaceID: workspaceID
        )
    }

    private func executeSetState(
        todoID: UUID,
        baseVersion: Int,
        target: TodoState,
        commandID: UUID,
        ownerToken: UUID,
        wasAlreadyUnknown: Bool,
        requireCurrentMatch: Bool,
        api: TodoAPI,
        workspaceID: UUID
    ) async -> Bool {
        guard !isRetired else { return false }
        guard bindContext(session: api.session, workspaceID: workspaceID, todoID: todoID) else { return false }
        guard !isMutating, canUpdate else { return false }
        let capturedSession = api.session
        let sid = ObjectIdentifier(capturedSession)
        let capturedAccessGen = accessGeneration
        let dispatchFlag = TodoDispatchFlag()

        let writeGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            guard !self.isRetired, capturedSession.isActive, self.activeSessionID == sid,
                  self.accessGeneration == capturedAccessGen, self.canUpdate else { return false }
            if requireCurrentMatch {
                guard self.detail?.todo_id == todoID, self.detail?.version == baseVersion else { return false }
            }
            guard self.markPendingStateUnknown(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID, ownerToken: ownerToken) else {
                return false
            }
            dispatchFlag.entered = true
            return true
        }

        isMutating = true
        statusMessage = nil
        actionError = nil
        defer { isMutating = false }

        let outcome = await api.setTodoState(
            workspace: workspaceID,
            todoID: todoID,
            baseVersion: baseVersion,
            state: target,
            requestID: commandID,
            canDispatch: writeGate
        )
        if !dispatchFlag.entered {
            if !wasAlreadyUnknown {
                clearPreDispatchPendingState(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID, ownerToken: ownerToken)
            }
            if !capturedSession.isActive { clearOnAccessLoss(reason: "unauthorized", clearPending: true) }
            return false
        }
        guard !Task.isCancelled, !isRetired, capturedSession.isActive, capturedAccessGen == accessGeneration else {
            if !capturedSession.isActive { clearOnAccessLoss(reason: "unauthorized", clearPending: true) }
            return false
        }
        return await handleTodoWrite(
            outcome,
            api: api,
            workspaceID: workspaceID,
            actionName: "state change",
            wasAlreadyUnknown: wasAlreadyUnknown,
            resolvePending: { self.resolvePendingState(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID) },
            clearOwnedPending: { self.clearOwnedPendingState(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID, ownerToken: ownerToken) },
            successMessage: { _ in self.stateMessage(for: target) }
        )
    }

    func retryPendingAssign(api: TodoAPI, workspaceID: UUID) async -> Bool {
        guard let pending = pendingAssign, pending.outcomeUnknown else { return false }
        let item = TodoPendingDetailRetry(
            commandID: pending.commandID,
            action: .assign(todoID: pending.todoID, baseVersion: pending.version, to: pending.to)
        )
        return await retryPending(item, api: api, workspaceID: workspaceID)
    }

    func assign(
        session assignSession: TodoAssignSession,
        to party: TodoParty?,
        api: TodoAPI,
        workspaceID: UUID
    ) async -> Bool {
        guard !isRetired else { return false }
        guard bindContext(session: api.session, workspaceID: workspaceID, todoID: assignSession.todoID) else { return false }
        guard !isMutating, canUpdate else { return false }
        guard activeAssignSession?.id == assignSession.id,
              detail?.todo_id == assignSession.todoID,
              detail?.version == assignSession.baseVersion else {
            activeAssignSession = nil
            actionError = "This to-do changed since you opened assignment. Review the latest version and try again."
            return false
        }
        let attemptToken = UUID()
        guard let claimed = claimPendingAssign(session: api.session, workspaceID: workspaceID, todoID: assignSession.todoID, baseVersion: assignSession.baseVersion, to: party, ownerToken: attemptToken) else {
            actionError = "An earlier assignment change has an unknown outcome. Retry it unchanged to check before changing it again."
            return false
        }
        return await executeAssign(
            todoID: assignSession.todoID,
            baseVersion: assignSession.baseVersion,
            to: party,
            commandID: claimed.commandID,
            ownerToken: attemptToken,
            wasAlreadyUnknown: claimed.outcomeUnknown,
            boundAssignSessionID: assignSession.id,
            api: api,
            workspaceID: workspaceID
        )
    }

    private func executeAssign(
        todoID: UUID,
        baseVersion: Int,
        to party: TodoParty?,
        commandID: UUID,
        ownerToken: UUID,
        wasAlreadyUnknown: Bool,
        boundAssignSessionID: UUID?,
        api: TodoAPI,
        workspaceID: UUID
    ) async -> Bool {
        guard !isRetired else { return false }
        guard bindContext(session: api.session, workspaceID: workspaceID, todoID: todoID) else { return false }
        guard !isMutating, canUpdate else { return false }
        let capturedSession = api.session
        let sid = ObjectIdentifier(capturedSession)
        let capturedAccessGen = accessGeneration
        let dispatchFlag = TodoDispatchFlag()

        let writeGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            guard !self.isRetired, capturedSession.isActive, self.activeSessionID == sid,
                  self.accessGeneration == capturedAccessGen, self.canUpdate else { return false }
            if let boundAssignSessionID {
                guard self.activeAssignSession?.id == boundAssignSessionID,
                      self.detail?.todo_id == todoID,
                      self.detail?.version == baseVersion else { return false }
            }
            guard self.markPendingAssignUnknown(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID, ownerToken: ownerToken) else {
                return false
            }
            dispatchFlag.entered = true
            return true
        }

        isMutating = true
        statusMessage = nil
        actionError = nil
        defer { isMutating = false }

        let outcome = await api.assignTodo(
            workspace: workspaceID,
            todoID: todoID,
            baseVersion: baseVersion,
            to: party,
            requestID: commandID,
            canDispatch: writeGate
        )
        if !dispatchFlag.entered {
            if !wasAlreadyUnknown {
                clearPreDispatchPendingAssign(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID, ownerToken: ownerToken)
            }
            if !capturedSession.isActive { clearOnAccessLoss(reason: "unauthorized", clearPending: true) }
            return false
        }
        guard !Task.isCancelled, !isRetired, capturedSession.isActive, capturedAccessGen == accessGeneration else {
            if !capturedSession.isActive { clearOnAccessLoss(reason: "unauthorized", clearPending: true) }
            return false
        }
        let ok = await handleTodoWrite(
            outcome,
            api: api,
            workspaceID: workspaceID,
            actionName: "assignment",
            wasAlreadyUnknown: wasAlreadyUnknown,
            resolvePending: { self.resolvePendingAssign(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID) },
            clearOwnedPending: { self.clearOwnedPendingAssign(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID, ownerToken: ownerToken) },
            successMessage: { receipt in
                if receipt.offer != nil {
                    return "Work request sent."
                }
                return party == nil ? "Unassigned." : "Assignment updated."
            }
        )
        if ok { activeAssignSession = nil }
        return ok
    }

    func retryPendingOffer(api: TodoAPI, workspaceID: UUID) async -> Bool {
        guard let pending = pendingOffer, pending.outcomeUnknown else { return false }
        let item = TodoPendingDetailRetry(
            commandID: pending.commandID,
            action: .offer(todoID: pending.todoID, offerID: pending.offerID, answer: pending.answer)
        )
        return await retryPending(item, api: api, workspaceID: workspaceID)
    }

    func answerOffer(
        _ answer: TodoOfferAnswer,
        todoID: UUID,
        offerID: UUID,
        api: TodoAPI,
        workspaceID: UUID
    ) async -> Bool {
        guard !isRetired else { return false }
        guard bindContext(session: api.session, workspaceID: workspaceID, todoID: todoID) else { return false }
        guard !isMutating, canUpdate else { return false }
        guard let current = detail,
              current.todo_id == todoID,
              let offer = current.offer,
              offer.offer_id == offerID else {
            actionError = "That work request changed or is no longer pending."
            return false
        }
        let viewerID = api.viewerUserID
        let permitted = answer == .withdraw
            ? canWithdrawOffer(offer, viewerUserID: viewerID)
            : canAcceptOrDeclineOffer(offer, viewerUserID: viewerID)
        guard permitted else {
            actionError = TodoRules.refusalMessage("not_decider")
            return false
        }

        let attemptToken = UUID()
        guard let claimed = claimPendingOffer(session: api.session, workspaceID: workspaceID, todoID: todoID, offerID: offerID, answer: answer, ownerToken: attemptToken) else {
            actionError = "An earlier response to this request has an unknown outcome. Retry it unchanged to check first."
            return false
        }
        return await executeAnswerOffer(
            todoID: todoID,
            offerID: offerID,
            answer: answer,
            commandID: claimed.commandID,
            ownerToken: attemptToken,
            wasAlreadyUnknown: claimed.outcomeUnknown,
            requireDisplayedOffer: true,
            api: api,
            workspaceID: workspaceID
        )
    }

    private func executeAnswerOffer(
        todoID: UUID,
        offerID: UUID,
        answer: TodoOfferAnswer,
        commandID: UUID,
        ownerToken: UUID,
        wasAlreadyUnknown: Bool,
        requireDisplayedOffer: Bool,
        api: TodoAPI,
        workspaceID: UUID
    ) async -> Bool {
        guard !isRetired else { return false }
        guard bindContext(session: api.session, workspaceID: workspaceID, todoID: todoID) else { return false }
        guard !isMutating, canUpdate else { return false }
        let capturedSession = api.session
        let viewerID = api.viewerUserID
        if !requireDisplayedOffer,
           let current = detail,
           current.todo_id == todoID,
           let liveOffer = current.offer,
           liveOffer.offer_id == offerID,
           !offerRolePermitted(liveOffer, answer: answer, viewerUserID: viewerID) {
            // Original offer is still live on screen and the viewer lost role authority:
            // the prior attempt could not have committed, so drop the pending retry with zero sends.
            resolvePendingOffer(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID)
            actionError = TodoRules.refusalMessage("not_decider")
            return false
        }

        let sid = ObjectIdentifier(capturedSession)
        let capturedAccessGen = accessGeneration
        let dispatchFlag = TodoDispatchFlag()

        let writeGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            guard !self.isRetired, capturedSession.isActive, self.activeSessionID == sid,
                  self.accessGeneration == capturedAccessGen, self.canUpdate else { return false }
            if requireDisplayedOffer {
                guard let current = self.detail,
                      current.todo_id == todoID,
                      let offer = current.offer,
                      offer.offer_id == offerID else { return false }
                guard self.offerRolePermitted(offer, answer: answer, viewerUserID: viewerID) else { return false }
            } else if let current = self.detail,
                      current.todo_id == todoID,
                      let liveOffer = current.offer,
                      liveOffer.offer_id == offerID {
                guard self.offerRolePermitted(liveOffer, answer: answer, viewerUserID: viewerID) else {
                    self.resolvePendingOffer(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID)
                    return false
                }
            }
            guard self.markPendingOfferUnknown(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID, ownerToken: ownerToken) else {
                return false
            }
            dispatchFlag.entered = true
            return true
        }

        isMutating = true
        statusMessage = nil
        actionError = nil
        defer { isMutating = false }

        let outcome = await api.answerOffer(
            workspace: workspaceID,
            todoID: todoID,
            offerID: offerID,
            answer: answer,
            requestID: commandID,
            canDispatch: writeGate
        )
        if !dispatchFlag.entered {
            if !wasAlreadyUnknown {
                clearPreDispatchPendingOffer(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID, ownerToken: ownerToken)
            }
            if !capturedSession.isActive { clearOnAccessLoss(reason: "unauthorized", clearPending: true) }
            return false
        }
        guard !Task.isCancelled, !isRetired, capturedSession.isActive, capturedAccessGen == accessGeneration else {
            if !capturedSession.isActive { clearOnAccessLoss(reason: "unauthorized", clearPending: true) }
            return false
        }
        let msg: String
        switch answer {
        case .accept: msg = "Request accepted."
        case .decline: msg = "Request declined."
        case .withdraw: msg = "Request withdrawn."
        }
        return await handleTodoWrite(
            outcome,
            api: api,
            workspaceID: workspaceID,
            actionName: "request response",
            wasAlreadyUnknown: wasAlreadyUnknown,
            resolvePending: { self.resolvePendingOffer(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID) },
            clearOwnedPending: { self.clearOwnedPendingOffer(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID, ownerToken: ownerToken) },
            successMessage: { _ in msg }
        )
    }

    func retryPendingUpdate(api: TodoAPI, workspaceID: UUID) async -> Bool {
        guard let pending = pendingUpdate, pending.outcomeUnknown else { return false }
        let item = TodoPendingDetailRetry(
            commandID: pending.commandID,
            action: .update(todoID: pending.todoID, baseVersion: pending.version, title: pending.title, notes: pending.notes, dueOn: pending.dueOn)
        )
        return await retryPending(item, api: api, workspaceID: workspaceID)
    }

    func updateDetails(
        session editSession: TodoEditSession,
        title rawTitle: String,
        notes rawNotes: String,
        dueOn: String?,
        api: TodoAPI,
        workspaceID: UUID
    ) async -> Bool {
        guard !isRetired else { return false }
        guard bindContext(session: api.session, workspaceID: workspaceID, todoID: editSession.todoID) else { return false }
        guard !isMutating, canUpdate else { return false }
        guard activeEditSession?.id == editSession.id,
              detail?.todo_id == editSession.todoID,
              detail?.version == editSession.baseVersion else {
            let unsentTitle = TodoRules.cleanTitle(rawTitle)
            let unsentNotes = TodoRules.cleanBody(rawNotes)
            let baseTitle = TodoRules.cleanTitle(editSession.initialTitle)
            let baseNotes = TodoRules.cleanBody(editSession.initialNotes)
            let draft = TodoConflictDraft(
                baseTitle: baseTitle,
                baseNotes: baseNotes,
                baseDueOn: editSession.initialDueOn,
                editedTitle: unsentTitle,
                editedNotes: unsentNotes,
                editedDueOn: dueOn
            )
            if !draft.editedKeys.isEmpty {
                conflictDraft = draft
            }
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

        let originalBase = TodoEditBase(
            title: TodoRules.cleanTitle(editSession.initialTitle),
            notes: TodoRules.cleanBody(editSession.initialNotes),
            dueOn: editSession.initialDueOn
        )
        let attemptToken = UUID()
        guard let claimed = claimPendingUpdate(session: api.session, workspaceID: workspaceID, todoID: editSession.todoID, baseVersion: editSession.baseVersion, base: originalBase, title: title, notes: notes, dueOn: dueOn, ownerToken: attemptToken) else {
            actionError = "An earlier edit has an unknown outcome. Retry it unchanged to check before saving different changes."
            return false
        }
        return await executeUpdate(
            todoID: editSession.todoID,
            baseVersion: editSession.baseVersion,
            base: claimed.base ?? originalBase,
            title: title,
            notes: notes,
            dueOn: dueOn,
            commandID: claimed.commandID,
            ownerToken: attemptToken,
            wasAlreadyUnknown: claimed.outcomeUnknown,
            boundEditSessionID: editSession.id,
            api: api,
            workspaceID: workspaceID
        )
    }

    private func executeUpdate(
        todoID: UUID,
        baseVersion: Int,
        base: TodoEditBase?,
        title: String,
        notes: String,
        dueOn: String?,
        commandID: UUID,
        ownerToken: UUID,
        wasAlreadyUnknown: Bool,
        boundEditSessionID: UUID?,
        api: TodoAPI,
        workspaceID: UUID
    ) async -> Bool {
        guard !isRetired else { return false }
        guard bindContext(session: api.session, workspaceID: workspaceID, todoID: todoID) else { return false }
        guard !isMutating, canUpdate else { return false }
        let capturedSession = api.session
        let sid = ObjectIdentifier(capturedSession)
        let capturedAccessGen = accessGeneration
        let dispatchFlag = TodoDispatchFlag()

        let writeGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            guard !self.isRetired, capturedSession.isActive, self.activeSessionID == sid,
                  self.accessGeneration == capturedAccessGen, self.canUpdate else { return false }
            if let boundEditSessionID {
                guard self.activeEditSession?.id == boundEditSessionID,
                      self.detail?.todo_id == todoID,
                      self.detail?.version == baseVersion else { return false }
            }
            guard self.markPendingUpdateUnknown(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID, ownerToken: ownerToken) else {
                return false
            }
            dispatchFlag.entered = true
            return true
        }

        isMutating = true
        statusMessage = nil
        actionError = nil
        defer { isMutating = false }

        let outcome = await api.updateTodo(
            workspace: workspaceID,
            todoID: todoID,
            baseVersion: baseVersion,
            title: title,
            notes: notes,
            dueOn: dueOn,
            requestID: commandID,
            canDispatch: writeGate
        )
        if !dispatchFlag.entered {
            if !wasAlreadyUnknown {
                clearPreDispatchPendingUpdate(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID, ownerToken: ownerToken)
            }
            if !capturedSession.isActive { clearOnAccessLoss(reason: "unauthorized", clearPending: true) }
            return false
        }
        guard !Task.isCancelled, !isRetired, capturedSession.isActive, capturedAccessGen == accessGeneration else {
            if !capturedSession.isActive { clearOnAccessLoss(reason: "unauthorized", clearPending: true) }
            return false
        }
        if case .conflict = outcome {
            // Always use the true original base captured when Edit opened (never the refetched server `detail`).
            // If `base` is nil, `TodoConflictDraft` keeps recovery strictly manual without auto-merging.
            let draft = TodoConflictDraft(
                base: base,
                editedTitle: title,
                editedNotes: notes,
                editedDueOn: dueOn
            )
            if !draft.editedKeys.isEmpty {
                conflictDraft = draft
            }
        }
        let ok = await handleTodoWrite(
            outcome,
            api: api,
            workspaceID: workspaceID,
            actionName: "edit",
            wasAlreadyUnknown: wasAlreadyUnknown,
            resolvePending: { self.resolvePendingUpdate(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID) },
            clearOwnedPending: { self.clearOwnedPendingUpdate(session: capturedSession, workspaceID: workspaceID, todoID: todoID, commandID: commandID, ownerToken: ownerToken) },
            successMessage: { _ in "Saved." }
        )
        if ok {
            conflictDraft = nil
            activeEditSession = nil
        }
        return ok
    }

    func retryPendingComment(api: TodoAPI, workspaceID: UUID) async -> Bool {
        guard let pending = pendingComment, pending.outcomeUnknown else { return false }
        let item = TodoPendingDetailRetry(
            commandID: pending.commandID,
            action: .comment(todoID: pending.todoID, body: pending.body, mentions: pending.mentions)
        )
        return await retryPending(item, api: api, workspaceID: workspaceID)
    }

    func postComment(
        body rawBody: String,
        mentions: [TodoParty] = [],
        api: TodoAPI,
        workspaceID: UUID
    ) async -> Bool {
        guard !isRetired, let current = detail else { return false }
        guard bindContext(session: api.session, workspaceID: workspaceID, todoID: current.todo_id) else { return false }
        guard !isPostingComment, canCreateComment else { return false }
        let body = TodoRules.cleanBody(rawBody)
        guard !body.isEmpty, body.count <= TodoRules.maxCommentLength else {
            actionError = TodoRules.refusalMessage("comment_invalid")
            return false
        }
        let canonical = TodoRules.canonicalMentions(mentions)
        let capturedSession = api.session
        let sid = ObjectIdentifier(capturedSession)
        let capturedAccessGen = accessGeneration
        let attemptToken = UUID()
        guard let claimed = claimPendingComment(session: capturedSession, workspaceID: workspaceID, todoID: current.todo_id, body: body, mentions: canonical, ownerToken: attemptToken) else {
            actionError = "An earlier comment has an unknown outcome. Retry it unchanged to check first."
            return false
        }
        let commandID = claimed.commandID
        let wasAlreadyUnknown = claimed.outcomeUnknown

        let dispatchFlag = TodoDispatchFlag()
        let writeGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            guard !self.isRetired, capturedSession.isActive, self.activeSessionID == sid,
                  self.accessGeneration == capturedAccessGen, self.canCreateComment else { return false }
            guard self.markPendingCommentUnknown(session: capturedSession, workspaceID: workspaceID, todoID: current.todo_id, commandID: commandID, ownerToken: attemptToken) else {
                return false
            }
            dispatchFlag.entered = true
            return true
        }

        isPostingComment = true
        statusMessage = nil
        actionError = nil
        defer { isPostingComment = false }

        let outcome = await api.postComment(
            workspace: workspaceID,
            todoID: current.todo_id,
            body: body,
            mentions: canonical,
            requestID: commandID,
            canDispatch: writeGate
        )
        if !dispatchFlag.entered {
            if !wasAlreadyUnknown {
                clearPreDispatchPendingComment(session: capturedSession, workspaceID: workspaceID, todoID: current.todo_id, commandID: commandID, ownerToken: attemptToken)
            }
            if !capturedSession.isActive { clearOnAccessLoss(reason: "unauthorized", clearPending: true) }
            return false
        }
        guard !Task.isCancelled, !isRetired, capturedSession.isActive, capturedAccessGen == accessGeneration else {
            if !capturedSession.isActive { clearOnAccessLoss(reason: "unauthorized", clearPending: true) }
            return false
        }
        switch outcome {
        case .committed(let comment, _):
            resolvePendingComment(session: capturedSession, workspaceID: workspaceID, todoID: current.todo_id, commandID: commandID)
            if !comments.contains(where: { $0.comment_id == comment.comment_id }) {
                comments.append(comment)
            }
            if TodoRules.commentDraftMatchesConfirmed(
                draftText: commentDraftText,
                draftMentions: commentDraftMentions,
                confirmedBody: body,
                confirmedMentions: canonical
            ) {
                commentDraftText = ""
                commentDraftMentions.removeAll()
            }
            statusMessage = "Comment posted."
            return true
        case .conflict(let latest, let message):
            resolvePendingComment(session: capturedSession, workspaceID: workspaceID, todoID: current.todo_id, commandID: commandID)
            if let latest, latest.version >= (detail?.version ?? 0) {
                detail = latest.toDetail(preserving: detail)
            }
            actionError = message
            return false
        case .refused(let reason, let message):
            let keepUnknown = wasAlreadyUnknown
            let display = keepUnknown
                ? TodoRules.unknownOutcomeAfterRefusalMessage(action: "comment", refusalMessage: message)
                : message
            if !keepUnknown {
                clearOwnedPendingComment(session: capturedSession, workspaceID: workspaceID, todoID: current.todo_id, commandID: commandID, ownerToken: attemptToken)
            }
            applyRefusal(reason: reason, message: display, session: capturedSession)
            return false
        case .unconfirmed(let message):
            actionError = message
            return false
        case .cancelled:
            actionError = "Your comment outcome is unknown. Retry unchanged to check."
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
        _ outcome: TodoWriteOutcome<TodoWriteRecord>,
        api: TodoAPI,
        workspaceID: UUID,
        actionName: String,
        wasAlreadyUnknown: Bool,
        resolvePending: () -> Void,
        clearOwnedPending: () -> Void,
        successMessage: (TodoWriteRecord) -> String
    ) async -> Bool {
        switch outcome {
        case .committed(let receipt, let replayed):
            resolvePending()
            // Authoritative receipt never regresses displayed state if a replayed older receipt arrives after a newer refresh.
            let regressed: Bool
            if let existing = detail {
                if receipt.version >= existing.version {
                    detail = receipt.toDetail(preserving: existing)
                    regressed = false
                } else {
                    regressed = true
                }
            } else {
                detail = receipt.toDetail(preserving: nil)
                regressed = false
            }
            statusMessage = regressed ? "Earlier \(actionName) was already applied." : successMessage(receipt)
            // Refresh derived read fields (gate_clear, queue_position) via a follow-up read when not a stale replay.
            if !regressed && (!replayed || (detail?.version ?? 0) <= receipt.version) {
                await load(api: api, workspaceID: workspaceID, todoID: receipt.todo_id, preserveNotice: true)
            }
            return true
        case .conflict(let latest, let message):
            activeEditSession = nil
            activeAssignSession = nil
            resolvePending()
            if let latest, latest.version >= (detail?.version ?? 0) {
                detail = latest.toDetail(preserving: detail)
            }
            actionError = message
            if let targetID = latest?.todo_id ?? detail?.todo_id {
                await load(api: api, workspaceID: workspaceID, todoID: targetID, preserveNotice: true)
            }
            return false
        case .refused(let reason, let message):
            // Conservative default: any refusal on an already-unknown write preserves command identity until receipt lookup confirms.
            let keepUnknown = wasAlreadyUnknown
            let display = keepUnknown
                ? TodoRules.unknownOutcomeAfterRefusalMessage(action: actionName, refusalMessage: message)
                : message
            if !keepUnknown { clearOwnedPending() }
            applyRefusal(reason: reason, message: display, session: api.session)
            return false
        case .unconfirmed(let message):
            actionError = message
            return false
        case .cancelled:
            actionError = "Your \(actionName) outcome is unknown. Retry unchanged to check."
            return false
        }
    }

    private func applyRefusal(reason: String, message: String, session: HumanSession) {
        if TodoRules.isAccessLossReason(reason) || reason == "todo_not_found" {
            clearOnAccessLoss(reason: reason, clearPending: !session.isActive)
        } else if reason == "content_read_only" {
            accessGeneration += 1
            let wasAdmin = access?.isWorkspaceAdmin ?? false
            access = TodoAccess(canRead: true, canCreate: false, canUpdate: false, isWorkspaceAdmin: wasAdmin)
            closeWriteSurfaces()
        }
        actionError = message
    }

    private func closeWriteSurfaces() {
        activeEditSession = nil
        activeAssignSession = nil
        showingMentionPicker = false
    }

    private func clearOnAccessLoss(reason: String, clearPending: Bool) {
        loadGeneration += 1
        accessGeneration += 1
        isLoading = false
        detail = nil
        comments = []
        nextCommentOffset = nil
        access = nil
        closeWriteSurfaces()
        conflictDraft = nil
        failure = reason == "todo_not_found" ? .notFound : .refused(reason)
        if clearPending {
            if let sid = activeSessionID {
                TodoPendingWriteStore.shared.clearSession(sid)
            }
            pendingState = nil
            pendingAssign = nil
            pendingOffer = nil
            pendingUpdate = nil
            pendingComment = nil
            commentDraftText = ""
            commentDraftMentions.removeAll()
        }
    }
}
