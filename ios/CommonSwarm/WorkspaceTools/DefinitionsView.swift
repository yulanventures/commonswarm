import SwiftUI

struct DefinitionsRoute: Hashable {}

struct DefinitionDetailRoute: Hashable {
    let objectID: String
}

private struct DefinitionBadgePalette {
    let colorScheme: ColorScheme

    func foreground(for status: DefinitionCertificationState) -> Color {
        switch status {
        case .certified:
            colorScheme == .dark
                ? Color(red: 0.64, green: 0.96, blue: 0.72)
                : Color(red: 0.05, green: 0.36, blue: 0.14)
        case .proposalPending:
            colorScheme == .dark
                ? Color(red: 1.00, green: 0.80, blue: 0.44)
                : Color(red: 0.50, green: 0.25, blue: 0.00)
        case .proposed:
            colorScheme == .dark
                ? Color(red: 0.52, green: 0.78, blue: 1.00)
                : Color(red: 0.00, green: 0.31, blue: 0.68)
        }
    }

    func background(for status: DefinitionCertificationState) -> Color {
        switch status {
        case .certified:
            colorScheme == .dark
                ? Color(red: 0.09, green: 0.24, blue: 0.14)
                : Color(red: 0.86, green: 0.96, blue: 0.89)
        case .proposalPending:
            colorScheme == .dark
                ? Color(red: 0.28, green: 0.18, blue: 0.06)
                : Color(red: 0.99, green: 0.93, blue: 0.83)
        case .proposed:
            colorScheme == .dark
                ? Color(red: 0.08, green: 0.20, blue: 0.32)
                : Color(red: 0.89, green: 0.94, blue: 1.00)
        }
    }

    var primaryBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.08, green: 0.40, blue: 0.80)
            : Color(red: 0.00, green: 0.35, blue: 0.80)
    }

    var mutedForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.72, green: 0.72, blue: 0.76)
            : Color(red: 0.34, green: 0.34, blue: 0.37)
    }

    var errorForeground: Color {
        colorScheme == .dark
            ? Color(red: 1.00, green: 0.48, blue: 0.46)
            : Color(red: 0.72, green: 0.08, blue: 0.08)
    }

    var statusForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.64, green: 0.96, blue: 0.72)
            : Color(red: 0.05, green: 0.36, blue: 0.14)
    }
}

private struct DefinitionStatusBadge: View {
    let status: DefinitionCertificationState
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = DefinitionBadgePalette(colorScheme: colorScheme)
        Text(status.label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(palette.foreground(for: status))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(palette.background(for: status), in: Capsule())
    }
}

struct DefinitionsListView: View {
    let api: ConversationAPI
    let workspace: Workspace

    @StateObject private var store: DefinitionsListStore
    @State private var createdRoute: DefinitionDetailRoute?
    @Environment(\.colorScheme) private var colorScheme

    init(api: ConversationAPI, workspace: Workspace) {
        self.api = api
        self.workspace = workspace
        _store = StateObject(wrappedValue: DefinitionsListStore(workspaceID: workspace.id))
    }

    private var definitionsAPI: DefinitionsAPI { DefinitionsAPI(api: api) }

    var body: some View {
        let palette = DefinitionBadgePalette(colorScheme: colorScheme)

        Group {
            if let accessError = store.accessError {
                ContentUnavailableView(
                    store.needsConsent ? "Access confirmation needed" : "Access unavailable",
                    systemImage: store.needsConsent ? "hand.raised" : "lock.slash",
                    description: Text(accessError)
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.isUnsupported {
                ContentUnavailableView(
                    "Definitions unavailable",
                    systemImage: "book.closed",
                    description: Text("This server does not support workspace definitions yet.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.isLoading && store.definitions.isEmpty && !store.showsListRecoverySurface {
                ProgressView("Loading definitions…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.loadFailed && store.definitions.isEmpty && !store.showsListRecoverySurface {
                RetryView(text: "Couldn’t load definitions") {
                    await store.load(api: definitionsAPI)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.definitions.isEmpty && !store.showsListRecoverySurface {
                ContentUnavailableView(
                    "No definitions yet",
                    systemImage: "book.closed"
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    if let createError = store.createError {
                        Section {
                            Text(verbatim: createError)
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(palette.errorForeground)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("definitions-list-create-error")
                        }
                    }
                    if store.canEdit && store.hasUnknownPendingCreate {
                        Section {
                            Button {
                                Task {
                                    if let createdID = await store.retryPendingCreate(api: definitionsAPI) {
                                        createdRoute = DefinitionDetailRoute(objectID: createdID)
                                    }
                                }
                            } label: {
                                let label = store.pendingCreateTerm.map { "Retry creating “\($0)”" } ?? "Retry pending definition"
                                Text(store.isCreating ? "Checking…" : label)
                                    .font(.subheadline.weight(.semibold))
                                    .frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .disabled(store.isCreating)
                            .accessibilityIdentifier("definitions-retry-pending-create")
                        }
                    }
                    if let status = store.statusMessage {
                        Section {
                            Text(verbatim: status)
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(palette.statusForeground)
                                .accessibilityIdentifier("definitions-list-status")
                        }
                    }
                    if store.definitions.isEmpty {
                        ContentUnavailableView(
                            "No definitions yet",
                            systemImage: "book.closed"
                        )
                        .listRowBackground(Color.clear)
                    } else if store.filteredDefinitions.isEmpty {
                        ContentUnavailableView.search(text: store.searchQuery)
                            .listRowBackground(Color.clear)
                    } else {
                        ForEach(store.filteredDefinitions) { item in
                            NavigationLink(value: DefinitionDetailRoute(objectID: item.objectID)) {
                                HStack(alignment: .center, spacing: 10) {
                                    Text(verbatim: item.term)
                                        .font(.body.weight(.medium))
                                        .foregroundStyle(.primary)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Spacer(minLength: 8)
                                    DefinitionStatusBadge(status: item.status)
                                }
                                .frame(minHeight: 44)
                            }
                            .accessibilityIdentifier("definition-row-\(item.objectID)")
                        }
                    }
                }
                .searchable(text: $store.searchQuery, prompt: "Search terms")
                .refreshable {
                    await store.load(api: definitionsAPI)
                }
            }
        }
        .navigationTitle("Definitions")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if store.canEdit {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        store.openCreateSheet()
                    } label: {
                        Label("New definition", systemImage: "plus")
                    }
                    .accessibilityIdentifier("definitions-create-button")
                }
            }
        }
        .navigationDestination(for: DefinitionDetailRoute.self) { route in
            DefinitionDetailView(
                api: api,
                workspace: workspace,
                objectID: route.objectID,
                onChanged: { await store.load(api: definitionsAPI) }
            )
        }
        .navigationDestination(item: $createdRoute) { route in
            DefinitionDetailView(
                api: api,
                workspace: workspace,
                objectID: route.objectID,
                onChanged: { await store.load(api: definitionsAPI) }
            )
        }
        .sheet(item: $store.activeCreateSession) { createSession in
            let pending = store.pendingCreate?.outcomeUnknown == true ? store.pendingCreate?.fields : nil
            DefinitionEditorSheet(
                title: "New definition",
                actionTitle: pending != nil ? "Retry" : "Create",
                initialTerm: pending?.term ?? "",
                initialMeaning: pending?.meaning ?? "",
                initialSource: pending?.source ?? "",
                isSaving: store.isCreating,
                errorMessage: store.createError
            ) { term, meaning, source in
                if let createdID = await store.createDefinition(
                    session: createSession,
                    term: term,
                    meaning: meaning,
                    source: source,
                    api: definitionsAPI
                ) {
                    createdRoute = DefinitionDetailRoute(objectID: createdID)
                }
            }
            .onDisappear {
                store.dismissCreateSession(createSession.id)
            }
        }
        .task {
            await store.load(api: definitionsAPI)
        }
        .onAppear {
            store.activate()
        }
        .onDisappear {
            store.retire()
        }
    }
}

struct DefinitionDetailView: View {
    let api: ConversationAPI
    let workspace: Workspace
    let objectID: String
    var onChanged: (() async -> Void)?

    @StateObject private var store: DefinitionDetailStore
    @Environment(\.colorScheme) private var colorScheme

    init(
        api: ConversationAPI,
        workspace: Workspace,
        objectID: String,
        onChanged: (() async -> Void)? = nil
    ) {
        self.api = api
        self.workspace = workspace
        self.objectID = objectID
        self.onChanged = onChanged
        _store = StateObject(wrappedValue: DefinitionDetailStore(workspaceID: workspace.id, objectID: objectID))
    }

    private var definitionsAPI: DefinitionsAPI { DefinitionsAPI(api: api) }

    var body: some View {
        let palette = DefinitionBadgePalette(colorScheme: colorScheme)

        Group {
            if let accessError = store.accessError {
                ContentUnavailableView(
                    store.needsConsent ? "Access confirmation needed" : "Access unavailable",
                    systemImage: store.needsConsent ? "hand.raised" : "lock.slash",
                    description: Text(accessError)
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.isLoading && store.detail == nil {
                ProgressView("Loading definition…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.loadFailed && store.detail == nil {
                RetryView(text: "Couldn’t load definition") {
                    await store.load(api: definitionsAPI)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let detail = store.detail {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        headerCard(detail, palette: palette)

                        if let status = store.statusMessage {
                            Text(verbatim: status)
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(palette.statusForeground)
                                .accessibilityIdentifier("definition-status-message")
                        }

                        if let error = store.errorMessage {
                            Text(verbatim: error)
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(palette.errorForeground)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("definition-error-message")
                        }

                        if let unsent = store.conflictDraft {
                            unsentDraftCard(unsent, palette: palette)
                        }

                        fieldsCard(
                            title: nil,
                            term: nil,
                            meaning: detail.current.meaning,
                            source: detail.current.source,
                            palette: palette
                        )

                        if detail.proposalPending, let certified = detail.certified {
                            comparisonSection(certified: certified, proposed: detail.current, palette: palette)
                        }

                        if store.canEdit && store.hasUnknownPendingUpdate {
                            Button {
                                Task {
                                    if await store.retryPendingUpdate(api: definitionsAPI) {
                                        await onChanged?()
                                    }
                                }
                            } label: {
                                Text(store.isSaving ? "Checking…" : "Retry pending edit")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                    .frame(maxWidth: .infinity, minHeight: 44)
                                    .background(palette.primaryBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .disabled(store.isSaving)
                            .accessibilityIdentifier("definition-retry-pending-update")
                        }

                        if store.canEdit && store.hasUnknownPendingCertify {
                            Button {
                                Task {
                                    if await store.retryPendingCertify(api: definitionsAPI) {
                                        await onChanged?()
                                    }
                                }
                            } label: {
                                Text(store.isSaving ? "Checking…" : "Retry pending certification")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                                    .frame(maxWidth: .infinity, minHeight: 44)
                                    .background(palette.primaryBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .disabled(store.isSaving)
                            .accessibilityIdentifier("definition-retry-pending-certify")
                        }

                        if store.canCertify && !store.hasUnknownPendingCertify {
                            Button {
                                Task {
                                    if await store.certify(api: definitionsAPI) {
                                        await onChanged?()
                                    }
                                }
                            } label: {
                                HStack(spacing: 8) {
                                    if store.isSaving {
                                        ProgressView()
                                            .tint(.white)
                                        Text("Certifying…")
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(.white)
                                    } else {
                                        Image(systemName: "checkmark.seal.fill")
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(.white)
                                            .accessibilityHidden(true)
                                        Text(detail.certified != nil ? "Certify proposed version" : "Certify definition")
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(.white)
                                    }
                                }
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .background(palette.primaryBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .disabled(store.isSaving)
                            .accessibilityIdentifier("definition-certify-button")
                        }
                    }
                    .padding()
                }
                .refreshable {
                    await store.load(api: definitionsAPI)
                }
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(store.detail?.current.term ?? "Definition")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if store.canEdit {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") {
                        store.beginEdit()
                    }
                    .disabled(store.isSaving)
                    .accessibilityIdentifier("definition-edit-button")
                }
            }
        }
        .sheet(item: $store.activeEditSession) { editSession in
            let pending = store.pendingUpdate?.outcomeUnknown == true
                && store.pendingUpdate?.baseRevision.token == editSession.baseRevision.token
                ? store.pendingUpdate?.afterFields
                : nil
            DefinitionEditorSheet(
                title: "Edit definition",
                actionTitle: pending != nil ? "Retry" : "Save",
                initialTerm: pending?.term ?? editSession.beforeFields.term,
                initialMeaning: pending?.meaning ?? editSession.beforeFields.meaning,
                initialSource: pending?.source ?? editSession.beforeFields.source,
                unsentDraft: pending == nil ? store.conflictDraft : nil,
                isSaving: store.isSaving,
                errorMessage: store.errorMessage
            ) { term, meaning, source in
                if await store.update(
                    session: editSession,
                    term: term,
                    meaning: meaning,
                    source: source,
                    api: definitionsAPI
                ) {
                    await onChanged?()
                }
            }
        }
        .task {
            await store.load(api: definitionsAPI)
        }
        .onAppear {
            store.activate()
        }
        .onDisappear {
            store.retire()
        }
    }

    private func headerCard(_ detail: DefinitionDetail, palette: DefinitionBadgePalette) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                Text(verbatim: detail.current.term)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                DefinitionStatusBadge(status: detail.status)
                    .accessibilityIdentifier("definition-status-badge")
            }

            HStack(spacing: 6) {
                Image(systemName: detail.current.authorIsAgent ? "cpu" : "person.crop.circle")
                    .font(.caption)
                    .foregroundStyle(palette.mutedForeground)
                    .accessibilityHidden(true)
                let savedAt = detail.current.formattedSavedAt
                Text(verbatim: savedAt.isEmpty ? detail.current.authorLabel : "\(detail.current.authorLabel) · \(savedAt)")
                    .font(.caption)
                    .foregroundStyle(palette.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let certified = detail.certified {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.seal")
                        .font(.caption)
                        .foregroundStyle(palette.statusForeground)
                        .accessibilityHidden(true)
                    let certAt = certified.formattedCertifiedAt
                    let certText = certAt.isEmpty
                        ? "Certified by \(certified.certifiedByLabel)"
                        : "Certified by \(certified.certifiedByLabel) · \(certAt)"
                    Text(verbatim: certText)
                        .font(.caption)
                        .foregroundStyle(palette.mutedForeground)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityIdentifier("definition-certified-meta")
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func fieldsCard(
        title: String?,
        term: String?,
        meaning: String,
        source: String,
        palette: DefinitionBadgePalette
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                Text(verbatim: title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
            }
            if let term {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Term")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.mutedForeground)
                    Text(verbatim: term)
                        .font(.body)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("Meaning")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.mutedForeground)
                Text(verbatim: meaning)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("Source")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.mutedForeground)
                Text(verbatim: source.isEmpty ? "None" : source)
                    .font(.body)
                    .foregroundStyle(source.isEmpty ? palette.mutedForeground : .primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func unsentDraftCard(_ draft: DefinitionFields, palette: DefinitionBadgePalette) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Your unsent changes")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
            if !draft.term.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Term")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.mutedForeground)
                    Text(verbatim: draft.term)
                        .font(.body)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            if !draft.meaning.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Meaning")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.mutedForeground)
                    Text(verbatim: draft.meaning)
                        .font(.body)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            if !draft.source.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Source")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.mutedForeground)
                    Text(verbatim: draft.source)
                        .font(.body)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            HStack(spacing: 10) {
                if store.canEdit {
                    Button {
                        store.beginEdit()
                    } label: {
                        Text("Review in Edit")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 44)
                            .background(palette.primaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(store.isSaving)
                    .accessibilityIdentifier("definition-conflict-edit-button")
                }
                Button {
                    store.dismissConflictDraft()
                } label: {
                    Text("Discard")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(store.isSaving)
                .accessibilityIdentifier("definition-conflict-discard-button")
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("definition-unsent-draft-card")
    }

    private func comparisonSection(
        certified: DefinitionCertifiedVersion,
        proposed: DefinitionVersion,
        palette: DefinitionBadgePalette
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Compare with certified")
                .font(.headline)
                .foregroundStyle(.primary)
            fieldsCard(
                title: "Certified",
                term: certified.term,
                meaning: certified.meaning,
                source: certified.source,
                palette: palette
            )
            fieldsCard(
                title: "Proposed (\(proposed.authorLabel))",
                term: proposed.term,
                meaning: proposed.meaning,
                source: proposed.source,
                palette: palette
            )
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("definition-comparison-section")
    }
}

private struct DefinitionEditorSheet: View {
    let title: String
    let actionTitle: String
    let unsentDraft: DefinitionFields?
    let isSaving: Bool
    let errorMessage: String?
    let onSubmit: (String, String, String) async -> Void

    @State private var term: String
    @State private var meaning: String
    @State private var source: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    init(
        title: String,
        actionTitle: String,
        initialTerm: String,
        initialMeaning: String,
        initialSource: String,
        unsentDraft: DefinitionFields? = nil,
        isSaving: Bool,
        errorMessage: String?,
        onSubmit: @escaping (String, String, String) async -> Void
    ) {
        self.title = title
        self.actionTitle = actionTitle
        self.unsentDraft = unsentDraft
        self.isSaving = isSaving
        self.errorMessage = errorMessage
        self.onSubmit = onSubmit
        _term = State(initialValue: initialTerm)
        _meaning = State(initialValue: initialMeaning)
        _source = State(initialValue: initialSource)
    }

    private var canSubmit: Bool {
        !isSaving
            && !DefinitionsRules.normalizeTerm(term).isEmpty
            && !DefinitionsRules.normalizeBody(meaning).isEmpty
    }

    var body: some View {
        let palette = DefinitionBadgePalette(colorScheme: colorScheme)

        NavigationStack {
            Form {
                if let errorMessage {
                    Section {
                        Text(verbatim: errorMessage)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(palette.errorForeground)
                            .accessibilityIdentifier("definition-editor-error")
                    }
                }
                if let unsentDraft {
                    Section("Your unsent wording") {
                        VStack(alignment: .leading, spacing: 6) {
                            if !unsentDraft.term.isEmpty {
                                Text(verbatim: "Term: \(unsentDraft.term)")
                                    .font(.footnote)
                                    .foregroundStyle(.primary)
                                    .textSelection(.enabled)
                            }
                            if !unsentDraft.meaning.isEmpty {
                                Text(verbatim: "Meaning: \(unsentDraft.meaning)")
                                    .font(.footnote)
                                    .foregroundStyle(.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .textSelection(.enabled)
                            }
                            if !unsentDraft.source.isEmpty {
                                Text(verbatim: "Source: \(unsentDraft.source)")
                                    .font(.footnote)
                                    .foregroundStyle(.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .textSelection(.enabled)
                            }
                        }
                        .accessibilityIdentifier("definition-editor-unsent-draft")

                        Button("Use my unsent wording") {
                            term = unsentDraft.term
                            meaning = unsentDraft.meaning
                            source = unsentDraft.source
                        }
                        .disabled(isSaving)
                        .accessibilityIdentifier("definition-editor-apply-unsent")
                    }
                }
                Section("Term") {
                    TextField("Term", text: $term)
                        .textInputAutocapitalization(.sentences)
                        .disabled(isSaving)
                        .accessibilityIdentifier("definition-term-field")
                }
                Section("Meaning") {
                    TextEditor(text: $meaning)
                        .frame(minHeight: 96)
                        .disabled(isSaving)
                        .accessibilityLabel("Meaning")
                        .accessibilityIdentifier("definition-meaning-field")
                }
                Section("Source") {
                    TextEditor(text: $source)
                        .frame(minHeight: 68)
                        .disabled(isSaving)
                        .accessibilityLabel("Source")
                        .accessibilityIdentifier("definition-source-field")
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : actionTitle) {
                        Task { await onSubmit(term, meaning, source) }
                    }
                    .disabled(!canSubmit)
                    .accessibilityIdentifier("definition-editor-submit")
                }
            }
        }
    }
}
