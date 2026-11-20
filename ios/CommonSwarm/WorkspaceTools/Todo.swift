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

struct TodoActor: Codable, Hashable, Sendable {
    let user_id: UUID
    let principal_id: UUID?
}

struct TodoOfferSummary: Decodable, Hashable, Sendable {
    let offer_id: UUID
    let to: TodoParty
    let decider_user_id: UUID
    let start: String
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

struct TodoDirectory: Hashable, Sendable {
    let viewerUserID: UUID
    let people: [UUID: String]
    let agents: [UUID: String]

    static func empty(viewerUserID: UUID) -> TodoDirectory {
        TodoDirectory(viewerUserID: viewerUserID, people: [:], agents: [:])
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
        return assigneeLabel(TodoParty(kind: .user, id: actor.user_id))
    }
}

enum TodoCalendarDate {
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
            case "workspace_access_refused", "content_consent_required", "connection_access_refused":
                return "You don’t have access to to-dos in this workspace."
            case "todo_not_found":
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

    func load(api: TodoAPI, workspaceID: UUID) async {
        isLoading = true
        failure = nil
        let requestedScope = filter
        do {
            async let pageTask = api.listTodos(workspace: workspaceID, scope: requestedScope)
            async let directoryTask = api.directory(workspace: workspaceID)
            let page = try await pageTask
            let resolvedDirectory = (try? await directoryTask) ?? directory
            try Task.checkCancellation()
            guard filter == requestedScope else { return }
            todos = page.todos
            directory = resolvedDirectory
            isLoading = false
        } catch TodoAPIError.refused(let reason) {
            if !Task.isCancelled && filter == requestedScope {
                failure = .refused(reason)
                isLoading = false
            }
        } catch {
            if !Task.isCancelled && filter == requestedScope {
                failure = .failed
                isLoading = false
            }
        }
    }
}

@MainActor
final class TodoDetailViewModel: ObservableObject {
    @Published private(set) var detail: TodoDetail?
    @Published private(set) var comments: [TodoComment] = []
    @Published private(set) var isLoading = false
    @Published private(set) var failure: TodoLoadFailure?

    func load(api: TodoAPI, workspaceID: UUID, todoID: UUID) async {
        isLoading = true
        failure = nil
        do {
            let response = try await api.readTodo(workspace: workspaceID, todoID: todoID)
            try Task.checkCancellation()
            detail = response.todo
            comments = response.comments
            isLoading = false
        } catch TodoAPIError.refused(let reason) {
            if !Task.isCancelled {
                failure = reason == "todo_not_found" ? .notFound : .refused(reason)
                isLoading = false
            }
        } catch {
            if !Task.isCancelled {
                failure = .failed
                isLoading = false
            }
        }
    }
}
