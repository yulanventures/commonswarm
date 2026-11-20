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
    let complete: Bool
    let failed: Bool
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
    @Published private(set) var workspaceComplete: [UUID: Bool] = [:]
    @Published private(set) var workspaceFailed: [UUID: Bool] = [:]
    @Published private(set) var allWorkspacesEnumerated = false
    @Published private(set) var hasLoadedOnce = false
    @Published private(set) var isLoading = false
    @Published private(set) var loadFailed = false
    @Published private(set) var pendingBySignal: Set<UUID> = []
    @Published private(set) var failuresBySignal: [UUID: WaitingCardFailure] = [:]
    @Published var draftsBySignal: [UUID: WaitingChoiceDraft] = [:]
    @Published private(set) var sentBanner: String?

    let place: WaitingPlace
    private var bannerTask: Task<Void, Never>?

    init(place: WaitingPlace) {
        self.place = place
    }

    var visibleItems: [WaitingAskItem] {
        WaitingChoiceRules.filterItems(items, scope: scope, place: place)
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
        let currentComplete = workspaceComplete[place.workspaceID] ?? false
        let everyComplete = allWorkspacesEnumerated && !workspaceComplete.isEmpty && workspaceComplete.values.allSatisfy { $0 }
        return WaitingPanelCounts(
            channel: WaitingScopeCount(min: channelItems.count, complete: currentComplete),
            workspace: WaitingScopeCount(min: workspaceItems.count, complete: currentComplete),
            all: WaitingScopeCount(min: items.count, complete: everyComplete)
        )
    }

    func draft(for signalID: UUID) -> WaitingChoiceDraft {
        draftsBySignal[signalID] ?? WaitingChoiceDraft()
    }

    func toggleOption(_ optionID: String, for item: WaitingAskItem) {
        var current = draft(for: item.id)
        if let idx = current.selected.firstIndex(of: optionID) {
            current.selected.remove(at: idx)
        } else {
            current.selected.append(optionID)
        }
        draftsBySignal[item.id] = current
        failuresBySignal[item.id] = nil
    }

    func updateOtherText(_ text: String, for signalID: UUID) {
        var current = draft(for: signalID)
        current.otherText = text
        draftsBySignal[signalID] = current
        failuresBySignal[signalID] = nil
    }

    func load(api: WaitingOnYouAPI) async {
        isLoading = true
        loadFailed = false
        let result = await api.loadAll(currentWorkspaceID: place.workspaceID, currentWorkspaceName: place.workspaceName)
        guard !Task.isCancelled else { return }
        allWorkspacesEnumerated = result.enumeratedAllWorkspaces
        workspaceComplete = result.workspaceComplete
        workspaceFailed = result.workspaceFailed
        items = result.items
        hasLoadedOnce = true
        loadFailed = (!result.enumeratedAllWorkspaces || result.workspaceFailed.values.contains(true)) && result.items.isEmpty
        isLoading = false
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

    private func submit(
        _ submission: WaitingChoiceSubmission,
        for item: WaitingAskItem,
        api: WaitingOnYouAPI,
        commandID: UUID
    ) async {
        guard !pendingBySignal.contains(item.id) else { return }
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
            draftsBySignal[item.id] = nil
            failuresBySignal[item.id] = nil
            showSentBanner()
        case .failed(let message, let retryable):
            failuresBySignal[item.id] = WaitingCardFailure(
                commandID: commandID,
                submission: submission,
                message: message,
                retryable: retryable
            )
        }
    }

    private func showSentBanner() {
        sentBanner = "Sent"
        bannerTask?.cancel()
        bannerTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.sentBanner = nil
        }
    }
}
