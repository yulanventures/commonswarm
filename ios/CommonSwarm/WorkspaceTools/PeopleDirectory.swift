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

enum AgentActivityStatus: Equatable, Hashable, Sendable {
    case active
    case idle
    case notActiveYet
    case notReported

    var label: String {
        switch self {
        case .active: "Active"
        case .idle: "Idle"
        case .notActiveYet: "Not active yet"
        case .notReported: "Not reported"
        }
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
            return "Hosted MCP · OAuth connector"
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

    func activityStatus(now: Date = Date()) -> AgentActivityStatus {
        guard presenceAvailable else { return .notReported }
        guard let lastCommandAt else { return .notActiveYet }
        let elapsed = now.timeIntervalSince(lastCommandAt)
        return elapsed <= 15 * 60 ? .active : .idle
    }

    func lastActiveLabel(now: Date = Date()) -> String {
        guard presenceAvailable else { return "Not reported" }
        guard let lastCommandAt else { return "Not active yet" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: lastCommandAt, relativeTo: now)
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
    case person(WorkspacePerson)
    case agent(WorkspaceAgent)
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
    private var activeSessionID: ObjectIdentifier?

    init(workspaceID: UUID) {
        self.workspaceID = workspaceID
    }

    func activate() {
        isRetired = false
    }

    func retire() {
        isRetired = true
        loadGeneration += 1
        isLoading = false
    }

    var managers: [WorkspacePerson] {
        people.filter { $0.role.isManager }
    }

    var tabs: [PeopleTabSummary] {
        PeopleDirectoryRules.tabSummaries(
            selected: selectedTab,
            peopleCount: people.count,
            agentsCount: agents.count,
            invitesCount: invites.count,
            managersCount: managers.count,
            adminGrantsCount: adminGrants.count,
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
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return adminGrants }
        return adminGrants.filter {
            $0.agentName.lowercased().contains(needle)
                || $0.levelLabel.lowercased().contains(needle)
                || ($0.ownerDisplay?.lowercased().contains(needle) ?? false)
        }
    }

    func agentsOwned(by userID: UUID) -> [WorkspaceAgent] {
        agents.filter { $0.ownerUserID == userID }
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
            let snapshot = try await api.loadDirectory(workspaceID: workspaceID, canDispatch: readGate)
            guard !Task.isCancelled, !isRetired, capturedSession.isActive,
                  activeSessionID == sessionID, generation == loadGeneration else { return }
            people = snapshot.people
            agents = snapshot.agents
            invites = snapshot.invites
            adminGrants = snapshot.adminGrants
            coreReady = true
            invitesReady = snapshot.invitesLoaded
            invitesFailed = !snapshot.invitesLoaded
            adminGrantsReady = snapshot.adminGrantsLoaded
            accessUnavailable = false
            loadFailed = false
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
