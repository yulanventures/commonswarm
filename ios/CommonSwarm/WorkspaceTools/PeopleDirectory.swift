import Combine
import Foundation

enum PeopleDirectoryTab: String, CaseIterable, Identifiable, Sendable {
    case people
    case agents
    case invites
    case admins

    static let defaultTab: PeopleDirectoryTab = .agents

    var id: String { rawValue }

    var label: String {
        switch self {
        case .people: "People"
        case .agents: "Agents"
        case .invites: "Invites"
        case .admins: "Admins"
        }
    }

    var searchPlaceholder: String {
        switch self {
        case .people: "Find a person"
        case .agents: "Find an agent"
        case .invites: "Find an invite"
        case .admins: "Find an admin"
        }
    }
}

enum WorkspaceMemberRole: String, Codable, Hashable, Sendable {
    case owner
    case admin
    case member

    var label: String {
        switch self {
        case .owner: "Owner"
        case .admin: "Admin"
        case .member: "Member"
        }
    }

    var isManager: Bool {
        self == .owner || self == .admin
    }

    var sortOrder: Int {
        switch self {
        case .owner: 0
        case .admin: 1
        case .member: 2
        }
    }
}

struct WorkspacePerson: Hashable, Identifiable, Sendable {
    let userID: UUID
    let name: String
    let role: WorkspaceMemberRole
    let isViewer: Bool

    var id: UUID { userID }
}

enum SeatIndicator: String, Equatable, Hashable, Sendable {
    case dot
    case ring
    case diamond

    var symbolName: String {
        switch self {
        case .dot: "circle.fill"
        case .ring: "circle"
        case .diamond: "diamond.fill"
        }
    }
}

enum SeatStatusKind: String, Equatable, Hashable, Sendable {
    case removed
    case connectionOff = "connection_off"
    case keyOff = "key_off"
    case keyEnded = "key_ended"
    case paused
    case waiting
    case working
    case turnOnly = "turn_only"
    case listening
    case notListening = "not_listening"
    case unknown
}

struct SeatWakeTimestamps: Equatable, Hashable, Sendable {
    let watcherAt: Date?
    let channelAt: Date?
    let listenerAt: Date?
    let turnAt: Date?

    var isEmpty: Bool {
        watcherAt == nil && channelAt == nil && listenerAt == nil && turnAt == nil
    }
}

struct SeatStatus: Equatable, Hashable, Sendable {
    let kind: SeatStatusKind
    let line: String
    let indicator: SeatIndicator
    let attention: Bool
    let staleWaiting: Bool
    let wakeKind: String
    let since: Date?
    let ageSeconds: TimeInterval?
    let lastActivityAt: Date?
    let unseenCount: Int
}

/// Swift parity port of `src/protocol/seat-status.ts` (`classifySeatStatus`).
/// Truth rules:
/// - Always show age or clock time when a timestamp exists.
/// - Never fake a live dot: `.dot` ONLY when a live push listener lease is verified (<= 3 min).
/// - People & agents never renders private work titles in seat status lines.
enum SeatStatusClassifier {
    static let workRecentInterval: TimeInterval = 30 * 60
    static let waitingStaleInterval: TimeInterval = 3 * 60
    static let wakeLeaseStaleInterval: TimeInterval = 3 * 60

    static func formatElapsed(_ seconds: TimeInterval) -> String {
        let clamped = max(0, seconds)
        let minutes = Int(floor(clamped / 60))
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) h" }
        return "\(hours / 24) d"
    }

    static func formatAgo(_ seconds: TimeInterval) -> String {
        let clamped = max(0, seconds)
        let minutes = Int(floor(clamped / 60))
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes) min ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) h ago" }
        return "\(hours / 24) d ago"
    }

    static func formatClock(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        let timeFmt = DateFormatter()
        timeFmt.calendar = calendar
        timeFmt.timeZone = calendar.timeZone
        timeFmt.locale = Locale(identifier: "en_US_POSIX")
        timeFmt.dateFormat = "HH:mm"
        let hhmm = timeFmt.string(from: date)

        let startDate = calendar.startOfDay(for: date)
        let startNow = calendar.startOfDay(for: now)
        let dayDiff = calendar.dateComponents([.day], from: startDate, to: startNow).day ?? 0
        if dayDiff == 0 {
            return hhmm
        }
        if dayDiff == 1 {
            return "Yesterday \(hhmm)"
        }
        let dateFmt = DateFormatter()
        dateFmt.calendar = calendar
        dateFmt.timeZone = calendar.timeZone
        dateFmt.locale = Locale(identifier: "en_US_POSIX")
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        dateFmt.dateFormat = sameYear ? "MMM d" : "MMM d, yyyy"
        return "\(dateFmt.string(from: date)), \(hhmm)"
    }

    static func classify(
        transport: String?,
        turnOnly: Bool,
        connection: String?,
        presenceProvided: Bool,
        wake: SeatWakeTimestamps?,
        lastCommandAt: Date?,
        lastActivityAt: Date?,
        workingOnSince: Date?,
        workingOnUntil: Date?,
        doingSince: Date?,
        serverWork: String?,
        waitingSince: Date?,
        unseenCount: Int?,
        statusUnavailable: Bool = false,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> SeatStatus {
        let hosted = transport == "hosted_mcp"
        let isTurnOnly = hosted || turnOnly

        let pushCandidates: [(route: String, date: Date, age: TimeInterval)] = [
            ("watcher", wake?.watcherAt),
            ("channel", wake?.channelAt),
            ("listener", wake?.listenerAt),
        ].compactMap { route, date in
            guard let date else { return nil }
            return (route, date, max(0, now.timeIntervalSince(date)))
        }.sorted { $0.age < $1.age }

        let wakeKind: String
        let wakeAge: TimeInterval?
        if hosted {
            wakeKind = "turn"
            wakeAge = wake?.turnAt.map { max(0, now.timeIntervalSince($0)) }
        } else if presenceProvided {
            if let push = pushCandidates.first {
                let state = push.age <= wakeLeaseStaleInterval ? "live" : "stale"
                wakeKind = "\(state) \(push.route)"
                wakeAge = push.age
            } else if let turnAt = wake?.turnAt {
                wakeKind = "turn"
                wakeAge = max(0, now.timeIntervalSince(turnAt))
            } else {
                wakeKind = "none"
                wakeAge = nil
            }
        } else {
            wakeKind = isTurnOnly ? "turn" : "none"
            wakeAge = nil
        }

        let hasLiveListener = !hosted && wakeKind.hasPrefix("live ")
        let isTurnSeat = isTurnOnly || (!hasLiveListener && wakeKind == "turn")

        let workingActive: Bool
        if workingOnSince != nil {
            if let workingOnUntil {
                workingActive = workingOnUntil > now
            } else {
                workingActive = true
            }
        } else {
            workingActive = false
        }

        let activityCandidates: [Date] = [
            lastActivityAt,
            lastCommandAt,
            workingActive ? workingOnSince : nil,
            doingSince,
        ].compactMap { date in
            guard let date, date <= now else { return nil }
            return date
        }.sorted(by: >)

        let resolvedLastActivity = activityCandidates.first
        let lastActivityAge = resolvedLastActivity.map { max(0, now.timeIntervalSince($0)) }

        let pushLeaseDate: Date? = [wake?.watcherAt, wake?.channelAt, wake?.listenerAt]
            .compactMap { date in
                guard let date, date <= now else { return nil }
                return date
            }
            .sorted(by: >)
            .first

        let effectiveUnseenCount: Int? = unseenCount.flatMap { $0 >= 0 ? $0 : nil }
        let hasKnownUnseenCount = (effectiveUnseenCount ?? 0) > 0
        let hasWaitingRow = waitingSince != nil
            && (waitingSince! <= now)
            && (effectiveUnseenCount == nil || effectiveUnseenCount! > 0)
        let waitingAge: TimeInterval? = hasWaitingRow ? max(0, now.timeIntervalSince(waitingSince!)) : nil
        let staleWaiting = (waitingAge ?? -1) >= waitingStaleInterval
        let reportedUnseenCount = hasKnownUnseenCount ? effectiveUnseenCount! : (hasWaitingRow ? 1 : 0)

        func build(
            _ kind: SeatStatusKind,
            _ line: String,
            _ indicator: SeatIndicator,
            attention: Bool,
            since: Date?,
            age: TimeInterval?
        ) -> SeatStatus {
            SeatStatus(
                kind: kind,
                line: line,
                indicator: indicator,
                attention: attention,
                staleWaiting: staleWaiting,
                wakeKind: wakeKind,
                since: since,
                ageSeconds: age,
                lastActivityAt: resolvedLastActivity,
                unseenCount: reportedUnseenCount
            )
        }

        // 1. Disconnected / credential / access faults always outrank activity.
        switch connection {
        case "removed":
            return build(.removed, "Removed", .diamond, attention: true, since: resolvedLastActivity, age: lastActivityAge)
        case "connection_off":
            return build(.connectionOff, "Connection turned off", .diamond, attention: true, since: resolvedLastActivity, age: lastActivityAge)
        case "key_off":
            return build(.keyOff, "Key turned off", .diamond, attention: true, since: resolvedLastActivity, age: lastActivityAge)
        case "paused":
            return build(.paused, "Access suspended", .diamond, attention: true, since: resolvedLastActivity, age: lastActivityAge)
        case "key_ended":
            return build(.keyEnded, "Key ended", .diamond, attention: true, since: resolvedLastActivity, age: lastActivityAge)
        default:
            break
        }
        if serverWork == "disconnected" {
            return build(.connectionOff, "Needs reconnecting", .diamond, attention: true, since: resolvedLastActivity, age: lastActivityAge)
        }

        // Explicit status read failure.
        if statusUnavailable {
            return build(.unknown, "Status unavailable", .ring, attention: false, since: resolvedLastActivity, age: lastActivityAge)
        }

        let recentActivity = lastActivityAge.map { $0 <= workRecentInterval } ?? false
        let hasWorkClaim = doingSince != nil || workingActive
        let isWorking = serverWork == "working" || (serverWork != "idle" && hasWorkClaim && recentActivity)

        // 2. Waiting messages (right after access faults):
        //    - Whenever unseenCount > 0 is known, surface "Waiting since … · N unseen" with a diamond immediately.
        //    - Otherwise (legacy timestamp without count), surface if stale (>= 3 min) or idle without a live listener.
        let showWaiting = hasKnownUnseenCount || (hasWaitingRow && (staleWaiting || (!isWorking && !hasLiveListener)))
        if showWaiting {
            if hasWaitingRow, let waitingSince, let waitingAge {
                let clock = formatClock(waitingSince, now: now, calendar: calendar)
                let suffix = hasKnownUnseenCount ? " · \(effectiveUnseenCount!) unseen" : ""
                return build(
                    .waiting,
                    "Waiting since \(clock)\(suffix)",
                    (staleWaiting || hasKnownUnseenCount) ? .diamond : .ring,
                    attention: staleWaiting && !isTurnSeat,
                    since: waitingSince,
                    age: waitingAge
                )
            }
            if hasKnownUnseenCount {
                return build(
                    .waiting,
                    "Waiting · \(effectiveUnseenCount!) unseen",
                    .diamond,
                    attention: false,
                    since: nil,
                    age: nil
                )
            }
        }

        // 3. Verified recent work:
        //    - Filled dot + "Working · 3 min" ONLY when a live push listener lease is verified.
        //    - Hollow ring + "Working · 3 min ago" otherwise (turn-only or unverified push seat).
        if isWorking {
            let refDate: Date?
            if let doingSince, doingSince <= now {
                refDate = doingSince
            } else if workingActive, let workingOnSince, workingOnSince <= now {
                refDate = workingOnSince
            } else {
                refDate = resolvedLastActivity
            }
            let workAge = refDate.map { max(0, now.timeIntervalSince($0)) } ?? lastActivityAge
            let line: String
            if let workAge {
                line = hasLiveListener
                    ? "Working · \(formatElapsed(workAge))"
                    : "Working · \(formatAgo(workAge))"
            } else {
                line = "Working"
            }
            return build(.working, line, hasLiveListener ? .dot : .ring, attention: false, since: refDate, age: workAge)
        }

        // 4. Failed / unloaded status read -> "Status unavailable" with hollow ring.
        if !presenceProvided {
            return build(.unknown, "Status unavailable", .ring, attention: false, since: resolvedLastActivity, age: lastActivityAge)
        }

        // 5. Turn-only seats (hosted MCP or turn-only local seat) — never fake a live dot.
        if isTurnSeat {
            let line = lastActivityAge.map { "Turn-only, checks when opened · \(formatAgo($0))" }
                ?? "Turn-only, checks when opened"
            return build(.turnOnly, line, .ring, attention: false, since: resolvedLastActivity, age: lastActivityAge)
        }

        // 6. Verified live push listener lease (<= 3 min) — uses the push lease timestamp.
        if hasLiveListener {
            let leaseAge = pushLeaseDate.map { max(0, now.timeIntervalSince($0)) } ?? wakeAge
            let line = leaseAge.map { "Listening · verified \(formatAgo($0))" } ?? "Listening"
            return build(.listening, line, .dot, attention: false, since: pushLeaseDate, age: leaseAge)
        }

        // 7. Local push-capable seat with presence/wake reported and no live push lease — uses last_activity_at.
        let line = lastActivityAge.map { "Not listening · last active \(formatAgo($0))" } ?? "Not listening"
        return build(.notListening, line, .ring, attention: false, since: resolvedLastActivity, age: lastActivityAge)
    }
}

struct WorkspaceAgent: Hashable, Identifiable, Sendable {
    let principalID: UUID
    let name: String
    let model: String?
    let transport: String?
    let turnOnly: Bool
    let ownerUserID: UUID
    let ownerName: String?
    let isOwnedByViewer: Bool
    let presenceAvailable: Bool
    let lastCommandAt: Date?
    let clientBuild: String?
    let lastAckVia: String?
    let connection: String?
    let wake: SeatWakeTimestamps?
    let lastActivityAt: Date?
    let workingOnSince: Date?
    let workingOnUntil: Date?
    let doingSince: Date?
    let serverWork: String?
    let waitingSince: Date?
    let unseenCount: Int?

    init(
        principalID: UUID,
        name: String,
        model: String?,
        transport: String?,
        turnOnly: Bool,
        ownerUserID: UUID,
        ownerName: String?,
        isOwnedByViewer: Bool,
        presenceAvailable: Bool,
        lastCommandAt: Date?,
        clientBuild: String?,
        lastAckVia: String?,
        connection: String? = nil,
        wake: SeatWakeTimestamps? = nil,
        lastActivityAt: Date? = nil,
        workingOnSince: Date? = nil,
        workingOnUntil: Date? = nil,
        doingSince: Date? = nil,
        serverWork: String? = nil,
        waitingSince: Date? = nil,
        unseenCount: Int? = nil
    ) {
        self.principalID = principalID
        self.name = name
        self.model = model
        self.transport = transport
        self.turnOnly = turnOnly
        self.ownerUserID = ownerUserID
        self.ownerName = ownerName
        self.isOwnedByViewer = isOwnedByViewer
        self.presenceAvailable = presenceAvailable
        self.lastCommandAt = lastCommandAt
        self.clientBuild = clientBuild
        self.lastAckVia = lastAckVia
        self.connection = connection
        self.wake = wake
        self.lastActivityAt = lastActivityAt
        self.workingOnSince = workingOnSince
        self.workingOnUntil = workingOnUntil
        self.doingSince = doingSince
        self.serverWork = serverWork
        self.waitingSince = waitingSince
        self.unseenCount = unseenCount
    }

    var id: UUID { principalID }

    var hostLabel: String {
        switch transport {
        case "hosted_mcp":
            return "Hosted MCP"
        case "local":
            return turnOnly ? "Local · on demand" : "Local"
        default:
            return "Not reported"
        }
    }

    var deliveryDescription: String {
        switch transport {
        case "hosted_mcp":
            return "Hosted MCP · checks when opened"
        case "local":
            return turnOnly ? "Local · checks in on its own turn" : "Local · live listener"
        default:
            return "Connection type not reported"
        }
    }

    var ownerLabel: String {
        if isOwnedByViewer { return "Your agent" }
        if let ownerName, !ownerName.isEmpty { return "Owned by \(ownerName)" }
        return "Workspace agent"
    }

    func seatStatus(now: Date = Date(), calendar: Calendar = .current) -> SeatStatus {
        SeatStatusClassifier.classify(
            transport: transport,
            turnOnly: turnOnly,
            connection: connection,
            presenceProvided: presenceAvailable,
            wake: wake,
            lastCommandAt: lastCommandAt,
            lastActivityAt: lastActivityAt,
            workingOnSince: workingOnSince,
            workingOnUntil: workingOnUntil,
            doingSince: doingSince,
            serverWork: serverWork,
            waitingSince: waitingSince,
            unseenCount: unseenCount,
            now: now,
            calendar: calendar
        )
    }

    func lastActiveLabel(now: Date = Date()) -> String {
        guard presenceAvailable else { return "Not reported" }
        let latest = [lastActivityAt, lastCommandAt].compactMap { $0 }.max()
        guard let latest else { return "Not active yet" }
        return SeatStatusClassifier.formatAgo(max(0, now.timeIntervalSince(latest)))
    }
}

struct WorkspacePendingInvite: Hashable, Identifiable, Sendable {
    let invitationID: String
    let email: String
    let createdBy: UUID?
    let createdByName: String?
    let createdAt: Date?
    let expiresAt: Date?

    var id: String { invitationID }

    func isExpired(now: Date = Date()) -> Bool {
        guard let expiresAt else { return false }
        return expiresAt <= now
    }

    var invitedByLabel: String {
        if let createdByName, !createdByName.isEmpty {
            return "Invited by \(createdByName)"
        }
        return "Workspace invitation"
    }

    var expiryLabel: String {
        guard let expiresAt else { return "" }
        if isExpired() {
            return "Expired"
        }
        return "Expires \(expiresAt.formatted(date: .abbreviated, time: .shortened))"
    }
}

struct WorkspaceAgentAdminGrant: Hashable, Identifiable, Sendable {
    let grantID: String
    let principalID: UUID
    let agentName: String
    let ownerUserID: UUID?
    let ownerDisplay: String?
    let level: String
    let expiresAt: Date?
    let createdAt: Date?
    let mayEnd: Bool

    var id: String { grantID }

    var levelLabel: String {
        switch level.lowercased() {
        case "scoped": "Scoped admin"
        case "workspace": "Workspace admin"
        case "organization": "Organization admin"
        default: level.isEmpty ? "Admin access" : level.capitalized
        }
    }

    var grantedByLabel: String? {
        guard let ownerDisplay, !ownerDisplay.isEmpty else { return nil }
        return "Granted by \(ownerDisplay)"
    }
}

struct PeopleTabSummary: Equatable, Identifiable, Sendable {
    let tab: PeopleDirectoryTab
    let count: Int?
    let selected: Bool
    let accessibilityLabel: String

    var id: PeopleDirectoryTab { tab }
}

enum PeopleDirectoryError: Error, Equatable, Sendable {
    case accessRefused
}

enum PeopleDirectoryRules {
    static func parseISO8601(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        let withFrac = ISO8601DateFormatter()
        withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFrac.date(from: raw) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }

    /// Mirrors peopleTabs in site/src/lib/people/tabs.ts: never shows 0 when a read is pending or failed.
    static func tabSummaries(
        selected: PeopleDirectoryTab,
        peopleCount: Int,
        agentsCount: Int,
        invitesCount: Int,
        managersCount: Int,
        adminGrantsCount: Int,
        coreReady: Bool,
        invitesReady: Bool,
        adminGrantsReady: Bool
    ) -> [PeopleTabSummary] {
        PeopleDirectoryTab.allCases.map { tab in
            let count: Int?
            switch tab {
            case .people:
                count = coreReady ? peopleCount : nil
            case .agents:
                count = coreReady ? agentsCount : nil
            case .invites:
                count = (coreReady && invitesReady) ? invitesCount : nil
            case .admins:
                count = (coreReady && adminGrantsReady) ? (managersCount + adminGrantsCount) : nil
            }
            let a11y: String
            if let count {
                a11y = tab == .invites ? "Invites, \(count) waiting" : "\(tab.label), \(count)"
            } else {
                a11y = tab.label
            }
            return PeopleTabSummary(tab: tab, count: count, selected: tab == selected, accessibilityLabel: a11y)
        }
    }

    static func noMatchMessage(for tab: PeopleDirectoryTab) -> String {
        switch tab {
        case .people: "0 people. No matches. Try another name."
        case .agents: "0 agents. No matches. Try another name."
        case .invites: "0 invites. No matches. Try another name."
        case .admins: "0 admins. No matches. Try another name."
        }
    }
}

enum PeopleDetailDestination: Hashable {
    case person(UUID)
    case agent(UUID)
}

@MainActor
final class PeopleDirectoryStore: ObservableObject {
    @Published var selectedTab: PeopleDirectoryTab = .defaultTab
    @Published var query = ""
    @Published private(set) var people: [WorkspacePerson] = []
    @Published private(set) var agents: [WorkspaceAgent] = []
    @Published private(set) var invites: [WorkspacePendingInvite] = []
    @Published private(set) var adminGrants: [WorkspaceAgentAdminGrant] = []

    @Published private(set) var isLoading = false
    @Published private(set) var coreReady = false
    @Published private(set) var loadFailed = false
    @Published private(set) var invitesReady = false
    @Published private(set) var invitesFailed = false
    @Published private(set) var adminGrantsReady = false
    @Published private(set) var accessUnavailable = false

    let workspaceID: UUID
    private var loadGeneration = 0
    private var isRetired = false
    private var isListVisible = false
    private var activeDetailTokens: Set<UUID> = []
    private var activeSessionID: ObjectIdentifier?

    init(workspaceID: UUID) {
        self.workspaceID = workspaceID
    }

    func activate() {
        isRetired = false
    }

    func retire() {
        isListVisible = false
        activeDetailTokens.removeAll()
        isRetired = true
        loadGeneration += 1
        isLoading = false
    }

    func enterList() {
        isListVisible = true
        activate()
    }

    func leaveList() {
        isListVisible = false
        retireIfUnpresented()
    }

    func enterDetail(_ token: UUID) {
        activeDetailTokens.insert(token)
        activate()
    }

    func leaveDetail(_ token: UUID) {
        activeDetailTokens.remove(token)
        retireIfUnpresented()
    }

    private func retireIfUnpresented() {
        if !isListVisible && activeDetailTokens.isEmpty {
            isRetired = true
            loadGeneration += 1
            isLoading = false
        }
    }

    func authorizedPerson(id: UUID) -> WorkspacePerson? {
        guard !accessUnavailable, coreReady else { return nil }
        return people.first { $0.userID == id }
    }

    func authorizedAgent(id: UUID) -> WorkspaceAgent? {
        guard !accessUnavailable, coreReady else { return nil }
        return agents.first { $0.principalID == id }
    }

    var viewerRole: WorkspaceMemberRole? {
        people.first(where: { $0.isViewer })?.role
    }

    var viewerIsOwner: Bool {
        viewerRole == .owner
    }

    var managers: [WorkspacePerson] {
        people.filter { $0.role.isManager }
    }

    var visibleAdminGrants: [WorkspaceAgentAdminGrant] {
        guard !accessUnavailable, viewerIsOwner else { return [] }
        return adminGrants
    }

    var tabs: [PeopleTabSummary] {
        PeopleDirectoryRules.tabSummaries(
            selected: selectedTab,
            peopleCount: people.count,
            agentsCount: agents.count,
            invitesCount: invites.count,
            managersCount: managers.count,
            adminGrantsCount: visibleAdminGrants.count,
            coreReady: coreReady,
            invitesReady: invitesReady,
            adminGrantsReady: adminGrantsReady
        )
    }

    var filteredPeople: [WorkspacePerson] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return people }
        return people.filter {
            $0.name.lowercased().contains(needle) || $0.role.label.lowercased().contains(needle)
        }
    }

    var filteredAgents: [WorkspaceAgent] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return agents }
        return agents.filter {
            $0.name.lowercased().contains(needle)
                || ($0.model?.lowercased().contains(needle) ?? false)
                || ($0.ownerName?.lowercased().contains(needle) ?? false)
                || $0.hostLabel.lowercased().contains(needle)
                || $0.seatStatus().line.lowercased().contains(needle)
        }
    }

    var filteredInvites: [WorkspacePendingInvite] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return invites }
        return invites.filter {
            $0.email.lowercased().contains(needle)
                || ($0.createdByName?.lowercased().contains(needle) ?? false)
        }
    }

    var filteredAdminPeople: [WorkspacePerson] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return managers }
        return managers.filter {
            $0.name.lowercased().contains(needle) || $0.role.label.lowercased().contains(needle)
        }
    }

    var filteredAdminGrants: [WorkspaceAgentAdminGrant] {
        let grants = visibleAdminGrants
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return grants }
        return grants.filter {
            $0.agentName.lowercased().contains(needle)
                || $0.levelLabel.lowercased().contains(needle)
                || ($0.ownerDisplay?.lowercased().contains(needle) ?? false)
        }
    }

    func agentsOwned(by userID: UUID) -> [WorkspaceAgent] {
        guard !accessUnavailable, coreReady else { return [] }
        return agents.filter { $0.ownerUserID == userID }
    }

    func load(api: PeopleDirectoryAPI) async {
        guard !isRetired else { return }
        let capturedSession = api.session
        let sessionID = ObjectIdentifier(capturedSession)
        if let prev = activeSessionID, prev != sessionID {
            applyAccessUnavailable()
        }
        activeSessionID = sessionID
        guard capturedSession.isActive else {
            applyAccessUnavailable()
            return
        }

        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        loadFailed = false
        invitesFailed = false

        let readGate: @MainActor @Sendable () -> Bool = { [weak self] in
            guard let self else { return false }
            return !self.isRetired
                && capturedSession.isActive
                && self.activeSessionID == sessionID
                && self.loadGeneration == generation
        }

        do {
            let result = try await api.loadDirectory(workspaceID: workspaceID, canDispatch: readGate)
            guard !Task.isCancelled, !isRetired, capturedSession.isActive,
                  activeSessionID == sessionID, generation == loadGeneration else { return }
            switch result {
            case .complete(let snapshot):
                people = snapshot.people
                agents = snapshot.agents
                invites = snapshot.invites
                adminGrants = viewerIsOwner ? snapshot.adminGrants : []
                coreReady = true
                invitesReady = snapshot.invitesLoaded
                invitesFailed = !snapshot.invitesLoaded
                adminGrantsReady = snapshot.adminGrantsLoaded
                accessUnavailable = false
                loadFailed = false
            case .coreFailed(let partial):
                if let updatedPeople = partial.people {
                    people = updatedPeople
                }
                if let updatedAgents = partial.agents {
                    agents = updatedAgents
                }
                if let updatedInvites = partial.invites {
                    invites = updatedInvites
                    invitesReady = true
                    invitesFailed = false
                } else {
                    invitesReady = false
                    invitesFailed = true
                }
                if partial.people != nil && !viewerIsOwner {
                    // Fresh non-owner roster overrides both a failed grant RPC and any
                    // stale pre-demotion owner grant snapshot returned in parallel.
                    adminGrants = []
                    adminGrantsReady = partial.adminGrants != nil
                } else if let updatedAdminGrants = partial.adminGrants {
                    adminGrants = updatedAdminGrants
                    adminGrantsReady = true
                } else {
                    adminGrantsReady = false
                }
                loadFailed = true
            }
        } catch PeopleDirectoryError.accessRefused {
            guard !Task.isCancelled, !isRetired,
                  activeSessionID == sessionID, generation == loadGeneration else { return }
            applyAccessUnavailable()
        } catch is CancellationError {
            if !capturedSession.isActive {
                applyAccessUnavailable()
            }
        } catch {
            guard !Task.isCancelled, !isRetired,
                  activeSessionID == sessionID, generation == loadGeneration else { return }
            if !capturedSession.isActive {
                applyAccessUnavailable()
            } else {
                loadFailed = true
            }
        }
        if generation == loadGeneration && !isRetired {
            isLoading = false
        }
    }

    private func applyAccessUnavailable() {
        people = []
        agents = []
        invites = []
        adminGrants = []
        coreReady = false
        invitesReady = false
        invitesFailed = false
        adminGrantsReady = false
        loadFailed = false
        accessUnavailable = true
    }
}
