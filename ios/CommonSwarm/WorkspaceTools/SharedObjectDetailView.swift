import SwiftUI
import UIKit

struct SharedObjectDetailView: View {
    let api: ConversationAPI
    let workspace: Workspace
    let summary: SharedObjectSummary
    let access: SharedAccess?

    @StateObject private var store: SharedObjectDetailStore
    @Environment(\.colorScheme) private var colorScheme

    init(api: ConversationAPI, workspace: Workspace, summary: SharedObjectSummary, access: SharedAccess?) {
        self.api = api
        self.workspace = workspace
        self.summary = summary
        self.access = access
        _store = StateObject(
            wrappedValue: SharedObjectDetailStore(
                workspaceID: workspace.id,
                objectID: summary.objectID,
                expectedKind: summary.kind,
                access: access
            )
        )
    }

    private var objectsAPI: SharedObjectsAPI { SharedObjectsAPI(api: api) }

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

    private var bannerForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.68, green: 0.96, blue: 0.75)
            : Color(red: 0.06, green: 0.34, blue: 0.14)
    }

    private var bannerBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.09, green: 0.24, blue: 0.14)
            : Color(red: 0.86, green: 0.96, blue: 0.89)
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
        VStack(spacing: 0) {
            if let banner = store.saveBanner {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(bannerForeground)
                        .accessibilityHidden(true)
                    Text(banner)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(bannerForeground)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(bannerBackground)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Changes saved")
            }

            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(summary.kind.label)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await store.load(api: objectsAPI)
        }
        .onChange(of: store.saveBanner) { _, newValue in
            if let newValue {
                UIAccessibility.post(notification: .announcement, argument: newValue)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if case .refused = store.accessStatus {
            ContentUnavailableView(
                "Access unavailable",
                systemImage: "lock.slash",
                description: Text("You don’t have read access to shared lists and docs in this workspace.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if case .needsConfirmation = store.accessStatus {
            VStack(spacing: 14) {
                ContentUnavailableView(
                    "Confirm content access",
                    systemImage: "lock.doc",
                    description: Text("Choose reader or editor access for this workspace before opening shared lists and docs.")
                )
                Button {
                    Task { await store.load(api: objectsAPI) }
                } label: {
                    Text("Retry")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(secondaryForeground)
                        .padding(.horizontal, 20)
                        .frame(minWidth: 88, minHeight: 44)
                        .background(secondaryBackground, in: Capsule())
                }
                .buttonStyle(.plain)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.isLoading && store.detail == nil {
            ProgressView("Loading \(summary.kind.label.lowercased())…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.loadFailed && store.detail == nil {
            RetryView(text: "Couldn’t load \(summary.kind.label.lowercased())") {
                await store.load(api: objectsAPI)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let detail = store.displayedDetail {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    headerCard(detail: detail)

                    if store.isViewingEarlierRevision {
                        earlierRevisionBanner
                    }

                    if let refreshMessage = store.postSaveRefreshMessage {
                        noticeCard(
                            title: refreshMessage,
                            message: "Retry to load the latest revision before making another edit.",
                            primaryTitle: "Retry",
                            onPrimary: { Task { await store.retryPostSaveRefresh(api: objectsAPI) } },
                            secondaryTitle: nil,
                            onSecondary: nil
                        )
                    } else if let conflict = store.recoveredConflict {
                        SharedConflictReviewCard(store: store, conflict: conflict, api: objectsAPI)
                    } else if let conflictMessage = store.conflictMessage {
                        noticeCard(
                            title: "Someone saved another revision",
                            message: conflictMessage,
                            primaryTitle: store.conflictDraftID != nil
                                ? (store.isRecoveringDraft ? "Recovering…" : "Recover my draft")
                                : "Reload current",
                            onPrimary: {
                                Task {
                                    if store.conflictDraftID != nil {
                                        await store.recoverDraft(api: objectsAPI)
                                    } else {
                                        await store.load(api: objectsAPI)
                                    }
                                }
                            },
                            secondaryTitle: store.conflictDraftID != nil ? "Reload current" : nil,
                            onSecondary: store.conflictDraftID != nil ? { Task { await store.load(api: objectsAPI) } } : nil
                        )
                    } else if let saveError = store.saveError {
                        noticeCard(
                            title: "Couldn’t save changes",
                            message: saveError,
                            primaryTitle: store.pendingEdit != nil ? "Retry" : "Reload",
                            onPrimary: {
                                Task {
                                    if store.pendingEdit != nil {
                                        await store.retryPendingEdit(api: objectsAPI)
                                    } else {
                                        await store.load(api: objectsAPI)
                                    }
                                }
                            },
                            secondaryTitle: store.pendingEdit != nil ? "Reload" : nil,
                            onSecondary: store.pendingEdit != nil ? { Task { await store.load(api: objectsAPI) } } : nil
                        )
                    }

                    if store.recoveredConflict == nil {
                        switch detail.content {
                        case .list:
                            listCard(detail: detail)
                        case .doc(let markdown):
                            docCard(markdown: markdown)
                        }

                        SharedHistorySectionCard(store: store, api: objectsAPI)
                    }
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable {
                await store.load(api: objectsAPI)
            }
        }
    }

    private var earlierRevisionBanner: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Reading an earlier revision")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
            Text("Editing is paused while viewing history.")
                .font(.footnote)
                .foregroundStyle(mutedForeground)
            Button {
                store.backToCurrent()
            } label: {
                Text("Back to current revision")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 44)
                    .background(primaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("shared-history-back-to-current")
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func headerCard(detail: SharedObjectDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(detail.title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                SharedObjectKindBadge(kind: detail.kind)
                if !(store.access?.canUpdate ?? false) {
                    Text("Reader access")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(secondaryForeground)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(secondaryBackground, in: Capsule())
                }
            }

            HStack(spacing: 6) {
                Image(systemName: detail.authorIsAgent ? "cpu" : "person.crop.circle")
                    .font(.caption)
                    .foregroundStyle(mutedForeground)
                    .accessibilityHidden(true)
                let savedAt = detail.formattedSavedAt
                Text(savedAt.isEmpty ? "Saved by \(detail.authorLabel)" : "Saved by \(detail.authorLabel) · \(savedAt)")
                    .font(.caption)
                    .foregroundStyle(mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func noticeCard(
        title: String,
        message: String,
        primaryTitle: String,
        onPrimary: @escaping () -> Void,
        secondaryTitle: String?,
        onSecondary: (() -> Void)?
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(errorForeground)
            Text(message)
                .font(.footnote)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button(action: onPrimary) {
                    Text(primaryTitle)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .frame(minWidth: 88, minHeight: 44)
                        .background(primaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)

                if let secondaryTitle, let onSecondary {
                    Button(action: onSecondary) {
                        Text(secondaryTitle)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(secondaryForeground)
                            .padding(.horizontal, 16)
                            .frame(minWidth: 80, minHeight: 44)
                            .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func listCard(detail: SharedObjectDetail) -> some View {
        let items = detail.sortedListItems
        let editable = store.canEditList
        let trimmedNew = store.newItemText.trimmingCharacters(in: .whitespacesAndNewlines)

        return VStack(alignment: .leading, spacing: 12) {
            if items.isEmpty {
                Text("No items in this list yet.")
                    .font(.subheadline)
                    .foregroundStyle(mutedForeground)
                    .padding(.vertical, 8)
            } else {
                VStack(spacing: 8) {
                    ForEach(items) { item in
                        HStack(alignment: .center, spacing: 10) {
                            if editable {
                                Button {
                                    Task { await store.toggleItem(item, api: objectsAPI) }
                                } label: {
                                    HStack(alignment: .center, spacing: 10) {
                                        Image(systemName: item.checked ? "checkmark.square.fill" : "square")
                                            .font(.title3)
                                            .foregroundStyle(item.checked ? primaryBackground : mutedForeground)
                                            .accessibilityHidden(true)
                                        Text(item.text)
                                            .font(.body)
                                            .strikethrough(item.checked)
                                            .foregroundStyle(item.checked ? mutedForeground : Color.primary)
                                            .multilineTextAlignment(.leading)
                                            .fixedSize(horizontal: false, vertical: true)
                                        Spacer(minLength: 4)
                                    }
                                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .disabled(store.isSaving)
                                .accessibilityAddTraits(item.checked ? .isSelected : [])
                                .accessibilityValue(item.checked ? "Checked" : "Not checked")
                                .accessibilityIdentifier("shared-list-toggle-\(item.item_id)")

                                Button {
                                    Task { await store.removeItem(item, api: objectsAPI) }
                                } label: {
                                    Text("Remove")
                                        .font(.footnote.weight(.semibold))
                                        .foregroundStyle(secondaryForeground)
                                        .padding(.horizontal, 12)
                                        .frame(minHeight: 44)
                                        .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                }
                                .buttonStyle(.plain)
                                .disabled(store.isSaving)
                                .accessibilityLabel("Remove \(item.text)")
                                .accessibilityIdentifier("shared-list-remove-\(item.item_id)")
                            } else {
                                HStack(alignment: .center, spacing: 10) {
                                    Image(systemName: item.checked ? "checkmark.square.fill" : "square")
                                        .font(.title3)
                                        .foregroundStyle(item.checked ? primaryBackground : mutedForeground)
                                        .accessibilityHidden(true)
                                    Text(item.text)
                                        .font(.body)
                                        .strikethrough(item.checked)
                                        .foregroundStyle(item.checked ? mutedForeground : Color.primary)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Spacer(minLength: 0)
                                }
                                .frame(minHeight: 44, alignment: .leading)
                                .accessibilityElement(children: .combine)
                                .accessibilityValue(item.checked ? "Checked" : "Not checked")
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                }
            }

            if store.access?.canUpdate ?? false {
                HStack(spacing: 8) {
                    TextField("Add an item…", text: $store.newItemText)
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .disabled(!editable)
                        .accessibilityLabel("New list item")
                        .accessibilityIdentifier("shared-list-add-field")

                    Button {
                        Task { await store.addItem(api: objectsAPI) }
                    } label: {
                        if store.isSaving {
                            ProgressView()
                                .tint(.white)
                                .frame(minWidth: 64, minHeight: 44)
                        } else {
                            Text("Add")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 16)
                                .frame(minWidth: 64, minHeight: 44)
                        }
                    }
                    .background(
                        primaryBackground.opacity(editable && !trimmedNew.isEmpty ? 1 : 0.45),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                    )
                    .buttonStyle(.plain)
                    .disabled(!editable || trimmedNew.isEmpty)
                    .accessibilityIdentifier("shared-list-add-button")
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func docCard(markdown: String) -> some View {
        let blocks = SharedObjectsRules.parseInertMarkdown(markdown)
        return VStack(alignment: .leading, spacing: 12) {
            if store.isEditingDoc {
                if store.newerRevisionAvailableWhileEditing {
                    Text("Someone saved a newer revision while you were editing. Saving will open a comparison so you can review both versions.")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(errorForeground)
                        .fixedSize(horizontal: false, vertical: true)
                }
                TextEditor(text: $store.docDraftText)
                    .font(.body)
                    .frame(minHeight: 180)
                    .padding(8)
                    .scrollContentBackground(.hidden)
                    .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .disabled(store.isSaving)
                    .accessibilityLabel("Document editor")
                    .accessibilityIdentifier("shared-doc-editor")

                HStack(spacing: 10) {
                    Button {
                        Task { await store.saveDoc(api: objectsAPI) }
                    } label: {
                        if store.isSaving {
                            ProgressView()
                                .tint(.white)
                                .frame(minWidth: 88, minHeight: 44)
                        } else {
                            Text("Save")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 18)
                                .frame(minWidth: 88, minHeight: 44)
                        }
                    }
                    .background(
                        primaryBackground.opacity(store.canEditDoc ? 1 : 0.45),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                    )
                    .buttonStyle(.plain)
                    .disabled(!store.canEditDoc)
                    .accessibilityIdentifier("shared-doc-save-button")

                    Button {
                        store.cancelEditingDoc()
                    } label: {
                        Text("Cancel")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(secondaryForeground)
                            .padding(.horizontal, 16)
                            .frame(minWidth: 80, minHeight: 44)
                            .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(store.isSaving)
                    .accessibilityIdentifier("shared-doc-cancel-button")
                }
            } else {
                if store.canEditDoc {
                    HStack {
                        Spacer()
                        Button {
                            store.beginEditingDoc()
                        } label: {
                            Text("Edit")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(secondaryForeground)
                                .padding(.horizontal, 16)
                                .frame(minWidth: 72, minHeight: 44)
                                .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("shared-doc-edit-button")
                    }
                }

                if blocks.isEmpty {
                    Text("This document is empty.")
                        .font(.subheadline)
                        .foregroundStyle(mutedForeground)
                } else {
                    ForEach(blocks) { block in
                        switch block {
                        case .heading(_, let level, let text):
                            Text(text)
                                .font(level <= 1 ? .title3.weight(.bold) : .headline)
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.top, level <= 1 ? 4 : 2)
                        case .bullet(_, let text):
                            HStack(alignment: .top, spacing: 8) {
                                Text("•")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(mutedForeground)
                                    .accessibilityHidden(true)
                                Text(text)
                                    .font(.body)
                                    .foregroundStyle(.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        case .numbered(_, let number, let text):
                            HStack(alignment: .top, spacing: 8) {
                                Text(number)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(mutedForeground)
                                Text(text)
                                    .font(.body)
                                    .foregroundStyle(.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        case .codeBlock(_, let text):
                            Text(text)
                                .font(.footnote.monospaced())
                                .foregroundStyle(.primary)
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                .fixedSize(horizontal: false, vertical: true)
                        case .paragraph(_, let text):
                            Text(text)
                                .font(.body)
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
        .textSelection(.enabled)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
