import SwiftUI

struct TodoStateBadge: View {
    let state: TodoState

    var body: some View {
        Text(state.label)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundStyle(foreground)
            .background(background, in: Capsule())
    }

    private var foreground: Color {
        switch state {
        case .open: .primary
        case .doing: .accentColor
        case .done: .green
        case .dropped: .secondary
        }
    }

    private var background: Color {
        switch state {
        case .open: Color(.secondarySystemFill)
        case .doing: Color.accentColor.opacity(0.15)
        case .done: Color.green.opacity(0.15)
        case .dropped: Color(.tertiarySystemFill)
        }
    }
}

private struct TodoRowView: View {
    let todo: TodoSummary
    let directory: TodoDirectory

    var body: some View {
        let assigneeName = directory.assigneeLabel(todo.assignee)
        let dueText = TodoCalendarDate.formatDue(todo.due_on)

        VStack(alignment: .leading, spacing: 6) {
            Text(todo.title)
                .font(.body.weight(.semibold))
                .foregroundStyle(todo.state == .dropped ? .secondary : .primary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    TodoStateBadge(state: todo.state)
                    assigneeLabel(assigneeName)
                }
                VStack(alignment: .leading, spacing: 4) {
                    TodoStateBadge(state: todo.state)
                    assigneeLabel(assigneeName)
                }
            }

            if let dueText {
                HStack(spacing: 4) {
                    Image(systemName: "calendar")
                        .accessibilityHidden(true)
                    Text(dueText)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }

    @ViewBuilder
    private func assigneeLabel(_ name: String) -> some View {
        HStack(spacing: 4) {
            if let party = todo.assignee {
                Image(systemName: directory.assigneeSymbol(party))
                    .accessibilityHidden(true)
            }
            Text(name)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .font(.subheadline)
        .foregroundStyle(todo.assignee == nil ? .secondary : .primary)
    }
}

struct TodoListView: View {
    let api: TodoAPI
    let workspaceID: UUID
    @StateObject private var viewModel: TodoListViewModel

    init(api: TodoAPI, workspaceID: UUID) {
        self.api = api
        self.workspaceID = workspaceID
        _viewModel = StateObject(wrappedValue: TodoListViewModel(viewerUserID: api.viewerUserID))
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Show", selection: $viewModel.filter) {
                ForEach(TodoFilter.allCases) { option in
                    Text(option.label).tag(option)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)

            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("To-dos")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: TodoSummary.self) { summary in
            TodoDetailView(
                api: api,
                workspaceID: workspaceID,
                summary: summary,
                directory: viewModel.directory
            )
        }
        .task(id: viewModel.filter) {
            await load()
        }
    }

    @ViewBuilder
    private var content: some View {
        if let failure = viewModel.failure, viewModel.todos == nil {
            RetryView(text: failure.message(subject: "to-dos"), action: load)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if viewModel.todos == nil {
            ProgressView("Checking to-dos…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let items = viewModel.orderedTodos
            if items.isEmpty {
                ContentUnavailableView(
                    viewModel.filter == .open ? "Nothing open here" : "No to-dos yet",
                    systemImage: "checkmark.circle"
                )
            } else {
                List {
                    if let failure = viewModel.failure {
                        Section {
                            RetryView(text: failure.message(subject: "to-dos"), action: load)
                        }
                    }
                    Section {
                        ForEach(items) { todo in
                            NavigationLink(value: todo) {
                                TodoRowView(todo: todo, directory: viewModel.directory)
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .refreshable { await load() }
            }
        }
    }

    private func load() async {
        await viewModel.load(api: api, workspaceID: workspaceID)
    }
}
