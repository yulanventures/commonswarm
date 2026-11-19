import SwiftUI

struct WaitingTodoCardView: View {
    let item: WaitingTodoItem
    let scope: WaitingScope
    let isPending: Bool
    let failure: WaitingTodoFailure?
    let onMarkDone: () -> Void
    let onRetry: () -> Void
    let onOpen: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    private var primaryButtonBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.08, green: 0.40, blue: 0.80)
            : Color(red: 0.00, green: 0.35, blue: 0.80)
    }

    private var secondaryButtonForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.95, green: 0.95, blue: 0.97)
            : Color(red: 0.11, green: 0.11, blue: 0.12)
    }

    private var secondaryButtonBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.22, green: 0.22, blue: 0.24)
            : Color(red: 0.92, green: 0.92, blue: 0.94)
    }

    private var errorForeground: Color {
        colorScheme == .dark
            ? Color(red: 1.00, green: 0.48, blue: 0.46)
            : Color(red: 0.72, green: 0.08, blue: 0.08)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Image(systemName: "checklist")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    Text(item.reason.label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    if let due = item.formattedDue {
                        Text(due)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if let location = item.locationText(for: scope) {
                    Text(location)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Text(item.title)
                .font(.headline)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)

            if let failure {
                Text(failure.message)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(errorForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 10) {
                if item.canMarkDone {
                    if let failure, failure.retryable && !isPending {
                        Button(action: onRetry) {
                            Text("Retry")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 16)
                                .frame(minWidth: 88, minHeight: 44)
                                .background(primaryButtonBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("waiting-todo-retry-\(item.id.uuidString.lowercased())")
                    } else {
                        Button(action: onMarkDone) {
                            HStack(spacing: 6) {
                                if isPending {
                                    ProgressView()
                                        .tint(.white)
                                }
                                Text(isPending ? "Saving…" : "Mark done")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                            }
                            .padding(.horizontal, 16)
                            .frame(minWidth: 108, minHeight: 44)
                            .background(
                                primaryButtonBackground.opacity(isPending ? 0.65 : 1),
                                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(isPending)
                        .accessibilityIdentifier("waiting-todo-done-\(item.id.uuidString.lowercased())")
                    }
                }

                Button(action: onOpen) {
                    Text("Open")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(secondaryButtonForeground)
                        .padding(.horizontal, 16)
                        .frame(minWidth: 76, minHeight: 44)
                        .background(secondaryButtonBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("waiting-todo-open-\(item.id.uuidString.lowercased())")

                Spacer(minLength: 0)
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct WaitingTodoDetailView: View {
    let item: WaitingTodoItem
    let api: WaitingOnYouAPI
    let onMarkedDone: (UUID) -> Void

    @State private var detail: WaitingTodoDetail?
    @State private var loading = true
    @State private var loadFailed = false
    @State private var markingDone = false
    @State private var markError: String?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    private var primaryButtonBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.08, green: 0.40, blue: 0.80)
            : Color(red: 0.00, green: 0.35, blue: 0.80)
    }

    private var errorForeground: Color {
        colorScheme == .dark
            ? Color(red: 1.00, green: 0.48, blue: 0.46)
            : Color(red: 0.72, green: 0.08, blue: 0.08)
    }

    var body: some View {
        Group {
            if loading && detail == nil {
                ProgressView("Loading to-do…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if loadFailed && detail == nil {
                RetryView(text: "Couldn’t load to-do") {
                    await load()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let detail {
                List {
                    Section {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(detail.title)
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                            WaitingTodoStatePill(state: detail.state)
                        }
                        .padding(.vertical, 4)

                        LabeledContent("Assigned to") {
                            HStack(spacing: 5) {
                                if detail.assigneeName != "Unassigned" {
                                    Image(systemName: detail.assigneeIsAgent ? "cpu" : "person.crop.circle")
                                        .foregroundStyle(.secondary)
                                        .accessibilityHidden(true)
                                }
                                Text(detail.assigneeName)
                                    .foregroundStyle(detail.assigneeName == "Unassigned" ? .secondary : .primary)
                            }
                        }

                        if let due = detail.formattedDue {
                            LabeledContent("Due") {
                                Text(due.replacingOccurrences(of: "Due ", with: ""))
                            }
                        }

                        if item.canMarkDone && (detail.state == "open" || detail.state == "doing") {
                            VStack(alignment: .leading, spacing: 8) {
                                if let markError {
                                    Text(markError)
                                        .font(.footnote.weight(.medium))
                                        .foregroundStyle(errorForeground)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Button {
                                    Task { await markDone() }
                                } label: {
                                    HStack(spacing: 6) {
                                        if markingDone { ProgressView().tint(.white) }
                                        Text(markingDone ? "Saving…" : (markError != nil ? "Retry" : "Mark done"))
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(.white)
                                    }
                                    .frame(maxWidth: .infinity, minHeight: 44)
                                    .background(
                                        primaryButtonBackground.opacity(markingDone ? 0.65 : 1),
                                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    )
                                }
                                .buttonStyle(.plain)
                                .disabled(markingDone)
                            }
                            .padding(.vertical, 4)
                        }
                    }

                    if let notes = detail.notes, !notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Section("Notes") {
                            Text(notes)
                                .font(.body)
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    if !detail.comments.isEmpty {
                        Section("Comments") {
                            ForEach(detail.comments) { comment in
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(spacing: 6) {
                                        Image(systemName: comment.authorIsAgent ? "cpu" : "person.crop.circle")
                                            .foregroundStyle(.secondary)
                                            .accessibilityHidden(true)
                                        Text(comment.authorName)
                                            .font(.subheadline.weight(.semibold))
                                        Spacer()
                                        let stamp = WaitingChoiceRules.formatRelativeTime(comment.createdAt)
                                        if !stamp.isEmpty {
                                            Text(stamp)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Text(comment.body)
                                        .font(.body)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                .padding(.vertical, 2)
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
        .navigationTitle("To-do")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await load()
        }
    }

    private func load() async {
        loading = true
        loadFailed = false
        do {
            detail = try await api.readTodoDetail(workspaceID: item.workspaceID, todoID: item.id)
        } catch {
            if !Task.isCancelled { loadFailed = true }
        }
        loading = false
    }

    private func markDone() async {
        guard !markingDone else { return }
        markingDone = true
        markError = nil
        let outcome = await api.markTodoDone(workspaceID: item.workspaceID, todoID: item.id)
        markingDone = false
        switch outcome {
        case .done:
            onMarkedDone(item.id)
            dismiss()
        case .failed(let message, _):
            markError = message
        }
    }
}

private struct WaitingTodoStatePill: View {
    let state: String
    @Environment(\.colorScheme) private var colorScheme

    private var label: String {
        switch state {
        case "doing": "Doing"
        case "done": "Done"
        case "dropped": "Dropped"
        default: "Open"
        }
    }

    private var foreground: Color {
        switch state {
        case "doing":
            return colorScheme == .dark ? Color(red: 0.49, green: 0.75, blue: 1.00) : Color(red: 0.00, green: 0.32, blue: 0.70)
        case "done":
            return colorScheme == .dark ? Color(red: 0.44, green: 0.87, blue: 0.56) : Color(red: 0.07, green: 0.42, blue: 0.17)
        case "dropped":
            return colorScheme == .dark ? Color(red: 0.70, green: 0.71, blue: 0.75) : Color(red: 0.33, green: 0.35, blue: 0.39)
        default:
            return colorScheme == .dark ? Color(red: 0.90, green: 0.91, blue: 0.94) : Color(red: 0.15, green: 0.17, blue: 0.21)
        }
    }

    private var background: Color {
        switch state {
        case "doing":
            return colorScheme == .dark ? Color(red: 0.08, green: 0.20, blue: 0.32) : Color(red: 0.89, green: 0.94, blue: 1.00)
        case "done":
            return colorScheme == .dark ? Color(red: 0.08, green: 0.24, blue: 0.13) : Color(red: 0.87, green: 0.96, blue: 0.90)
        case "dropped":
            return colorScheme == .dark ? Color(red: 0.20, green: 0.21, blue: 0.23) : Color(red: 0.92, green: 0.93, blue: 0.95)
        default:
            return colorScheme == .dark ? Color(red: 0.24, green: 0.25, blue: 0.28) : Color(red: 0.91, green: 0.92, blue: 0.94)
        }
    }

    var body: some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundStyle(foreground)
            .background(background, in: Capsule())
    }
}
