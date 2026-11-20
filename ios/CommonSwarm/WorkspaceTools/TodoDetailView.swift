import SwiftUI

struct TodoDetailView: View {
    let api: TodoAPI
    let workspaceID: UUID
    let summary: TodoSummary
    let directory: TodoDirectory
    @StateObject private var viewModel = TodoDetailViewModel()

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
        .task { await load() }
    }

    private func detailList(_ detail: TodoDetail) -> some View {
        let assigneeName = directory.assigneeLabel(detail.assignee)
        let dueText = TodoCalendarDate.formatDate(detail.due_on)
        let notes = detail.notes.trimmingCharacters(in: .whitespacesAndNewlines)

        return List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text(detail.title)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)

                    HStack(spacing: 8) {
                        TodoStateBadge(state: detail.state)
                        if let position = detail.queue_position, detail.state == .open {
                            Text("#\(position) in line")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.vertical, 4)

                LabeledContent("Assigned to") {
                    HStack(spacing: 5) {
                        if let party = detail.assignee {
                            Image(systemName: directory.assigneeSymbol(party))
                                .accessibilityHidden(true)
                        }
                        Text(assigneeName)
                            .multilineTextAlignment(.trailing)
                    }
                    .foregroundStyle(detail.assignee == nil ? .secondary : .primary)
                }

                if let dueText {
                    LabeledContent("Due") {
                        Text(dueText)
                            .foregroundStyle(.primary)
                    }
                }

                LabeledContent("Added by") {
                    Text(directory.actorLabel(detail.created_by))
                        .foregroundStyle(.secondary)
                }

                if let gateLine = gateDescription(detail) {
                    LabeledContent("Start") {
                        Text(gateLine)
                            .multilineTextAlignment(.trailing)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if !notes.isEmpty {
                Section("Notes") {
                    Text(notes)
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
                                Text(directory.actorLabel(comment.author))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.primary)
                                Spacer(minLength: 8)
                                if let stamp = TodoCalendarDate.formatTimestamp(comment.created_at) {
                                    Text(stamp)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Text(comment.body)
                                .font(.body)
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await load() }
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
