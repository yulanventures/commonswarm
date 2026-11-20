import SwiftUI

struct WikiRoute: Hashable {}

struct WikiListView: View {
    let api: ConversationAPI
    let workspace: Workspace

    @StateObject private var store: WikiStore
    @State private var selectedFileID: UUID?

    init(api: ConversationAPI, workspace: Workspace) {
        self.api = api
        self.workspace = workspace
        _store = StateObject(wrappedValue: WikiStore(api: WikiAPI(api: api), workspaceID: workspace.id))
    }

    var body: some View {
        content
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Wiki")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $store.searchQuery, prompt: "Search wiki")
            .toolbar {
                if store.canCreate, store.topics != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            store.openCreateSheet()
                        } label: {
                            Label("New page", systemImage: "plus")
                        }
                        .accessibilityIdentifier("wiki-create-button")
                    }
                }
            }
            .navigationDestination(item: $selectedFileID) { fileID in
                WikiTopicDetailView(store: store, initialFileID: fileID)
            }
            .sheet(item: $store.activeCreateSession) { createSession in
                WikiCreateSheet(
                    isSaving: store.isSaving,
                    errorMessage: store.actionError
                ) { rawTopic, markdown in
                    if let created = await store.createTopic(
                        session: createSession,
                        rawTopic: rawTopic,
                        markdown: markdown
                    ) {
                        selectedFileID = created.fileID
                    }
                }
                .onDisappear {
                    store.dismissCreateSession(createSession.id)
                }
            }
            .task {
                if store.topics == nil {
                    await store.loadTopics()
                }
            }
            .onAppear {
                store.activate()
            }
            .onDisappear {
                // Only retire when leaving the Wiki hierarchy (not when pushing a detail view).
                if selectedFileID == nil {
                    store.retire()
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if let failure = store.loadFailure, store.topics == nil {
            RetryView(text: failure.message) {
                await store.loadTopics()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.topics == nil {
            ProgressView("Loading wiki…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let items = store.filteredTopics
            let pendingRetries = store.eligiblePendingRetries()
            if items.isEmpty && pendingRetries.isEmpty {
                ContentUnavailableView(
                    store.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? "No wiki pages yet"
                        : "No matching pages",
                    systemImage: "books.vertical"
                )
            } else {
                List {
                    if !pendingRetries.isEmpty {
                        Section {
                            ForEach(pendingRetries) { item in
                                Button(item.label) {
                                    Task { _ = await store.retryPendingSave(item) }
                                }
                                .font(.subheadline.weight(.semibold))
                                .disabled(store.isSaving)
                                .accessibilityIdentifier("wiki-retry-\(item.commandID.uuidString.lowercased())")
                            }
                        }
                    }

                    if let failure = store.loadFailure {
                        Section {
                            RetryView(text: failure.message) {
                                await store.loadTopics()
                            }
                        }
                    }

                    Section {
                        ForEach(items) { topic in
                            Button {
                                selectedFileID = topic.fileID
                            } label: {
                                WikiTopicRow(topic: topic)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("wiki-row-\(topic.topic)")
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .refreshable {
                    await store.loadTopics()
                }
            }
        }
    }
}

private struct WikiTopicRow: View {
    let topic: WikiTopic

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: topic.topic)
                .font(.body.weight(.semibold))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                Text(verbatim: topic.versionLabel)
                Text("·")
                Text(verbatim: topic.relativeAgeLabel)
                Text("·")
                HStack(spacing: 3) {
                    Image(systemName: topic.isAgentUpdater ? "cpu" : "person")
                        .accessibilityHidden(true)
                    Text(verbatim: topic.updaterLabel)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }
}

struct WikiTopicDetailView: View {
    @ObservedObject var store: WikiStore
    let initialFileID: UUID

    @State private var currentFileID: UUID
    @State private var displayMode: DisplayMode = .formatted
    @State private var historyExpanded = false
    @Environment(\.colorScheme) private var colorScheme

    private enum DisplayMode: String, CaseIterable, Identifiable {
        case formatted = "Formatted"
        case raw = "Raw"
        var id: String { rawValue }
    }

    init(store: WikiStore, initialFileID: UUID) {
        self.store = store
        self.initialFileID = initialFileID
        _currentFileID = State(initialValue: initialFileID)
    }

    private var statusForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.64, green: 0.96, blue: 0.72)
            : Color(red: 0.05, green: 0.36, blue: 0.14)
    }

    private var errorForeground: Color {
        colorScheme == .dark
            ? Color(red: 1.00, green: 0.48, blue: 0.46)
            : Color(red: 0.72, green: 0.08, blue: 0.08)
    }

    private var topic: WikiTopic? {
        store.topics?.first(where: { $0.fileID == currentFileID })
    }

    var body: some View {
        Group {
            if let failure = store.loadFailure, store.topics == nil {
                RetryView(text: failure.message) {
                    if await store.loadTopics() {
                        await store.openTopic(fileID: currentFileID)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let topic {
                detailContent(topic)
            } else {
                ContentUnavailableView(
                    store.contentError ?? "Wiki page unavailable",
                    systemImage: "books.vertical"
                )
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(topic?.topic ?? "Wiki")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if store.canEditTopic(currentFileID) {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") {
                        store.beginEdit(fileID: currentFileID)
                    }
                    .disabled(store.isSaving)
                    .accessibilityIdentifier("wiki-edit-button")
                }
            }
        }
        .sheet(item: $store.activeEditSession) { editSession in
            WikiEditSheet(
                topic: editSession.topic,
                baseVersion: editSession.baseVersion,
                initialMarkdown: editSession.initialMarkdown,
                isSaving: store.isSaving,
                errorMessage: store.actionError
            ) { updatedMarkdown in
                _ = await store.saveEdit(session: editSession, markdown: updatedMarkdown)
            }
            .onDisappear {
                store.dismissEditSession(editSession.id)
            }
        }
        .task(id: currentFileID) {
            await store.openTopic(fileID: currentFileID)
        }
        .onAppear {
            store.activate()
        }
    }

    private func detailContent(_ topic: WikiTopic) -> some View {
        let viewingVersion = store.activeFileID == topic.fileID ? (store.activeVersion ?? topic.currentVersion) : topic.currentVersion
        let isLatest = viewingVersion == topic.currentVersion
        let pendingRetries = store.eligiblePendingRetries(for: topic.fileID)
        let knownTopics = (store.topics ?? []).map(\.topic)

        return List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(verbatim: topic.topic)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("wiki-detail-title")

                    Text(
                        verbatim: "\(topic.versionLabel) · updated \(topic.relativeAgeLabel) by \(topic.updaterLabel)"
                            + (isLatest ? "" : " · viewing v\(viewingVersion)")
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("wiki-detail-meta")

                    if !isLatest {
                        Button("View latest (v\(topic.currentVersion))") {
                            Task { await store.openTopic(fileID: topic.fileID, version: topic.currentVersion) }
                        }
                        .font(.subheadline.weight(.semibold))
                        .accessibilityIdentifier("wiki-view-latest-button")
                    }

                    if let notice = store.linkNotice {
                        Text(verbatim: notice)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(errorForeground)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("wiki-link-notice")
                    }

                    if let status = store.statusMessage {
                        Text(verbatim: status)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(statusForeground)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("wiki-detail-status")
                    }

                    if let error = store.actionError {
                        Text(verbatim: error)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(errorForeground)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("wiki-detail-error")
                    }

                    if !pendingRetries.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(pendingRetries) { item in
                                Button(item.label) {
                                    Task { _ = await store.retryPendingSave(item) }
                                }
                                .font(.subheadline.weight(.semibold))
                                .disabled(store.isSaving)
                                .accessibilityIdentifier("wiki-retry-\(item.commandID.uuidString.lowercased())")
                            }
                        }
                    }
                }
                .padding(.vertical, 4)

                Picker("View", selection: $displayMode) {
                    ForEach(DisplayMode.allCases) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("wiki-display-mode")
            }

            Section {
                if store.isLoadingContent && store.activeMarkdown == nil {
                    HStack {
                        ProgressView()
                        Text("Loading v\(viewingVersion)…")
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                } else if let contentError = store.contentError {
                    RetryView(text: contentError) {
                        await store.openTopic(fileID: topic.fileID, version: viewingVersion)
                    }
                } else if let markdown = store.activeMarkdown {
                    if displayMode == .raw {
                        Text(verbatim: markdown)
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                            .padding(.vertical, 4)
                            .accessibilityIdentifier("wiki-raw-body")
                    } else {
                        WikiMarkdownContentView(
                            markdown: markdown,
                            knownTopics: knownTopics,
                            onSelectTopic: { linkedTopic in
                                Task {
                                    if let opened = await store.followTopicLink(linkedTopic) {
                                        currentFileID = opened.fileID
                                        displayMode = .formatted
                                        historyExpanded = false
                                    }
                                }
                            }
                        )
                        .padding(.vertical, 4)
                        .accessibilityIdentifier("wiki-formatted-body")
                    }
                }
            }

            if topic.currentVersion > 1 {
                Section {
                    DisclosureGroup("History (\(topic.versionLabel))", isExpanded: $historyExpanded) {
                        ForEach((1...topic.currentVersion).reversed(), id: \.self) { version in
                            Button {
                                Task {
                                    await store.openTopic(fileID: topic.fileID, version: version)
                                }
                            } label: {
                                HStack {
                                    Text(verbatim: version == topic.currentVersion ? "v\(version) · latest" : "v\(version)")
                                        .foregroundStyle(.primary)
                                    Spacer()
                                    if version == viewingVersion {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(.tint)
                                    }
                                }
                                .frame(minHeight: 44)
                            }
                            .accessibilityIdentifier("wiki-history-v\(version)")
                        }
                    }
                    .accessibilityIdentifier("wiki-history-disclosure")
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable {
            if await store.loadTopics(preserveNotice: true) {
                await store.openTopic(fileID: topic.fileID, version: viewingVersion)
            }
        }
    }
}

private struct WikiMarkdownContentView: View {
    let markdown: String
    let knownTopics: [String]
    let onSelectTopic: (String) -> Void

    private enum Block: Identifiable {
        case heading(id: Int, level: Int, text: String)
        case bullet(id: Int, text: String)
        case codeBlock(id: Int, text: String)
        case paragraph(id: Int, text: String)

        var id: Int {
            switch self {
            case .heading(let id, _, _),
                 .bullet(let id, _),
                 .codeBlock(let id, _),
                 .paragraph(let id, _):
                return id
            }
        }
    }

    private var blocks: [Block] {
        var result: [Block] = []
        var nextID = 0
        let lines = markdown.components(separatedBy: .newlines)
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                i += 1
                continue
            }
            if trimmed.hasPrefix("```") {
                var codeLines: [String] = []
                i += 1
                while i < lines.count && !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    codeLines.append(lines[i])
                    i += 1
                }
                if i < lines.count { i += 1 }
                result.append(.codeBlock(id: nextID, text: codeLines.joined(separator: "\n")))
                nextID += 1
                continue
            }
            if trimmed.hasPrefix("#") {
                let hashes = trimmed.prefix(while: { $0 == "#" }).count
                if hashes <= 6, trimmed.count > hashes, trimmed[trimmed.index(trimmed.startIndex, offsetBy: hashes)] == " " {
                    let headingText = String(trimmed.dropFirst(hashes + 1)).trimmingCharacters(in: .whitespaces)
                    result.append(.heading(id: nextID, level: hashes, text: headingText))
                    nextID += 1
                    i += 1
                    continue
                }
            }
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                result.append(.bullet(id: nextID, text: String(trimmed.dropFirst(2))))
                nextID += 1
                i += 1
                continue
            }
            var paraLines = [trimmed]
            i += 1
            while i < lines.count {
                let next = lines[i].trimmingCharacters(in: .whitespaces)
                if next.isEmpty || next.hasPrefix("#") || next.hasPrefix("```") || next.hasPrefix("- ") || next.hasPrefix("* ") {
                    break
                }
                paraLines.append(next)
                i += 1
            }
            result.append(.paragraph(id: nextID, text: paraLines.joined(separator: " ")))
            nextID += 1
        }
        return result
    }

    private func linkedTopics(in text: String) -> [String] {
        var found: [String] = []
        var seen: Set<String> = []
        // Scan inline code spans and outside prose using WikiRules.linkSegments
        let parts = text.components(separatedBy: "`")
        for (index, part) in parts.enumerated() {
            let isCodeSpan = (index % 2 == 1) && (index < parts.count - 1)
            let segments = WikiRules.linkSegments(
                in: part,
                topics: knownTopics,
                codeSpan: isCodeSpan ? part : nil
            )
            for seg in segments {
                if let topic = seg.topic, !seen.contains(topic) {
                    seen.insert(topic)
                    found.append(topic)
                }
            }
        }
        return found
    }

    private func renderedAttributed(_ text: String) -> AttributedString {
        if let parsed = try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return parsed
        }
        return AttributedString(text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(blocks) { block in
                switch block {
                case .heading(_, let level, let text):
                    Text(renderedAttributed(text))
                        .font(level == 1 ? .title3.weight(.bold) : .headline)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                case .bullet(_, let text):
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("•")
                                .foregroundStyle(.secondary)
                            Text(renderedAttributed(text))
                                .font(.body)
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                        topicLinkChips(linkedTopics(in: text))
                    }
                case .codeBlock(_, let text):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(verbatim: text)
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(.primary)
                            .textSelection(.enabled)
                            .padding(10)
                    }
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                case .paragraph(_, let text):
                    VStack(alignment: .leading, spacing: 4) {
                        Text(renderedAttributed(text))
                            .font(.body)
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                        topicLinkChips(linkedTopics(in: text))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func topicLinkChips(_ topics: [String]) -> some View {
        if !topics.isEmpty {
            HStack(spacing: 8) {
                ForEach(topics, id: \.self) { topic in
                    Button {
                        onSelectTopic(topic)
                    } label: {
                        Label(topic, systemImage: "book.pages")
                            .font(.footnote.weight(.semibold))
                            .padding(.horizontal, 10)
                            .frame(minHeight: 36)
                            .background(Color(.tertiarySystemFill), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("wiki-topic-link-\(topic)")
                }
            }
            .padding(.top, 2)
        }
    }
}

private struct WikiEditSheet: View {
    let topic: String
    let baseVersion: Int
    let isSaving: Bool
    let errorMessage: String?
    let onSubmit: (String) async -> Void

    @State private var markdown: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    init(
        topic: String,
        baseVersion: Int,
        initialMarkdown: String,
        isSaving: Bool,
        errorMessage: String?,
        onSubmit: @escaping (String) async -> Void
    ) {
        self.topic = topic
        self.baseVersion = baseVersion
        self.isSaving = isSaving
        self.errorMessage = errorMessage
        self.onSubmit = onSubmit
        _markdown = State(initialValue: initialMarkdown)
    }

    private var errorForeground: Color {
        colorScheme == .dark
            ? Color(red: 1.00, green: 0.48, blue: 0.46)
            : Color(red: 0.72, green: 0.08, blue: 0.08)
    }

    private var canSubmit: Bool {
        !isSaving && !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section {
                        Text(verbatim: errorMessage)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(errorForeground)
                            .accessibilityIdentifier("wiki-edit-error")
                    }
                }

                Section("v\(baseVersion) → v\(baseVersion + 1)") {
                    TextEditor(text: $markdown)
                        .font(.system(.body, design: .monospaced))
                        .frame(minHeight: 260)
                        .disabled(isSaving)
                        .accessibilityLabel("Wiki page Markdown")
                        .accessibilityIdentifier("wiki-edit-markdown")
                }
            }
            .navigationTitle("Edit \(topic)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        let body = markdown
                        Task { await onSubmit(body) }
                    }
                    .disabled(!canSubmit)
                    .accessibilityIdentifier("wiki-edit-save")
                }
            }
        }
    }
}

private struct WikiCreateSheet: View {
    let isSaving: Bool
    let errorMessage: String?
    let onSubmit: (String, String) async -> Void

    @State private var topic = ""
    @State private var markdown = ""
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    private var errorForeground: Color {
        colorScheme == .dark
            ? Color(red: 1.00, green: 0.48, blue: 0.46)
            : Color(red: 0.72, green: 0.08, blue: 0.08)
    }

    private var canSubmit: Bool {
        !isSaving
            && WikiRules.canonicalTopic(topic) != nil
            && !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section {
                        Text(verbatim: errorMessage)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(errorForeground)
                            .accessibilityIdentifier("wiki-create-error")
                    }
                }

                Section("Topic") {
                    TextField("e.g. deploy-runbook", text: $topic)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(isSaving)
                        .accessibilityIdentifier("wiki-create-topic")
                }

                Section("Markdown") {
                    TextEditor(text: $markdown)
                        .font(.system(.body, design: .monospaced))
                        .frame(minHeight: 220)
                        .disabled(isSaving)
                        .accessibilityLabel("Wiki page Markdown")
                        .accessibilityIdentifier("wiki-create-markdown")
                }
            }
            .navigationTitle("New wiki page")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Create") {
                        let t = topic
                        let m = markdown
                        Task { await onSubmit(t, m) }
                    }
                    .disabled(!canSubmit)
                    .accessibilityIdentifier("wiki-create-submit")
                }
            }
        }
    }
}
