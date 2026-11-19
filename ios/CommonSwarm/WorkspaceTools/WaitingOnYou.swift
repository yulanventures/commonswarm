import Combine
import Foundation

enum WaitingScope: String, CaseIterable, Identifiable, Sendable {
    case channel
    case workspace
    case all

    var id: String { rawValue }

    var title: String {
        switch self {
        case .channel: "This channel"
        case .workspace: "All channels"
        case .all: "All workspaces"
        }
    }
}

enum WaitingPartnerKind: String, Hashable, Sendable {
    case person
    case agent
}

enum WaitingConversation: Hashable, Sendable {
    case channel(UUID)
    case general
    case dm(WaitingPartnerKind, UUID)
    case group(UUID)
    case unknown
}

struct WaitingSignalPlacement: Decodable, Hashable, Sendable {
    let id: UUID
    let channel_id: UUID?
    let to: UUID?
    let to_agent: UUID?
    let thread_root_id: UUID?
    let from: UUID
    let from_kind: String
}

struct WaitingPlace: Hashable, Sendable {
    let workspaceID: UUID
    let workspaceName: String
    let conversation: WaitingConversation
    let label: String

    init(
        workspace: Workspace,
        conversation: Conversation,
        viewerID: UUID? = nil,
        directory: [Conversation] = [],
        channelID: UUID? = nil
    ) {
        self.workspaceID = workspace.id
        self.workspaceName = workspace.name
        self.label = conversation.name
        switch conversation.destination {
        case .general:
            self.conversation = .general
        case .channel(let id, _):
            self.conversation = .channel(id)
        case .person(let id):
            self.conversation = .dm(.person, id)
        case .agent(let id):
            self.conversation = .dm(.agent, id)
        case .thread(let threadID, let kind):
            switch kind {
            case .general:
                self.conversation = .general
            case .publicChannel, .privateChannel:
                if let channelID {
                    self.conversation = .channel(channelID)
                } else {
                    self.conversation = .unknown
                }
            case .dm:
                let other = directory.first {
                    switch $0.destination {
                    case .person(let id): return id != viewerID
                    case .agent: return true
                    default: return false
                    }
                }
                switch other?.destination {
                case .person(let id):
                    self.conversation = .dm(.person, id)
                case .agent(let id):
                    self.conversation = .dm(.agent, id)
                default:
                    self.conversation = .unknown
                }
            case .group:
                self.conversation = .group(threadID)
            }
        }
    }

    init(workspaceID: UUID, workspaceName: String, conversation: WaitingConversation, label: String) {
        self.workspaceID = workspaceID
        self.workspaceName = workspaceName
        self.conversation = conversation
        self.label = label
    }
}

struct WaitingChoiceOption: Decodable, Hashable, Identifiable, Sendable {
    let id: String
    let label: String
    let description: String?
    let recommended: Bool?

    var isRecommended: Bool { recommended == true }
}

struct WaitingChoiceAnswer: Decodable, Hashable, Sendable {
    let option_id: String
    let option_ids: [String]?
    let other_text: String?
    let by_viewer: Bool
    let actor_user_id: UUID?
    let at: String?
}

struct WaitingAskChoiceState: Decodable, Hashable, Sendable {
    let signal_id: UUID
    let multi: Bool?
    let options: [WaitingChoiceOption]
    let answer: WaitingChoiceAnswer?

    var isMulti: Bool { multi == true }
}

struct WaitingChoiceDraft: Hashable, Sendable {
    var selected: [String] = []
    var otherText: String = ""
}

struct WaitingChoiceSubmission: Hashable, Sendable {
    let optionIds: [String]
    let otherText: String?
}

struct WaitingAskItem: Hashable, Identifiable, Sendable {
    let id: UUID
    let workspaceID: UUID
    let workspaceName: String
    let conversation: WaitingConversation
    let channelLabel: String
    let fromKind: WaitingPartnerKind
    let fromID: UUID
    let fromName: String
    let body: String
    let createdAt: String
    let until: String
    let multi: Bool
    let options: [WaitingChoiceOption]

    var orderedOptions: [WaitingChoiceOption] {
        WaitingChoiceRules.orderedOptions(options)
    }

    var prompt: WaitingPromptSplit {
        WaitingChoiceRules.splitPrompt(body)
    }

    func locationText(for scope: WaitingScope) -> String? {
        switch scope {
        case .channel:
            return nil
        case .workspace:
            return channelLabel.isEmpty ? nil : channelLabel
        case .all:
            return channelLabel.isEmpty ? workspaceName : "\(workspaceName) · \(channelLabel)"
        }
    }
}

struct WaitingScopeCount: Equatable, Sendable {
    let min: Int
    let complete: Bool

    var badgeText: String {
        if min > 99 { return "99+" }
        if complete { return String(min) }
        return min > 0 ? "\(min)+" : ""
    }

    func optionTitle(_ base: String) -> String {
        let num = badgeText
        return num.isEmpty ? base : "\(base) (\(num))"
    }
}

struct WaitingPanelCounts: Equatable, Sendable {
    let channel: WaitingScopeCount
    let workspace: WaitingScopeCount
    let all: WaitingScopeCount
}

struct WaitingPromptSplit: Equatable, Sendable {
    let prose: String?
    let question: String?
}

struct WaitingWorkspaceLoad: Sendable {
    let workspaceID: UUID
    let items: [WaitingAskItem]
    let todos: [WaitingTodoItem]
    let complete: Bool
    let failed: Bool
}

enum WaitingTodoReason: String, Decodable, Hashable, Sendable {
    case assigned
    case request
    case after
    case hold
    case agentRemoved = "agent_removed"

    var label: String {
        switch self {
        case .request: "To-do · Waiting for your answer"
        case .hold: "To-do · On hold"
        case .after: "To-do · Waiting"
        case .agentRemoved: "To-do · Agent removed"
        case .assigned: "To-do · Assigned to you"
        }
    }
}

enum WaitingTodoPlacement: String, Decodable, Hashable, Sendable {
    case channel
    case general
    case workspace
}

struct WaitingTodoItem: Hashable, Identifiable, Sendable {
    let id: UUID
    let workspaceID: UUID
    let workspaceName: String
    let title: String
    let state: String
    let dueOn: String?
    let reason: WaitingTodoReason
    let agentID: UUID?
    let stateAt: String
    let placement: WaitingTodoPlacement
    let channelID: UUID?
    let channelLabel: String

    var canMarkDone: Bool { reason == .assigned }

    var formattedDue: String? {
        WaitingChoiceRules.formatLocalDueDate(dueOn)
    }

    func locationText(for scope: WaitingScope) -> String? {
        switch scope {
        case .channel:
            return nil
        case .workspace:
            return channelLabel.isEmpty ? nil : channelLabel
        case .all:
            return channelLabel.isEmpty ? workspaceName : "\(workspaceName) · \(channelLabel)"
        }
    }
}

struct WaitingTodoFailure: Equatable, Sendable {
    let message: String
    let retryable: Bool
}

struct WaitingTodoComment: Hashable, Identifiable, Sendable {
    let id: UUID
    let authorName: String
    let authorIsAgent: Bool
    let body: String
    let createdAt: String
}

struct WaitingTodoDetail: Hashable, Sendable {
    let id: UUID
    let workspaceID: UUID
    let title: String
    let state: String
    let version: Int
    let notes: String?
    let dueOn: String?
    let assigneeName: String
    let assigneeIsAgent: Bool
    let comments: [WaitingTodoComment]
    let nextCommentOffset: Int?

    var formattedDue: String? {
        WaitingChoiceRules.formatLocalDueDate(dueOn)
    }

    func withState(_ newState: String) -> WaitingTodoDetail {
        WaitingTodoDetail(
            id: id,
            workspaceID: workspaceID,
            title: title,
            state: newState,
            version: version,
            notes: notes,
            dueOn: dueOn,
            assigneeName: assigneeName,
            assigneeIsAgent: assigneeIsAgent,
            comments: comments,
            nextCommentOffset: nextCommentOffset
        )
    }

    func appendingComments(_ more: [WaitingTodoComment], nextOffset: Int?) -> WaitingTodoDetail {
        var merged = comments
        let existing = Set(comments.map(\.id))
        for comment in more where !existing.contains(comment.id) {
            merged.append(comment)
        }
        return WaitingTodoDetail(
            id: id,
            workspaceID: workspaceID,
            title: title,
            state: state,
            version: version,
            notes: notes,
            dueOn: dueOn,
            assigneeName: assigneeName,
            assigneeIsAgent: assigneeIsAgent,
            comments: merged,
            nextCommentOffset: nextOffset
        )
    }
}

enum WaitingBannerKind: Equatable, Sendable {
    case sent
    case done
    case dropped
}

struct WaitingStatusBanner: Equatable, Sendable {
    let kind: WaitingBannerKind
    let text: String

    var accessibilityLabel: String {
        switch kind {
        case .sent: return text == "Sent" ? "Answer sent" : text
        case .done: return "To-do marked done"
        case .dropped: return text
        }
    }
}

enum WaitingChoiceRules {
    static let otherTextMax = 500
    static let choiceTitleMax = 240
    static let answerUnsupportedMessage = "This kind of answer can't be sent here yet. Pick one of the options instead."
    static let answerFailedMessage = "That answer couldn't be sent. Try again."

    /// Mirrors classifyAskConversation in site/src/lib/waiting-count.ts.
    static func classifyConversation(
        _ loc: WaitingSignalPlacement?,
        root: WaitingSignalPlacement? = nil
    ) -> WaitingConversation {
        guard let loc else { return .unknown }
        if let channelID = loc.channel_id { return .channel(channelID) }
        let dmFrom: () -> WaitingConversation = {
            let kind: WaitingPartnerKind = loc.from_kind == "agent" ? .agent : .person
            return .dm(kind, loc.from)
        }
        if loc.thread_root_id != nil {
            guard let root else { return .unknown }
            if let rootChannel = root.channel_id { return .channel(rootChannel) }
            if root.to == nil && root.to_agent == nil { return .general }
            return dmFrom()
        }
        if loc.to == nil && loc.to_agent == nil { return .general }
        return dmFrom()
    }

    /// Recommended option first (at most one), preserving original order for the rest.
    static func orderedOptions(_ options: [WaitingChoiceOption]) -> [WaitingChoiceOption] {
        var recommended: [WaitingChoiceOption] = []
        var rest: [WaitingChoiceOption] = []
        var seenRecommended = false
        for option in options {
            if option.isRecommended && !seenRecommended {
                recommended.append(option)
                seenRecommended = true
            } else {
                rest.append(option)
            }
        }
        return recommended + rest
    }

    /// Mirrors cleanOtherText in site/src/lib/choices.ts.
    static func cleanOtherText(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= otherTextMax else { return nil }
        for scalar in trimmed.unicodeScalars {
            if scalar.value <= 0x1F || scalar.value == 0x7F {
                return nil
            }
        }
        return trimmed
    }

    /// Mirrors splitChoicePrompt in site/src/lib/choices.ts.
    static func splitPrompt(_ body: String) -> WaitingPromptSplit {
        let normalized = body
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false)
        var startIndex = 0
        while startIndex < lines.count && lines[startIndex].trimmingCharacters(in: .whitespaces).isEmpty {
            startIndex += 1
        }
        let text = lines[startIndex...].joined(separator: "\n").replacingOccurrences(of: #"[ \t\n]+$"#, with: "", options: .regularExpression)
        let whole = WaitingPromptSplit(prose: text, question: nil)
        if text.contains("```") || text.contains("~~~") { return whole }

        let isPlainBlock: (String) -> Bool = { block in
            guard block.count <= choiceTitleMax else { return false }
            for line in block.split(separator: "\n", omittingEmptySubsequences: false) {
                let stripped = line.drop(while: { $0 == " " || $0 == "\t" })
                if let first = stripped.first, ["-", "*", "+", ">", "|", "#"].contains(first) {
                    return false
                }
                if stripped.range(of: #"^\d+\."#, options: .regularExpression) != nil {
                    return false
                }
            }
            return true
        }

        let regex = try? NSRegularExpression(pattern: #"\n[ \t]*\n"#)
        let nsRange = NSRange(text.startIndex..<text.endIndex, in: text)
        let matches = regex?.matches(in: text, range: nsRange) ?? []
        guard let lastMatch = matches.last, let sepRange = Range(lastMatch.range, in: text) else {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return isPlainBlock(trimmed) ? WaitingPromptSplit(prose: nil, question: trimmed) : whole
        }
        let prose = String(text[..<sepRange.lowerBound]).replacingOccurrences(of: #"[ \t\n]+$"#, with: "", options: .regularExpression)
        if prose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return isPlainBlock(trimmed) ? WaitingPromptSplit(prose: nil, question: trimmed) : whole
        }
        let last = String(text[sepRange.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !last.isEmpty, isPlainBlock(last), !last.contains("\n"), last.hasSuffix("?") else {
            return whole
        }
        return WaitingPromptSplit(prose: prose, question: last)
    }

    static func filterItems(
        _ items: [WaitingAskItem],
        scope: WaitingScope,
        place: WaitingPlace
    ) -> [WaitingAskItem] {
        switch scope {
        case .all:
            return items
        case .workspace:
            return items.filter { $0.workspaceID == place.workspaceID }
        case .channel:
            guard place.conversation != .unknown else { return [] }
            return items.filter {
                $0.workspaceID == place.workspaceID
                    && $0.conversation != .unknown
                    && $0.conversation == place.conversation
            }
        }
    }

    /// Mirrors filterWaitingTodos in site/src/lib/waiting-panel.ts.
    /// Channel-origin and #general-origin to-dos appear in their authoritative channel's This channel queue;
    /// workspace-only to-dos stay in All channels and All workspaces so they never clutter a channel or DM.
    static func filterTodos(
        _ todos: [WaitingTodoItem],
        scope: WaitingScope,
        place: WaitingPlace
    ) -> [WaitingTodoItem] {
        switch scope {
        case .all:
            return todos
        case .workspace:
            return todos.filter { $0.workspaceID == place.workspaceID }
        case .channel:
            return todos.filter { todo in
                guard todo.workspaceID == place.workspaceID else { return false }
                switch place.conversation {
                case .channel(let channelID):
                    return todo.placement == .channel && todo.channelID == channelID
                case .general:
                    return todo.placement == .general
                case .dm, .group, .unknown:
                    return false
                }
            }
        }
    }

    static func formatLocalDueDate(_ dueOn: String?) -> String? {
        guard let dueOn, !dueOn.isEmpty else { return nil }
        let parts = dueOn.split(separator: "-")
        guard parts.count == 3,
              let month = Int(parts[1]),
              let day = Int(parts[2]),
              (1...12).contains(month),
              (1...31).contains(day) else {
            return "Due \(dueOn)"
        }
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return "Due \(months[month - 1]) \(day)"
    }

    static func formatRelativeTime(_ iso: String) -> String {
        let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(iso))
            ?? (try? Date.ISO8601FormatStyle().parse(iso))
        guard let date else { return "" }
        return date.formatted(.dateTime.month().day().hour().minute())
    }
}

struct WaitingCardFailure: Equatable, Sendable {
    let commandID: UUID
    let submission: WaitingChoiceSubmission
    let message: String
    let retryable: Bool
}

@MainActor
final class WaitingOnYouStore: ObservableObject {
    @Published var scope: WaitingScope = .channel
    @Published private(set) var items: [WaitingAskItem] = []
    @Published private(set) var todos: [WaitingTodoItem] = []
    @Published private(set) var workspaceComplete: [UUID: Bool] = [:]
    @Published private(set) var workspaceFailed: [UUID: Bool] = [:]
    @Published private(set) var allWorkspacesEnumerated = false
    @Published private(set) var hasLoadedOnce = false
    @Published private(set) var isLoading = false
    @Published private(set) var loadFailed = false
    @Published private(set) var pendingBySignal: Set<UUID> = []
    @Published private(set) var failuresBySignal: [UUID: WaitingCardFailure] = [:]
    @Published var draftsBySignal: [UUID: WaitingChoiceDraft] = [:]
    @Published private(set) var pendingByTodo: Set<UUID> = []
    @Published private(set) var failuresByTodo: [UUID: WaitingTodoFailure] = [:]
    @Published private(set) var statusBanner: WaitingStatusBanner?

    var sentBanner: String? { statusBanner?.text }

    let place: WaitingPlace
    private weak var session: HumanSession?
    private var bannerTask: Task<Void, Never>?

    init(place: WaitingPlace, session: HumanSession? = nil) {
        self.place = place
        self.session = session
    }

    var visibleItems: [WaitingAskItem] {
        WaitingChoiceRules.filterItems(items, scope: scope, place: place)
    }

    var visibleTodos: [WaitingTodoItem] {
        WaitingChoiceRules.filterTodos(todos, scope: scope, place: place)
    }

    var scopeComplete: Bool {
        switch scope {
        case .channel, .workspace:
            return workspaceComplete[place.workspaceID] ?? false
        case .all:
            return allWorkspacesEnumerated && !workspaceComplete.isEmpty && workspaceComplete.values.allSatisfy { $0 }
        }
    }

    var scopeFailed: Bool {
        switch scope {
        case .channel, .workspace:
            return workspaceFailed[place.workspaceID] ?? false
        case .all:
            return (hasLoadedOnce && !allWorkspacesEnumerated) || workspaceFailed.values.contains(true)
        }
    }

    var counts: WaitingPanelCounts {
        let channelItems = WaitingChoiceRules.filterItems(items, scope: .channel, place: place)
        let workspaceItems = WaitingChoiceRules.filterItems(items, scope: .workspace, place: place)
        let channelTodos = WaitingChoiceRules.filterTodos(todos, scope: .channel, place: place)
        let workspaceTodos = WaitingChoiceRules.filterTodos(todos, scope: .workspace, place: place)
        let currentComplete = workspaceComplete[place.workspaceID] ?? false
        let everyComplete = allWorkspacesEnumerated && !workspaceComplete.isEmpty && workspaceComplete.values.allSatisfy { $0 }
        return WaitingPanelCounts(
            channel: WaitingScopeCount(min: channelItems.count + channelTodos.count, complete: currentComplete),
            workspace: WaitingScopeCount(min: workspaceItems.count + workspaceTodos.count, complete: currentComplete),
            all: WaitingScopeCount(min: items.count + todos.count, complete: everyComplete)
        )
    }

    func draft(for signalID: UUID) -> WaitingChoiceDraft {
        draftsBySignal[signalID] ?? WaitingChoiceDraft()
    }

    func persistDraft(_ draft: WaitingChoiceDraft?, workspaceID: UUID, signalID: UUID) {
        draftsBySignal[signalID] = draft
        WaitingSessionDraftMemory.shared.setDraft(draft, workspaceID: workspaceID, signalID: signalID, session: session)
    }

    func persistFailure(_ failure: WaitingCardFailure?, workspaceID: UUID, signalID: UUID) {
        failuresBySignal[signalID] = failure
        WaitingSessionDraftMemory.shared.setFailure(failure, workspaceID: workspaceID, signalID: signalID, session: session)
    }

    func toggleOption(_ optionID: String, for item: WaitingAskItem) {
        var current = draft(for: item.id)
        if let idx = current.selected.firstIndex(of: optionID) {
            current.selected.remove(at: idx)
        } else {
            current.selected.append(optionID)
        }
        persistDraft(current, workspaceID: item.workspaceID, signalID: item.id)
        persistFailure(nil, workspaceID: item.workspaceID, signalID: item.id)
    }

    func updateOtherText(_ text: String, for signalID: UUID) {
        var current = draft(for: signalID)
        current.otherText = text
        let wsID = items.first(where: { $0.id == signalID })?.workspaceID ?? place.workspaceID
        persistDraft(current, workspaceID: wsID, signalID: signalID)
        persistFailure(nil, workspaceID: wsID, signalID: signalID)
    }

    func load(api: WaitingOnYouAPI) async {
        isLoading = true
        loadFailed = false
        if session == nil {
            session = api.api.session
        }
        let result = await api.loadAll(currentWorkspaceID: place.workspaceID, currentWorkspaceName: place.workspaceName)
        guard !Task.isCancelled else { return }
        allWorkspacesEnumerated = result.enumeratedAllWorkspaces
        workspaceComplete = result.workspaceComplete
        workspaceFailed = result.workspaceFailed
        items = result.items
        todos = result.todos
        hydrateSessionDrafts(for: result.items)
        hasLoadedOnce = true
        loadFailed = (!result.enumeratedAllWorkspaces || result.workspaceFailed.values.contains(true)) && result.items.isEmpty && result.todos.isEmpty
        isLoading = false
    }

    private func hydrateSessionDrafts(for loadedItems: [WaitingAskItem]) {
        guard let session else { return }
        var restoredDrafts = draftsBySignal
        var restoredFailures = failuresBySignal
        for item in loadedItems {
            if let savedDraft = WaitingSessionDraftMemory.shared.draft(workspaceID: item.workspaceID, signalID: item.id, session: session) {
                restoredDrafts[item.id] = savedDraft
            }
            if let savedFailure = WaitingSessionDraftMemory.shared.failure(workspaceID: item.workspaceID, signalID: item.id, session: session) {
                restoredFailures[item.id] = savedFailure
            }
        }
        draftsBySignal = restoredDrafts
        failuresBySignal = restoredFailures
    }

    func submitSingleOption(_ optionID: String, for item: WaitingAskItem, api: WaitingOnYouAPI) async {
        await submit(WaitingChoiceSubmission(optionIds: [optionID], otherText: nil), for: item, api: api, commandID: UUID())
    }

    func submitDraft(for item: WaitingAskItem, api: WaitingOnYouAPI) async {
        let current = draft(for: item.id)
        let known = Set(item.options.map(\.id))
        let optionIds = item.multi ? current.selected.filter { known.contains($0) } : []
        let other = WaitingChoiceRules.cleanOtherText(current.otherText)
        guard !optionIds.isEmpty || other != nil else { return }
        await submit(WaitingChoiceSubmission(optionIds: optionIds, otherText: other), for: item, api: api, commandID: UUID())
    }

    func retry(for item: WaitingAskItem, api: WaitingOnYouAPI) async {
        guard let failure = failuresBySignal[item.id] else { return }
        await submit(failure.submission, for: item, api: api, commandID: failure.commandID)
    }

    func markTodoDone(_ item: WaitingTodoItem, api: WaitingOnYouAPI) async {
        guard item.canMarkDone, !pendingByTodo.contains(item.id) else { return }
        pendingByTodo.insert(item.id)
        failuresByTodo[item.id] = nil

        let outcome = await api.markTodoDone(workspaceID: item.workspaceID, todoID: item.id)
        pendingByTodo.remove(item.id)

        switch outcome {
        case .done:
            todos.removeAll { $0.id == item.id }
            failuresByTodo[item.id] = nil
            showStatusBanner(.done, "Done")
        case .dropped:
            todos.removeAll { $0.id == item.id }
            failuresByTodo[item.id] = nil
            showStatusBanner(.dropped, "This to-do was dropped.")
        case .failed(let message, let retryable):
            failuresByTodo[item.id] = WaitingTodoFailure(message: message, retryable: retryable)
        }
    }

    func removeCompletedTodo(_ todoID: UUID) {
        todos.removeAll { $0.id == todoID }
        failuresByTodo[todoID] = nil
        showStatusBanner(.done, "Done")
    }

    func removeDroppedTodo(_ todoID: UUID, announce: Bool = true) {
        todos.removeAll { $0.id == todoID }
        failuresByTodo[todoID] = nil
        if announce {
            showStatusBanner(.dropped, "This to-do was dropped.")
        }
    }

    @discardableResult
    func submitChoice(
        _ submission: WaitingChoiceSubmission,
        for item: WaitingAskItem,
        api: WaitingOnYouAPI,
        commandID: UUID,
        announceBanner: Bool = true
    ) async -> Bool {
        guard !pendingBySignal.contains(item.id) else { return false }
        pendingBySignal.insert(item.id)
        failuresBySignal[item.id] = nil

        let outcome = await api.answerChoice(
            commandID: commandID,
            workspaceID: item.workspaceID,
            signalID: item.id,
            multi: item.multi,
            submission: submission
        )
        pendingBySignal.remove(item.id)

        switch outcome {
        case .accepted:
            items.removeAll { $0.id == item.id }
            persistDraft(nil, workspaceID: item.workspaceID, signalID: item.id)
            persistFailure(nil, workspaceID: item.workspaceID, signalID: item.id)
            if announceBanner {
                showStatusBanner(.sent, "Sent")
            }
            return true
        case .failed(let message, let retryable):
            persistFailure(
                WaitingCardFailure(
                    commandID: commandID,
                    submission: submission,
                    message: message,
                    retryable: retryable
                ),
                workspaceID: item.workspaceID,
                signalID: item.id
            )
            return false
        }
    }

    private func submit(
        _ submission: WaitingChoiceSubmission,
        for item: WaitingAskItem,
        api: WaitingOnYouAPI,
        commandID: UUID
    ) async {
        await submitChoice(submission, for: item, api: api, commandID: commandID, announceBanner: true)
    }

    func clearFailure(for signalID: UUID) {
        let wsID = items.first(where: { $0.id == signalID })?.workspaceID ?? place.workspaceID
        persistFailure(nil, workspaceID: wsID, signalID: signalID)
    }

    func showStatusBanner(_ kind: WaitingBannerKind, _ text: String) {
        statusBanner = WaitingStatusBanner(kind: kind, text: text)
        bannerTask?.cancel()
        bannerTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            self?.statusBanner = nil
        }
    }
}
