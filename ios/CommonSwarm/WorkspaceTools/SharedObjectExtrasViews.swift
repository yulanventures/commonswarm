import SwiftUI

struct CreateSharedObjectSheet: View {
    @ObservedObject var store: SharedObjectsListStore
    let api: SharedObjectsAPI
    let onCreated: (SharedObjectSummary) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var kind: SharedObjectKind = .list
    @State private var title = ""
    @State private var markdown = ""

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

    private var errorForeground: Color {
        colorScheme == .dark
            ? Color(red: 1.00, green: 0.48, blue: 0.46)
            : Color(red: 0.72, green: 0.08, blue: 0.08)
    }

    private var mutedForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.72, green: 0.72, blue: 0.76)
            : Color(red: 0.34, green: 0.34, blue: 0.37)
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 10) {
                        kindButton(.list, title: "List")
                        kindButton(.doc, title: "Doc")
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Title")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(mutedForeground)
                        TextField(kind == .list ? "List title" : "Document title", text: $title)
                            .textFieldStyle(.plain)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 44)
                            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .accessibilityIdentifier("shared-create-title-field")
                    }

                    if kind == .doc {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Document text")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(mutedForeground)
                            TextEditor(text: $markdown)
                                .font(.body)
                                .frame(minHeight: 140)
                                .padding(8)
                                .scrollContentBackground(.hidden)
                                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .accessibilityLabel("Document text")
                                .accessibilityIdentifier("shared-create-doc-body")
                        }
                    }

                    if let error = store.createError {
                        Text(error)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(errorForeground)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Button {
                        Task {
                            if let created = await store.createObject(
                                title: title,
                                kind: kind,
                                initialMarkdown: markdown,
                                api: api
                            ) {
                                dismiss()
                                onCreated(created)
                            }
                        }
                    } label: {
                        HStack {
                            Spacer()
                            if store.isCreating {
                                ProgressView().tint(.white)
                            } else {
                                Text(store.pendingCreate != nil ? "Retry" : "Create")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.white)
                            }
                            Spacer()
                        }
                        .frame(minHeight: 44)
                        .background(
                            primaryBackground.opacity(trimmedTitle.isEmpty || store.isCreating ? 0.45 : 1),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(trimmedTitle.isEmpty || store.isCreating)
                    .accessibilityIdentifier("shared-create-submit-button")
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("New list or doc")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        store.resetCreateState()
                        dismiss()
                    }
                    .frame(minHeight: 44)
                }
            }
        }
    }

    private func kindButton(_ option: SharedObjectKind, title: String) -> some View {
        let selected = kind == option
        return Button {
            kind = option
            store.resetCreateState()
        } label: {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(selected ? Color.white : secondaryForeground)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(
                    selected ? primaryBackground : secondaryBackground,
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("shared-create-kind-\(option.rawValue)")
    }
}

struct SharedConflictReviewCard: View {
    @ObservedObject var store: SharedObjectDetailStore
    let conflict: SharedConflictDraft
    let api: SharedObjectsAPI

    @Environment(\.colorScheme) private var colorScheme

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

    private var errorForeground: Color {
        colorScheme == .dark
            ? Color(red: 1.00, green: 0.48, blue: 0.46)
            : Color(red: 0.72, green: 0.08, blue: 0.08)
    }

    private var mutedForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.72, green: 0.72, blue: 0.76)
            : Color(red: 0.34, green: 0.34, blue: 0.37)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Review conflicting changes")
                    .font(.headline)
                    .foregroundStyle(errorForeground)
                Text("Compare the current revision with your saved draft before saving.")
                    .font(.footnote)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            snapshotBox(
                heading: "Current revision",
                subtitle: savedByLine(conflict.current),
                token: store.showRevisionIDs ? conflict.current.revision.token : nil,
                content: conflict.current.content
            )

            snapshotBox(
                heading: "Your draft",
                subtitle: "Recovered from your last edit",
                token: nil,
                content: conflict.proposed
            )

            Button {
                store.showOriginalInConflict.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: store.showOriginalInConflict ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.semibold))
                    Text(store.showOriginalInConflict ? "Hide original version" : "Show original version")
                        .font(.footnote.weight(.semibold))
                }
                .foregroundStyle(secondaryForeground)
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("shared-conflict-toggle-base")

            if store.showOriginalInConflict {
                snapshotBox(
                    heading: "Original version",
                    subtitle: savedByLine(conflict.base),
                    token: store.showRevisionIDs ? conflict.base.revision.token : nil,
                    content: conflict.base.content
                )
            }

            Button {
                store.reviewedConflictConfirmed.toggle()
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: store.reviewedConflictConfirmed ? "checkmark.square.fill" : "square")
                        .font(.title3)
                        .foregroundStyle(store.reviewedConflictConfirmed ? primaryBackground : mutedForeground)
                        .accessibilityHidden(true)
                    Text("I reviewed the current revision and my proposed changes")
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(10)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(store.reviewedConflictConfirmed ? .isSelected : [])
            .accessibilityValue(store.reviewedConflictConfirmed ? "Checked" : "Not checked")
            .accessibilityIdentifier("shared-conflict-confirm")

            HStack(spacing: 10) {
                Button {
                    Task { await store.saveReviewedConflict(api: api) }
                } label: {
                    if store.isSaving {
                        ProgressView()
                            .tint(.white)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    } else {
                        Text("Save reviewed changes")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                }
                .background(
                    primaryBackground.opacity(store.reviewedConflictConfirmed && !store.isSaving ? 1 : 0.45),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .buttonStyle(.plain)
                .disabled(!store.reviewedConflictConfirmed || store.isSaving)
                .accessibilityIdentifier("shared-conflict-save")

                Button {
                    Task { await store.load(api: api) }
                } label: {
                    Text("Reload")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(secondaryForeground)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(store.isSaving)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func savedByLine(_ snap: SharedObjectDetail) -> String {
        let savedAt = snap.formattedSavedAt
        return savedAt.isEmpty ? "Saved by \(snap.authorLabel)" : "Saved by \(snap.authorLabel) · \(savedAt)"
    }

    private func snapshotBox(heading: String, subtitle: String, token: String?, content: SharedContent) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(heading)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(mutedForeground)
                .fixedSize(horizontal: false, vertical: true)
            if let token {
                Text(token)
                    .font(.caption2.monospaced())
                    .foregroundStyle(mutedForeground)
            }
            switch content {
            case .list(let items):
                let sorted = items.sorted { $0.order < $1.order }
                if sorted.isEmpty {
                    Text("Empty list")
                        .font(.footnote)
                        .foregroundStyle(mutedForeground)
                } else {
                    ForEach(sorted) { item in
                        HStack(spacing: 8) {
                            Image(systemName: item.checked ? "checkmark.square.fill" : "square")
                                .font(.caption)
                                .foregroundStyle(item.checked ? primaryBackground : mutedForeground)
                                .accessibilityHidden(true)
                            Text(item.text)
                                .font(.footnote)
                                .strikethrough(item.checked)
                                .foregroundStyle(item.checked ? mutedForeground : Color.primary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            case .doc(let markdown):
                let blocks = SharedObjectsRules.parseInertMarkdown(markdown)
                if blocks.isEmpty {
                    Text("Empty document")
                        .font(.footnote)
                        .foregroundStyle(mutedForeground)
                } else {
                    ForEach(blocks) { block in
                        switch block {
                        case .heading(_, _, let text):
                            Text(text).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                        case .bullet(_, let text):
                            Text("• \(text)").font(.footnote).foregroundStyle(.primary)
                        case .numbered(_, let number, let text):
                            Text("\(number) \(text)").font(.footnote).foregroundStyle(.primary)
                        case .codeBlock(_, let text):
                            Text(text).font(.caption.monospaced()).foregroundStyle(.primary)
                        case .paragraph(_, let text):
                            Text(text).font(.footnote).foregroundStyle(.primary)
                        }
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

struct SharedHistorySectionCard: View {
    @ObservedObject var store: SharedObjectDetailStore
    let api: SharedObjectsAPI

    @Environment(\.colorScheme) private var colorScheme

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

    private var currentBadgeForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.44, green: 0.87, blue: 0.56)
            : Color(red: 0.07, green: 0.42, blue: 0.17)
    }

    private var currentBadgeBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.08, green: 0.24, blue: 0.13)
            : Color(red: 0.87, green: 0.96, blue: 0.90)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Revision history")
                    .font(.headline)
                    .foregroundStyle(.primary)
                Spacer()
                Button {
                    store.showRevisionIDs.toggle()
                } label: {
                    Text(store.showRevisionIDs ? "Hide IDs" : "Show IDs")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(secondaryForeground)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 44)
                        .background(secondaryBackground, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("shared-history-toggle-ids")
            }

            if store.history.isEmpty {
                Text("No revisions recorded yet.")
                    .font(.footnote)
                    .foregroundStyle(mutedForeground)
            } else {
                VStack(spacing: 8) {
                    ForEach(store.history) { entry in
                        let isCurrent = entry.revision == store.detail?.revision
                        let isSelected = entry.revision == store.displayedDetail?.revision
                        Button {
                            Task { await store.openRevision(entry, api: api) }
                        } label: {
                            HStack(alignment: .center, spacing: 10) {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(spacing: 6) {
                                        Text(statusLabel(entry: entry, isCurrent: isCurrent))
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(isCurrent ? currentBadgeForeground : secondaryForeground)
                                            .padding(.horizontal, 8)
                                            .padding(.vertical, 3)
                                            .background(isCurrent ? currentBadgeBackground : secondaryBackground, in: Capsule())
                                        if isSelected {
                                            Text("Viewing")
                                                .font(.caption.weight(.semibold))
                                                .foregroundStyle(mutedForeground)
                                        }
                                    }
                                    let savedAt = entry.formattedSavedAt
                                    Text(savedAt.isEmpty ? "Saved by \(entry.authorLabel)" : "Saved by \(entry.authorLabel) · \(savedAt)")
                                        .font(.caption)
                                        .foregroundStyle(mutedForeground)
                                        .fixedSize(horizontal: false, vertical: true)
                                    if store.showRevisionIDs {
                                        Text(entry.revision.token)
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(mutedForeground)
                                    }
                                }
                                Spacer(minLength: 4)
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(mutedForeground)
                                    .accessibilityHidden(true)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("shared-history-row-\(entry.revision.token)")
                    }
                }
            }

            if store.nextHistoryOffset != nil {
                Button {
                    Task { await store.loadMoreHistory(api: api) }
                } label: {
                    HStack {
                        Spacer()
                        if store.isLoadingHistory {
                            ProgressView()
                        } else {
                            Text("Load more history")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(secondaryForeground)
                        }
                        Spacer()
                    }
                    .frame(minHeight: 44)
                    .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(store.isLoadingHistory)
                .accessibilityIdentifier("shared-history-load-more")
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func statusLabel(entry: SharedRevisionEntry, isCurrent: Bool) -> String {
        if isCurrent { return "Current" }
        return entry.live ? "Earlier revision" : "Retired · retained"
    }
}
