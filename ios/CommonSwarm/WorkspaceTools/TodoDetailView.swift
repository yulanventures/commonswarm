import SwiftUI

struct TodoDetailView: View {
    let api: TodoAPI
    let workspaceID: UUID
    let summary: TodoSummary
    let directory: TodoDirectory
    var onChanged: (() async -> Void)?

    @StateObject private var viewModel = TodoDetailViewModel()
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
            if viewModel.canUpdate {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") {
                        viewModel.beginEdit()
                    }
                    .disabled(viewModel.isMutating)
                    .accessibilityIdentifier("todo-edit-button")
                }
            }
        }
        .sheet(item: $viewModel.activeAssignSession) { assignSession in
            TodoAssignSheet(
                directory: directory,
                currentAssignee: assignSession.currentAssignee,
                isSaving: viewModel.isMutating
            ) { chosen in
                Task {
                    if await viewModel.assign(
                        session: assignSession,
                        to: chosen,
                        api: api,
                        workspaceID: workspaceID
                    ) {
                        await onChanged?()
                    }
                }
            }
            .onDisappear {
                viewModel.dismissAssignSession(assignSession.id)
            }
        }
        .sheet(item: $viewModel.activeEditSession) { editSession in
            TodoEditSheet(
                initialTitle: editSession.initialTitle,
                initialNotes: editSession.initialNotes,
                initialDueOn: editSession.initialDueOn,
                unsentDraft: viewModel.conflictDraft,
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
            .onDisappear {
                viewModel.dismissEditSession(editSession.id)
            }
        }
        .sheet(isPresented: $viewModel.showingMentionPicker) {
            TodoMentionPickerSheet(
                directory: directory,
                selected: $viewModel.commentDraftMentions
            )
        }
        .task { await load() }
        .onAppear { viewModel.activate() }
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

                    if let unsent = viewModel.conflictDraft {
                        unsentEditCard(unsent)
                    }

                    let pendingRetries = viewModel.eligiblePendingRetries(viewerUserID: directory.viewerUserID)
                    if !pendingRetries.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(pendingRetries) { item in
                                Button(item.label) {
                                    Task {
                                        if await viewModel.retryPending(item, api: api, workspaceID: workspaceID) {
                                            await onChanged?()
                                        }
                                    }
                                }
                                .font(.subheadline.weight(.semibold))
                                .disabled(viewModel.isMutating || viewModel.isPostingComment)
                                .accessibilityIdentifier("todo-retry-\(item.commandID.uuidString.lowercased())")
                            }
                        }
                    }

                    if viewModel.canUpdate {
                        stateActionsBar(detail)
                    }
                }
                .padding(.vertical, 4)

                if let offer = detail.offer {
                    offerRow(detail: detail, offer: offer)
                }

                if viewModel.canUpdate {
                    Button {
                        viewModel.beginAssign()
                    } label: {
                        assigneeRowContent(detail: detail, assigneeName: assigneeName)
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                    .disabled(viewModel.isMutating)
                    .accessibilityIdentifier("todo-assign-button")
                } else {
                    assigneeRowContent(detail: detail, assigneeName: assigneeName)
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

                if viewModel.canCreateComment {
                    commentComposer
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await load() }
    }

    @ViewBuilder
    private func stateActionsBar(_ detail: TodoDetail) -> some View {
        let displayedID = detail.todo_id
        let displayedVersion = detail.version

        HStack(spacing: 10) {
            if detail.state.isOpen {
                Button {
                    Task {
                        if await viewModel.setState(.done, todoID: displayedID, baseVersion: displayedVersion, api: api, workspaceID: workspaceID) {
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

                if viewModel.canStart(detail, viewerUserID: directory.viewerUserID) {
                    Button {
                        Task {
                            if await viewModel.setState(.doing, todoID: displayedID, baseVersion: displayedVersion, api: api, workspaceID: workspaceID) {
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
                            if await viewModel.setState(.dropped, todoID: displayedID, baseVersion: displayedVersion, api: api, workspaceID: workspaceID) {
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
                        if await viewModel.setState(.open, todoID: displayedID, baseVersion: displayedVersion, api: api, workspaceID: workspaceID) {
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
    private func offerRow(detail: TodoDetail, offer: TodoOfferSummary) -> some View {
        let targetName = directory.assigneeLabel(offer.to)
        let displayedTodoID = detail.todo_id
        let displayedOfferID = offer.offer_id
        let canDecide = viewModel.canAcceptOrDeclineOffer(offer, viewerUserID: directory.viewerUserID)
        let canWithdraw = viewModel.canWithdrawOffer(offer, viewerUserID: directory.viewerUserID)

        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: "Work request for \(targetName)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)

            if canDecide || canWithdraw {
                HStack(spacing: 10) {
                    if canDecide {
                        Button {
                            Task {
                                if await viewModel.answerOffer(.accept, todoID: displayedTodoID, offerID: displayedOfferID, api: api, workspaceID: workspaceID) {
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
                                if await viewModel.answerOffer(.decline, todoID: displayedTodoID, offerID: displayedOfferID, api: api, workspaceID: workspaceID) {
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
                    }

                    if canWithdraw {
                        Button {
                            Task {
                                if await viewModel.answerOffer(.withdraw, todoID: displayedTodoID, offerID: displayedOfferID, api: api, workspaceID: workspaceID) {
                                    await onChanged?()
                                }
                            }
                        } label: {
                            Text("Withdraw")
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

    private func unsentEditCard(_ draft: TodoConflictDraft) -> some View {
        let edited = draft.editedKeys
        return VStack(alignment: .leading, spacing: 8) {
            Text("Your unsent changes")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
            if edited.contains(.title) {
                Text(verbatim: "Title: \(draft.editedTitle)")
                    .font(.footnote)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if edited.contains(.notes) {
                let notesDisplay = draft.editedNotes.isEmpty ? "(cleared)" : draft.editedNotes
                Text(verbatim: "Notes: \(notesDisplay)")
                    .font(.footnote)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if edited.contains(.dueOn) {
                let dueDisplay = draft.editedDueOn.flatMap { TodoCalendarDate.formatDate($0) } ?? "(cleared)"
                Text(verbatim: "Due: \(dueDisplay)")
                    .font(.footnote)
                    .foregroundStyle(.primary)
            }
            HStack(spacing: 10) {
                if viewModel.canUpdate {
                    Button {
                        viewModel.beginEdit()
                    } label: {
                        Text("Review in Edit")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 44)
                            .background(primaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(viewModel.isMutating)
                    .accessibilityIdentifier("todo-conflict-edit-button")
                }
                Button {
                    viewModel.dismissConflictDraft()
                } label: {
                    Text("Discard")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(secondaryForeground)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isMutating)
                .accessibilityIdentifier("todo-conflict-discard-button")
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("todo-unsent-draft-card")
    }

    private func assigneeRowContent(detail: TodoDetail, assigneeName: String) -> some View {
        HStack(spacing: 8) {
            Text("Assigned to")
                .foregroundStyle(.primary)
            Spacer(minLength: 12)
            HStack(spacing: 5) {
                if let party = detail.assignee {
                    Image(systemName: directory.assigneeSymbol(party))
                        .accessibilityHidden(true)
                }
                Text(verbatim: assigneeName)
                    .multilineTextAlignment(.trailing)
                if viewModel.canUpdate {
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
            }
            .foregroundStyle(detail.assignee == nil ? .secondary : .primary)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var commentComposer: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Add a comment…", text: $viewModel.commentDraftText, axis: .vertical)
                .lineLimit(1...5)
                .disabled(viewModel.isPostingComment)
                .accessibilityIdentifier("todo-comment-field")

            if !viewModel.commentDraftMentions.isEmpty {
                let names = TodoRules.canonicalMentions(viewModel.commentDraftMentions)
                    .map { directory.assigneeLabel($0) }
                    .joined(separator: ", ")
                Text(verbatim: "Notifies: \(names)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 10) {
                Button {
                    viewModel.showingMentionPicker = true
                } label: {
                    Label(
                        viewModel.commentDraftMentions.isEmpty ? "Tag" : "Tagged (\(viewModel.commentDraftMentions.count))",
                        systemImage: "at"
                    )
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
                    let text = viewModel.commentDraftText
                    let mentions = TodoRules.canonicalMentions(viewModel.commentDraftMentions)
                    Task {
                        if await viewModel.postComment(
                            body: text,
                            mentions: mentions,
                            api: api,
                            workspaceID: workspaceID
                        ) {
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
                .disabled(!viewModel.canPostCommentDraft)
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
    let unsentDraft: TodoConflictDraft?
    let isSaving: Bool
    let errorMessage: String?
    let onSubmit: (String, String, String?) async -> Void

    @State private var title: String
    @State private var notes: String
    @State private var hasDueDate: Bool
    @State private var dueDate: Date
    @State private var conflictingFields: Set<TodoFieldKey> = []
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    init(
        initialTitle: String,
        initialNotes: String,
        initialDueOn: String?,
        unsentDraft: TodoConflictDraft? = nil,
        isSaving: Bool,
        errorMessage: String?,
        onSubmit: @escaping (String, String, String?) async -> Void
    ) {
        self.unsentDraft = unsentDraft
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
                if let unsentDraft, !unsentDraft.editedKeys.isEmpty {
                    let currentDue = hasDueDate ? TodoCalendarDate.formatLocal(dueDate) : nil
                    let preview = unsentDraft.merge(onto: title, latestNotes: notes, latestDueOn: currentDue)
                    let activeConflicts = conflictingFields.union(preview.conflictingFields)
                    let edited = unsentDraft.editedKeys
                    Section("Your unsent changes") {
                        VStack(alignment: .leading, spacing: 6) {
                            if edited.contains(.title) {
                                Text(verbatim: "Title: \(unsentDraft.editedTitle)" + (activeConflicts.contains(.title) ? " (both edited)" : ""))
                                    .font(.footnote)
                                    .foregroundStyle(.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .textSelection(.enabled)
                            }
                            if edited.contains(.notes) {
                                let notesDisplay = unsentDraft.editedNotes.isEmpty ? "(cleared)" : unsentDraft.editedNotes
                                Text(verbatim: "Notes: \(notesDisplay)" + (activeConflicts.contains(.notes) ? " (both edited)" : ""))
                                    .font(.footnote)
                                    .foregroundStyle(.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .textSelection(.enabled)
                            }
                            if edited.contains(.dueOn) {
                                let dueDisplay = unsentDraft.editedDueOn.flatMap { TodoCalendarDate.formatDate($0) } ?? "(cleared)"
                                Text(verbatim: "Due: \(dueDisplay)" + (activeConflicts.contains(.dueOn) ? " (both edited)" : ""))
                                    .font(.footnote)
                                    .foregroundStyle(.primary)
                            }
                            if !activeConflicts.isEmpty {
                                let names = TodoFieldKey.allCases
                                    .filter { activeConflicts.contains($0) }
                                    .map(\.label)
                                    .joined(separator: ", ")
                                let conflictCopy = unsentDraft.base == nil
                                    ? "Review \(names) manually against the latest version below and copy any wording you want to keep."
                                    : "Both you and a teammate edited \(names). The latest version is kept below so you can compare or copy your text."
                                Text(verbatim: conflictCopy)
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(errorForeground)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .accessibilityIdentifier("todo-edit-conflict-warning")
                            }
                        }
                        .accessibilityIdentifier("todo-edit-unsent-draft")

                        if !preview.appliedFields.isEmpty {
                            Button("Use my unsent changes") {
                                let merged = unsentDraft.merge(
                                    onto: title,
                                    latestNotes: notes,
                                    latestDueOn: currentDue
                                )
                                title = merged.title
                                notes = merged.notes
                                if let mergedDue = merged.dueOn, let parsed = TodoCalendarDate.parseLocal(mergedDue) {
                                    hasDueDate = true
                                    dueDate = parsed
                                } else {
                                    hasDueDate = false
                                }
                                conflictingFields = merged.conflictingFields
                            }
                            .disabled(isSaving)
                            .accessibilityIdentifier("todo-edit-apply-unsent")
                        }
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
