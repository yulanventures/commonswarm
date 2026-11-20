import SwiftUI

struct PeopleDirectoryRoute: Hashable {}

struct PeopleDirectoryView: View {
    let api: ConversationAPI
    let workspace: Workspace

    @StateObject private var store: PeopleDirectoryStore
    @Environment(\.colorScheme) private var colorScheme

    init(api: ConversationAPI, workspace: Workspace) {
        self.api = api
        self.workspace = workspace
        _store = StateObject(wrappedValue: PeopleDirectoryStore(workspaceID: workspace.id))
    }

    private var directoryAPI: PeopleDirectoryAPI { PeopleDirectoryAPI(api: api) }

    private var primaryBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.08, green: 0.40, blue: 0.80)
            : Color(red: 0.00, green: 0.35, blue: 0.80)
    }

    private var secondaryForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.94, green: 0.94, blue: 0.96)
            : Color(red: 0.11, green: 0.11, blue: 0.12)
    }

    private var secondaryBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.22, green: 0.22, blue: 0.24)
            : Color(red: 0.90, green: 0.90, blue: 0.92)
    }

    private var mutedForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.72, green: 0.72, blue: 0.76)
            : Color(red: 0.34, green: 0.34, blue: 0.37)
    }

    private var errorForeground: Color {
        colorScheme == .dark
            ? Color(red: 1.00, green: 0.48, blue: 0.46)
            : Color(red: 0.72, green: 0.08, blue: 0.08)
    }

    private var activeForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.68, green: 0.96, blue: 0.75)
            : Color(red: 0.06, green: 0.34, blue: 0.14)
    }

    private var activeBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.09, green: 0.24, blue: 0.14)
            : Color(red: 0.86, green: 0.96, blue: 0.89)
    }

    private var managerForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.49, green: 0.75, blue: 1.00)
            : Color(red: 0.00, green: 0.32, blue: 0.70)
    }

    private var managerBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.08, green: 0.20, blue: 0.32)
            : Color(red: 0.89, green: 0.94, blue: 1.00)
    }

    private var warnForeground: Color {
        colorScheme == .dark
            ? Color(red: 1.00, green: 0.78, blue: 0.44)
            : Color(red: 0.52, green: 0.26, blue: 0.00)
    }

    private var warnBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.28, green: 0.18, blue: 0.06)
            : Color(red: 0.99, green: 0.93, blue: 0.84)
    }

    var body: some View {
        Group {
            if store.accessUnavailable {
                ContentUnavailableView(
                    "Access unavailable",
                    systemImage: "lock.slash",
                    description: Text("You don’t have access to people and agents in this workspace.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.isLoading && !store.coreReady {
                ProgressView("Loading people and agents…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.loadFailed && !store.coreReady {
                RetryView(text: "Couldn’t load people and agents") {
                    await store.load(api: directoryAPI)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 0) {
                    tabHeader
                        .padding(.top, 8)
                        .padding(.bottom, 8)

                    searchField
                        .padding(.horizontal)
                        .padding(.bottom, 10)

                    tabBody
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("People & agents")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: PeopleDetailDestination.self) { destination in
            switch destination {
            case .person(let userID):
                WorkspacePersonDetailView(
                    store: store,
                    api: directoryAPI,
                    workspaceName: workspace.name,
                    userID: userID
                )
            case .agent(let principalID):
                WorkspaceAgentDetailView(
                    store: store,
                    api: directoryAPI,
                    workspaceName: workspace.name,
                    principalID: principalID
                )
            }
        }
        .task {
            store.enterList()
            await store.load(api: directoryAPI)
        }
        .onAppear {
            store.enterList()
        }
        .onDisappear {
            store.leaveList()
        }
    }

    private var tabHeader: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(store.tabs) { item in
                    Button {
                        store.selectedTab = item.tab
                    } label: {
                        HStack(spacing: 6) {
                            Text(item.tab.label)
                                .font(.footnote.weight(.semibold))
                            if let count = item.count {
                                Text("\(count)")
                                    .font(.caption.weight(.bold))
                            }
                        }
                        .foregroundStyle(item.selected ? Color.white : secondaryForeground)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .background(
                            item.selected ? primaryBackground : secondaryBackground,
                            in: Capsule()
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(item.accessibilityLabel)
                    .accessibilityAddTraits(item.selected ? .isSelected : [])
                    .accessibilityIdentifier("people-tab-\(item.tab.rawValue)")
                }
            }
            .padding(.horizontal)
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline)
                .foregroundStyle(mutedForeground)
                .accessibilityHidden(true)
            TextField(store.selectedTab.searchPlaceholder, text: $store.query)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityLabel(store.selectedTab.searchPlaceholder)
                .accessibilityIdentifier("people-search-field")
            if !store.query.isEmpty {
                Button {
                    store.query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.subheadline)
                        .foregroundStyle(mutedForeground)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, store.query.isEmpty ? 12 : 2)
        .frame(minHeight: 44)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    @ViewBuilder
    private var tabBody: some View {
        let hasQuery = !store.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        switch store.selectedTab {
        case .people:
            let rows = store.filteredPeople
            if rows.isEmpty {
                emptyState(hasQuery ? PeopleDirectoryRules.noMatchMessage(for: .people) : "No people in this workspace yet.", icon: "person.2")
            } else {
                ScrollView {
                    VStack(spacing: 10) {
                        ForEach(rows) { person in
                            NavigationLink(value: PeopleDetailDestination.person(person.userID)) {
                                personCard(person)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("people-row-\(person.userID.uuidString.lowercased())")
                        }
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 16)
                }
                .refreshable { await store.load(api: directoryAPI) }
            }

        case .agents:
            let rows = store.filteredAgents
            if rows.isEmpty {
                emptyState(hasQuery ? PeopleDirectoryRules.noMatchMessage(for: .agents) : "No agents connected yet.", icon: "cpu")
            } else {
                ScrollView {
                    VStack(spacing: 10) {
                        ForEach(rows) { agent in
                            NavigationLink(value: PeopleDetailDestination.agent(agent.principalID)) {
                                agentCard(agent)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("agent-row-\(agent.principalID.uuidString.lowercased())")
                        }
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 16)
                }
                .refreshable { await store.load(api: directoryAPI) }
            }

        case .invites:
            if store.invitesFailed {
                RetryView(text: "Couldn’t load pending invitations") {
                    await store.load(api: directoryAPI)
                }
            } else {
                let rows = store.filteredInvites
                if rows.isEmpty {
                    emptyState(hasQuery ? PeopleDirectoryRules.noMatchMessage(for: .invites) : "No pending invitations.", icon: "envelope")
                } else {
                    ScrollView {
                        VStack(spacing: 10) {
                            ForEach(rows) { invite in
                                inviteCard(invite)
                            }
                        }
                        .padding(.horizontal)
                        .padding(.bottom, 16)
                    }
                    .refreshable { await store.load(api: directoryAPI) }
                }
            }

        case .admins:
            let adminPeople = store.filteredAdminPeople
            let grants = store.filteredAdminGrants
            if adminPeople.isEmpty && grants.isEmpty {
                emptyState(hasQuery ? PeopleDirectoryRules.noMatchMessage(for: .admins) : "No workspace admins listed.", icon: "person.badge.shield.checkmark")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if !adminPeople.isEmpty {
                            Text("People who manage this workspace")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(mutedForeground)
                            VStack(spacing: 10) {
                                ForEach(adminPeople) { person in
                                    NavigationLink(value: PeopleDetailDestination.person(person.userID)) {
                                        personCard(person)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        if !grants.isEmpty {
                            Text("Agents with scoped admin access")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(mutedForeground)
                                .padding(.top, 4)
                            VStack(spacing: 10) {
                                ForEach(grants) { grant in
                                    adminGrantCard(grant)
                                }
                            }
                        }
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 16)
                }
                .refreshable { await store.load(api: directoryAPI) }
            }
        }
    }

    private func emptyState(_ text: String, icon: String) -> some View {
        ContentUnavailableView(text, systemImage: icon)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func personCard(_ person: WorkspacePerson) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "person.crop.circle.fill")
                .font(.title2)
                .foregroundStyle(person.role.isManager ? managerForeground : mutedForeground)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(verbatim: person.name)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    if person.isViewer {
                        Text("You")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(secondaryForeground)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(secondaryBackground, in: Capsule())
                    }
                }

                HStack(spacing: 6) {
                    Text(person.role.label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(person.role.isManager ? managerForeground : secondaryForeground)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(person.role.isManager ? managerBackground : secondaryBackground, in: Capsule())

                    let count = store.agentsOwned(by: person.userID).count
                    if count > 0 {
                        Text(count == 1 ? "1 agent" : "\(count) agents")
                            .font(.caption)
                            .foregroundStyle(mutedForeground)
                    }
                }
            }

            Spacer(minLength: 4)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(mutedForeground)
                .accessibilityHidden(true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func agentCard(_ agent: WorkspaceAgent) -> some View {
        let status = agent.activityStatus()
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: "cpu")
                .font(.title3.weight(.semibold))
                .foregroundStyle(status == .active ? activeForeground : mutedForeground)
                .padding(.top, 2)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: agent.name)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 6) {
                    Text(status.label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(status == .active ? activeForeground : secondaryForeground)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(status == .active ? activeBackground : secondaryBackground, in: Capsule())

                    Text(agent.hostLabel)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(secondaryForeground)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(secondaryBackground, in: Capsule())
                }

                let metaParts = [agent.ownerLabel, agent.model, agent.lastActiveLabel()].compactMap { value -> String? in
                    guard let value, !value.isEmpty else { return nil }
                    return value
                }
                Text(verbatim: metaParts.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 4)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(mutedForeground)
                .padding(.top, 4)
                .accessibilityHidden(true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func inviteCard(_ invite: WorkspacePendingInvite) -> some View {
        let expired = invite.isExpired()
        return VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: invite.email)
                .font(.headline)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                Text(expired ? "Expired" : "Pending")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(expired ? warnForeground : managerForeground)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(expired ? warnBackground : managerBackground, in: Capsule())
            }

            let details = [invite.invitedByLabel, invite.expiryLabel].filter { !$0.isEmpty }.joined(separator: " · ")
            Text(verbatim: details)
                .font(.caption)
                .foregroundStyle(mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func adminGrantCard(_ grant: WorkspaceAgentAdminGrant) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: grant.agentName)
                .font(.headline)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)

            let meta = [grant.levelLabel, grant.grantedByLabel].compactMap { $0 }.joined(separator: " · ")
            if !meta.isEmpty {
                Text(verbatim: meta)
                    .font(.caption)
                    .foregroundStyle(mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let expiresAt = grant.expiresAt {
                Text(verbatim: "Expires \(expiresAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption)
                    .foregroundStyle(mutedForeground)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private struct WorkspacePersonDetailView: View {
    @ObservedObject var store: PeopleDirectoryStore
    let api: PeopleDirectoryAPI
    let workspaceName: String
    let userID: UUID

    @State private var presentationToken = UUID()
    @Environment(\.colorScheme) private var colorScheme

    private var mutedForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.72, green: 0.72, blue: 0.76)
            : Color(red: 0.34, green: 0.34, blue: 0.37)
    }

    var body: some View {
        Group {
            if store.accessUnavailable {
                ContentUnavailableView(
                    "Access unavailable",
                    systemImage: "lock.slash",
                    description: Text("You don’t have access to people and agents in this workspace.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let person = store.authorizedPerson(id: userID) {
                let ownedAgents = store.agentsOwned(by: person.userID)
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(verbatim: person.name)
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(.primary)
                            Text(verbatim: "\(person.role.label) in \(workspaceName)")
                                .font(.subheadline)
                                .foregroundStyle(mutedForeground)
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                        VStack(alignment: .leading, spacing: 10) {
                            Text("Agents")
                                .font(.headline)
                                .foregroundStyle(.primary)
                            if ownedAgents.isEmpty {
                                Text("No agents in this workspace.")
                                    .font(.subheadline)
                                    .foregroundStyle(mutedForeground)
                            } else {
                                ForEach(ownedAgents) { agent in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(verbatim: agent.name)
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(.primary)
                                        Text(verbatim: "\(agent.hostLabel) · \(agent.lastActiveLabel())")
                                            .font(.caption)
                                            .foregroundStyle(mutedForeground)
                                    }
                                    .padding(10)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                }
                            }
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .padding()
                }
                .refreshable { await store.load(api: api) }
            } else if store.isLoading {
                ProgressView("Loading person…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView(
                    "Person unavailable",
                    systemImage: "person.slash",
                    description: Text("This person is no longer listed in this workspace.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Person")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: userID) {
            store.enterDetail(presentationToken)
            await store.load(api: api)
        }
        .onAppear {
            store.enterDetail(presentationToken)
        }
        .onDisappear {
            store.leaveDetail(presentationToken)
        }
    }
}

private struct WorkspaceAgentDetailView: View {
    @ObservedObject var store: PeopleDirectoryStore
    let api: PeopleDirectoryAPI
    let workspaceName: String
    let principalID: UUID

    @State private var presentationToken = UUID()
    @Environment(\.colorScheme) private var colorScheme
    @State private var showTechnical = false

    private var mutedForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.72, green: 0.72, blue: 0.76)
            : Color(red: 0.34, green: 0.34, blue: 0.37)
    }

    private var secondaryForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.94, green: 0.94, blue: 0.96)
            : Color(red: 0.11, green: 0.11, blue: 0.12)
    }

    private var secondaryBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.22, green: 0.22, blue: 0.24)
            : Color(red: 0.90, green: 0.90, blue: 0.92)
    }

    var body: some View {
        let resolvedAgent = store.authorizedAgent(id: principalID)
        Group {
            if store.accessUnavailable {
                ContentUnavailableView(
                    "Access unavailable",
                    systemImage: "lock.slash",
                    description: Text("You don’t have access to people and agents in this workspace.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let agent = resolvedAgent {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(verbatim: agent.name)
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(.primary)
                            Text(verbatim: "\(agent.ownerLabel) · \(workspaceName)")
                                .font(.subheadline)
                                .foregroundStyle(mutedForeground)
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                        VStack(alignment: .leading, spacing: 10) {
                            detailRow(label: "Status", value: agent.activityStatus().label)
                            detailRow(label: "Last active", value: agent.lastActiveLabel())
                            detailRow(label: "Connection", value: agent.deliveryDescription)
                            if let model = agent.model {
                                detailRow(label: "Model", value: model)
                            }
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                        VStack(alignment: .leading, spacing: 10) {
                            Button {
                                showTechnical.toggle()
                            } label: {
                                HStack {
                                    Text(showTechnical ? "Hide technical details" : "Technical details")
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(secondaryForeground)
                                    Spacer()
                                    Image(systemName: showTechnical ? "chevron.up" : "chevron.down")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(mutedForeground)
                                }
                                .padding(.horizontal, 12)
                                .frame(minHeight: 44)
                                .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("agent-detail-technical-toggle")

                            if showTechnical {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(verbatim: "Agent ID: \(agent.principalID.uuidString.lowercased())")
                                        .font(.caption.monospaced())
                                        .foregroundStyle(mutedForeground)
                                        .textSelection(.enabled)
                                    if let build = agent.clientBuild, !build.isEmpty {
                                        Text(verbatim: "Client build: \(build)")
                                            .font(.caption.monospaced())
                                            .foregroundStyle(mutedForeground)
                                    }
                                    if let ack = agent.lastAckVia, !ack.isEmpty {
                                        Text(verbatim: "Last ack via: \(ack)")
                                            .font(.caption.monospaced())
                                            .foregroundStyle(mutedForeground)
                                    }
                                }
                                .padding(.top, 4)
                            }
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .padding()
                }
                .refreshable { await store.load(api: api) }
            } else if store.isLoading {
                ProgressView("Loading agent…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView(
                    "Agent unavailable",
                    systemImage: "cpu",
                    description: Text("This agent is no longer listed in this workspace.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Agent")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: resolvedAgent == nil) { _, missing in
            if missing { showTechnical = false }
        }
        .task(id: principalID) {
            store.enterDetail(presentationToken)
            await store.load(api: api)
        }
        .onAppear {
            store.enterDetail(presentationToken)
        }
        .onDisappear {
            store.leaveDetail(presentationToken)
        }
    }

    private func detailRow(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(mutedForeground)
            Text(verbatim: value)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
