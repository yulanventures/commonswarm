import SwiftUI

struct TodoDetailView: View {
    let api: TodoAPI
    let workspaceID: UUID
    let summary: TodoSummary
    let directory: TodoDirectory
    var onChanged: (() async -> Void)?

    @StateObject private var viewModel = TodoDetailViewModel()
    @State private var commentText = ""
    @State private var selectedMentions: Set<TodoParty> = []
    @State private var showingMentionPicker = false
    @Environment(\.colorScheme) private var colorScheme

    private var primaryBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.08, green: 0.40, blue: 0.80)
            : Color(red: 0.00, green: 0.35, blue: 0.80)
    }

    private var secondaryBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.22, green: 0.22, blue: 0.24)
            : Color(red: 0.90, green: 0.90, blue: 0.92)
    }

    private var secondaryForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.94, green: 0.94, blue: 0.96)
            : Color(red: 0.11, green: 0.11, blue: 0.12)
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

    var body: some View {
        Group {
            if let detail = viewModel.detail {
                detailList(detail)
            } else if viewModel.failure == .notFound {
                ContentUnavailableView("To-do not found", systemImage: "checkmark.circle")
            } else if let failure = viewModel.failure {
                RetryView(text: failure.message(subject: "this to-do"), action: load)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView("Loading to-do…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("To-do")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !viewModel.isReadOnly, viewModel.detail != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") {
                        viewModel.beginEdit()
                    }
                    .disabled(viewModel.isMutating)
                    .accessibilityIdentifier("todo-edit-button")
                }
            }
        }
        .sheet(isPresented: $viewModel.showingAssignSheet) {
            if let detail = viewModel.detail {
                TodoAssignSheet(
                    directory: directory,
                    currentAssignee: detail.assignee,
                    isSaving: viewModel.isMutating
                ) { chosen in
                    Task {
                        if await viewModel.assign(to: chosen, api: api, workspaceID: workspaceID) {
                            await onChanged?()
                        }
                    }
                }
            }
        }
        .sheet(item: $viewModel.activeEditSession) { editSession in
            TodoEditSheet(
                initialTitle: editSession.initialTitle,
                initialNotes: editSession.initialNotes,
                initialDueOn: editSession.initialDueOn,
                isSaving: viewModel.isMutating,
                errorMessage: viewModel.actionError
            ) { title, notes, dueOn in
                if await viewModel.updateDetails(
                    session: editSession,
                    title: title,
                    notes: notes,
                    dueOn: dueOn,
                    api: api,
                    workspaceID: workspaceID
                ) {
                    await onChanged?()
                }
            }
        }
        .sheet(isPresented: $showingMentionPicker) {
            TodoMentionPickerSheet(
                directory: directory,
                selected: $selectedMentions
            )
        }
        .task { await load() }
        .onDisappear { viewModel.retire() }
    }

    private func detailList(_ detail: TodoDetail) -> some View {
        let assigneeName = directory.assigneeLabel(detail.assignee)
        let dueText = TodoCalendarDate.formatDate(detail.due_on)
        let notes = detail.notes.trimmingCharacters(in: .whitespacesAndNewlines)

        return List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text(verbatim: detail.title)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)

                    HStack(spacing: 8) {
                        TodoStateBadge(state: detail.state)
                            .accessibilityIdentifier("todo-detail-state-badge")
                        if let position = detail.queue_position, detail.state == .open {
                            Text("#\(position) in line")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let status = viewModel.statusMessage {
                        Text(verbatim: status)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(statusForeground)
                            .accessibilityIdentifier("todo-detail-status")
                    }

                    if let error = viewModel.actionError {
                        Text(verbatim: error)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(errorForeground)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("todo-detail-error")
                    }

                    if !viewModel.isReadOnly {
                        stateActionsBar(detail)
                    }
                }
                .padding(.vertical, 4)

                if let offer = detail.offer {
                    offerRow(offer)
                }

                if viewModel.isReadOnly {
                    assigneeRowContent(detail: detail, assigneeName: assigneeName)
                } else {
                    Button {
                        viewModel.showingAssignSheet = true
                    } label: {
                        assigneeRowContent(detail: detail, assigneeName: assigneeName)
                    }
                    .buttonStyle(.plain)
                    .disabled(viewModel.isMutating)
                    .accessibilityIdentifier("todo-assign-button")
                }

                if let dueText {
                    LabeledContent("Due") {
                        Text(dueText)
                            .foregroundStyle(.primary)
                    }
                }

                LabeledContent("Added by") {
                    Text(verbatim: directory.actorLabel(detail.created_by))
                        .foregroundStyle(.secondary)
                }

                if let gateLine = gateDescription(detail) {
                    LabeledContent("Start") {
                        Text(verbatim: gateLine)
                            .multilineTextAlignment(.trailing)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if !notes.isEmpty {
                Section("Notes") {
                    Text(verbatim: notes)
                        .font(.body)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .padding(.vertical, 2)
                }
            }

            Section("Comments") {
                if viewModel.comments.isEmpty {
                    Text("No comments yet")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(viewModel.comments) { comment in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(verbatim: directory.actorLabel(comment.author))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.primary)
                                Spacer(minLength: 8)
                                if let stamp = TodoCalendarDate.formatTimestamp(comment.created_at) {
                                    Text(stamp)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Text(verbatim: comment.body)
                                .font(.body)
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                        .padding(.vertical, 2)
                    }
                }

                if viewModel.nextCommentOffset != nil {
                    Button {
                        Task { await viewModel.loadMoreComments(api: api, workspaceID: workspaceID) }
                    } label: {
                        HStack {
                            if viewModel.isLoadingMoreComments {
                                ProgressView()
                            }
                            Text(viewModel.isLoadingMoreComments ? "Loading…" : "Load more comments")
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .disabled(viewModel.isLoadingMoreComments)
                    .accessibilityIdentifier("todo-load-more-comments")
                }

                if !viewModel.isReadOnly {
                    commentComposer
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await load() }
    }

    @ViewBuilder
    private func stateActionsBar(_ detail: TodoDetail) -> some View {
        HStack(spacing: 10) {
            if detail.state.isOpen {
                Button {
                    Task {
                        if await viewModel.setState(.done, api: api, workspaceID: workspaceID) {
                            await onChanged?()
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .accessibilityHidden(true)
                        Text("Mark done")
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(primaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isMutating)
                .accessibilityIdentifier("todo-mark-done-button")

                if detail.state == .open {
                    Button {
                        Task {
                            if await viewModel.setState(.doing, api: api, workspaceID: workspaceID) {
                                await onChanged?()
                            }
                        }
                    } label: {
                        Text("Start")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(secondaryForeground)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 44)
                            .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(viewModel.isMutating)
                    .accessibilityIdentifier("todo-start-button")
                }

                Menu {
                    Button("Drop to-do", role: .destructive) {
                        Task {
                            if await viewModel.setState(.dropped, api: api, workspaceID: workspaceID) {
                                await onChanged?()
                            }
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.title3)
                        .foregroundStyle(secondaryForeground)
                        .frame(width: 44, height: 44)
                }
                .disabled(viewModel.isMutating)
                .accessibilityLabel("More actions")
                .accessibilityIdentifier("todo-more-actions")
            } else {
                Button {
                    Task {
                        if await viewModel.setState(.open, api: api, workspaceID: workspaceID) {
                            await onChanged?()
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.uturn.backward.circle")
                            .accessibilityHidden(true)
                        Text("Reopen")
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(secondaryForeground)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isMutating)
                .accessibilityIdentifier("todo-reopen-button")
            }
        }
        .padding(.top, 4)
    }

    @ViewBuilder
    private func offerRow(_ offer: TodoOfferSummary) -> some View {
        let targetName = directory.assigneeLabel(offer.to)
        let isDecider = offer.decider_user_id == directory.viewerUserID

        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: "Work request for \(targetName)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)

            if !viewModel.isReadOnly {
                HStack(spacing: 10) {
                    if isDecider {
                        Button {
                            Task {
                                if await viewModel.answerOffer(.accept, api: api, workspaceID: workspaceID) {
                                    await onChanged?()
                                }
                            }
                        } label: {
                            Text("Accept")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 14)
                                .frame(minHeight: 44)
                                .background(primaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(viewModel.isMutating)
                        .accessibilityIdentifier("todo-offer-accept")

                        Button {
                            Task {
                                if await viewModel.answerOffer(.decline, api: api, workspaceID: workspaceID) {
                                    await onChanged?()
                                }
                            }
                        } label: {
                            Text("Decline")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(secondaryForeground)
                                .padding(.horizontal, 14)
                                .frame(minHeight: 44)
                                .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(viewModel.isMutating)
                        .accessibilityIdentifier("todo-offer-decline")
                    } else {
                        Button {
                            Task {
                                if await viewModel.answerOffer(.withdraw, api: api, workspaceID: workspaceID) {
                                    await onChanged?()
                                }
                            }
                        } label: {
                            Text("Withdraw request")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(secondaryForeground)
                                .padding(.horizontal, 14)
                                .frame(minHeight: 44)
                                .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(viewModel.isMutating)
                        .accessibilityIdentifier("todo-offer-withdraw")
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func assigneeRowContent(detail: TodoDetail, assigneeName: String) -> some View {
        LabeledContent("Assigned to") {
            HStack(spacing: 5) {
                if let party = detail.assignee {
                    Image(systemName: directory.assigneeSymbol(party))
                        .accessibilityHidden(true)
                }
                Text(verbatim: assigneeName)
                    .multilineTextAlignment(.trailing)
                if !viewModel.isReadOnly {
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
            }
            .foregroundStyle(detail.assignee == nil ? .secondary : .primary)
        }
        .frame(minHeight: 44)
    }

    private var commentComposer: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Add a comment…", text: $commentText, axis: .vertical)
                .lineLimit(1...5)
                .disabled(viewModel.isPostingComment)
                .accessibilityIdentifier("todo-comment-field")

            if !selectedMentions.isEmpty {
                let names = selectedMentions
                    .map { directory.assigneeLabel($0) }
                    .sorted()
                    .joined(separator: ", ")
                Text(verbatim: "Notifies: \(names)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 10) {
                Button {
                    showingMentionPicker = true
                } label: {
                    Label(selectedMentions.isEmpty ? "Tag" : "Tagged (\(selectedMentions.count))", systemImage: "at")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(secondaryForeground)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isPostingComment)
                .accessibilityIdentifier("todo-comment-tag-button")

                Spacer()

                Button {
                    let text = commentText
                    let mentions = Array(selectedMentions)
                    Task {
                        if await viewModel.postComment(
                            body: text,
                            mentions: mentions,
                            api: api,
                            workspaceID: workspaceID
                        ) {
                            commentText = ""
                            selectedMentions.removeAll()
                            await onChanged?()
                        }
                    }
                } label: {
                    Text(viewModel.isPostingComment ? "Posting…" : "Post")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .background(primaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isPostingComment || TodoRules.cleanBody(commentText).isEmpty)
                .accessibilityIdentifier("todo-comment-post-button")
            }
        }
        .padding(.vertical, 4)
    }

    private func gateDescription(_ detail: TodoDetail) -> String? {
        guard let gate = detail.gate else { return nil }
        switch gate.kind {
        case "hold":
            if let note = gate.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
                return "On hold: \(note)"
            }
            return "On hold"
        case "after":
            return detail.gate_clear ? "Dependency cleared" : "Waiting on another to-do"
        case "at":
            if let at = gate.at, let formatted = TodoCalendarDate.formatTimestamp(at) {
                return "Starts \(formatted)"
            }
            return "Starts at a set time"
        default:
            return nil
        }
    }

    private func load() async {
        await viewModel.load(api: api, workspaceID: workspaceID, todoID: summary.todo_id)
    }
}

private struct TodoAssignSheet: View {
    let directory: TodoDirectory
    let currentAssignee: TodoParty?
    let isSaving: Bool
    let onSelect: (TodoParty?) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        onSelect(nil)
                    } label: {
                        HStack {
                            Text("Unassigned")
                                .foregroundStyle(.primary)
                            Spacer()
                            if currentAssignee == nil {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(.tint)
                            }
                        }
                        .frame(minHeight: 44)
                    }
                    .disabled(isSaving)
                    .accessibilityIdentifier("todo-assign-unassigned")
                }

                if !directory.sortedPeople.isEmpty {
                    Section("People") {
                        ForEach(directory.sortedPeople) { entry in
                            Button {
                                onSelect(entry.party)
                            } label: {
                                HStack {
                                    Label(entry.label, systemImage: "person.crop.circle")
                                        .foregroundStyle(.primary)
                                    Spacer()
                                    if currentAssignee == entry.party {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(.tint)
                                    }
                                }
                                .frame(minHeight: 44)
                            }
                            .disabled(isSaving)
                        }
                    }
                }

                if !directory.sortedAgents.isEmpty {
                    Section("Agents") {
                        ForEach(directory.sortedAgents) { entry in
                            Button {
                                onSelect(entry.party)
                            } label: {
                                HStack {
                                    Label(entry.label, systemImage: "cpu")
                                        .foregroundStyle(.primary)
                                    Spacer()
                                    if currentAssignee == entry.party {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(.tint)
                                    }
                                }
                                .frame(minHeight: 44)
                            }
                            .disabled(isSaving)
                        }
                    }
                }
            }
            .navigationTitle("Assign to")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
            }
        }
    }
}

private struct TodoEditSheet: View {
    let isSaving: Bool
    let errorMessage: String?
    let onSubmit: (String, String, String?) async -> Void

    @State private var title: String
    @State private var notes: String
    @State private var hasDueDate: Bool
    @State private var dueDate: Date
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    init(
        initialTitle: String,
        initialNotes: String,
        initialDueOn: String?,
        isSaving: Bool,
        errorMessage: String?,
        onSubmit: @escaping (String, String, String?) async -> Void
    ) {
        self.isSaving = isSaving
        self.errorMessage = errorMessage
        self.onSubmit = onSubmit
        _title = State(initialValue: initialTitle)
        _notes = State(initialValue: initialNotes)
        if let parsed = TodoCalendarDate.parseLocal(initialDueOn) {
            _hasDueDate = State(initialValue: true)
            _dueDate = State(initialValue: parsed)
        } else {
            _hasDueDate = State(initialValue: false)
            _dueDate = State(initialValue: Date())
        }
    }

    private var errorForeground: Color {
        colorScheme == .dark
            ? Color(red: 1.00, green: 0.48, blue: 0.46)
            : Color(red: 0.72, green: 0.08, blue: 0.08)
    }

    private var canSubmit: Bool {
        !isSaving && !TodoRules.cleanTitle(title).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section {
                        Text(verbatim: errorMessage)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(errorForeground)
                    }
                }
                Section("Title") {
                    TextField("Title", text: $title)
                        .disabled(isSaving)
                        .accessibilityIdentifier("todo-edit-title")
                }
                Section("Notes") {
                    TextEditor(text: $notes)
                        .frame(minHeight: 96)
                        .disabled(isSaving)
                        .accessibilityLabel("Notes")
                        .accessibilityIdentifier("todo-edit-notes")
                }
                Section {
                    Toggle("Due date", isOn: $hasDueDate)
                        .disabled(isSaving)
                    if hasDueDate {
                        DatePicker("Due", selection: $dueDate, displayedComponents: .date)
                            .disabled(isSaving)
                    }
                }
            }
            .navigationTitle("Edit to-do")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") {
                        let dueStr = hasDueDate ? TodoCalendarDate.formatLocal(dueDate) : nil
                        Task { await onSubmit(title, notes, dueStr) }
                    }
                    .disabled(!canSubmit)
                    .accessibilityIdentifier("todo-edit-submit")
                }
            }
        }
    }
}

private struct TodoMentionPickerSheet: View {
    let directory: TodoDirectory
    @Binding var selected: Set<TodoParty>
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if !directory.sortedPeople.isEmpty {
                    Section("People") {
                        ForEach(directory.sortedPeople) { entry in
                            mentionRow(entry, symbol: "person.crop.circle")
                        }
                    }
                }
                if !directory.sortedAgents.isEmpty {
                    Section("Agents") {
                        ForEach(directory.sortedAgents) { entry in
                            mentionRow(entry, symbol: "cpu")
                        }
                    }
                }
            }
            .navigationTitle("Tag in comment")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func mentionRow(_ entry: TodoDirectoryEntry, symbol: String) -> some View {
        let isSelected = selected.contains(entry.party)
        return Button {
            if isSelected {
                selected.remove(entry.party)
            } else if selected.count < TodoRules.maxMentions {
                selected.insert(entry.party)
            }
        } label: {
            HStack {
                Label(entry.label, systemImage: symbol)
                    .foregroundStyle(.primary)
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                }
            }
            .frame(minHeight: 44)
        }
    }
}
