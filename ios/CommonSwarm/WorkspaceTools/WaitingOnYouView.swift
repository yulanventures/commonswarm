import SwiftUI
import UIKit

extension View {
    func waitingOnYouToolbar(
        api: ConversationAPI,
        workspace: Workspace,
        conversation: Conversation,
        directory: [Conversation] = [],
        channelID: UUID? = nil
    ) -> some View {
        modifier(
            WaitingOnYouToolbarModifier(
                api: api,
                workspace: workspace,
                conversation: conversation,
                directory: directory,
                channelID: channelID
            )
        )
    }
}

private struct WaitingOnYouToolbarModifier: ViewModifier {
    let api: ConversationAPI
    let workspace: Workspace
    let conversation: Conversation
    @StateObject private var store: WaitingOnYouStore
    @State private var isPresented = false

    init(
        api: ConversationAPI,
        workspace: Workspace,
        conversation: Conversation,
        directory: [Conversation],
        channelID: UUID?
    ) {
        self.api = api
        self.workspace = workspace
        self.conversation = conversation
        _store = StateObject(
            wrappedValue: WaitingOnYouStore(
                place: WaitingPlace(
                    workspace: workspace,
                    conversation: conversation,
                    viewerID: api.session.userID,
                    directory: directory,
                    channelID: channelID
                )
            )
        )
    }

    func body(content: Content) -> some View {
        let count = store.counts.channel
        let badge = count.badgeText
        let accessibleName = badge.isEmpty
            ? "Waiting, waiting on you" + (count.complete ? "" : ", still counting")
            : "Waiting \(badge), waiting on you" + (count.complete ? "" : ", still counting")

        content
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        isPresented = true
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "tray.full")
                                .accessibilityHidden(true)
                            Text("Waiting")
                                .font(.subheadline.weight(.medium))
                            if !badge.isEmpty {
                                Text(badge)
                                    .font(.caption.weight(.bold))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .foregroundStyle(count.min > 0 ? Color.white : .secondary)
                                    .background(
                                        count.min > 0 ? Color.accentColor : Color(.tertiarySystemFill),
                                        in: Capsule()
                                    )
                            }
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .accessibilityLabel(accessibleName)
                    .accessibilityIdentifier("waiting-on-you-button")
                }
            }
            .task {
                await store.load(api: WaitingOnYouAPI(api: api))
            }
            .sheet(isPresented: $isPresented) {
                WaitingOnYouSheetView(
                    store: store,
                    api: WaitingOnYouAPI(api: api),
                    onDismiss: { isPresented = false }
                )
            }
    }
}

struct WaitingOnYouSheetView: View {
    @ObservedObject var store: WaitingOnYouStore
    let api: WaitingOnYouAPI
    let onDismiss: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                scopePicker
                    .padding(.horizontal)
                    .padding(.top, 8)
                    .padding(.bottom, 10)

                if let banner = store.sentBanner {
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .accessibilityHidden(true)
                        Text(banner)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                        Spacer()
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Color.green.opacity(0.14))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Answer sent")
                }

                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Waiting on you")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done", action: onDismiss)
                        .frame(minWidth: 44, minHeight: 44)
                }
            }
        }
        .task {
            await store.load(api: api)
        }
        .onChange(of: store.sentBanner) { _, newValue in
            if let newValue {
                UIAccessibility.post(notification: .announcement, argument: newValue)
            }
        }
    }

    private var scopePicker: some View {
        let counts = store.counts
        return Picker("Scope", selection: $store.scope) {
            Text(counts.channel.optionTitle("This channel")).tag(WaitingScope.channel)
            Text(counts.workspace.optionTitle("All channels")).tag(WaitingScope.workspace)
            Text(counts.all.optionTitle("All")).tag(WaitingScope.all)
        }
        .pickerStyle(.segmented)
        .accessibilityLabel("Waiting on you scope")
    }

    @ViewBuilder
    private var content: some View {
        let visible = store.visibleItems
        let counts = store.counts

        if store.loadFailed && visible.isEmpty {
            RetryView(text: "Couldn’t load waiting questions") {
                await store.load(api: api)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.isLoading && visible.isEmpty && !counts.channel.complete {
            ProgressView("Checking questions…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if visible.isEmpty {
            emptyState(counts: counts)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(visible) { item in
                        WaitingAskCardView(
                            item: item,
                            scope: store.scope,
                            draft: Binding(
                                get: { store.draft(for: item.id) },
                                set: { store.updateOtherText($0.otherText, for: item.id) }
                            ),
                            isPending: store.pendingBySignal.contains(item.id),
                            failure: store.failuresBySignal[item.id],
                            onSelectOption: { optionID in
                                if item.multi {
                                    store.toggleOption(optionID, for: item)
                                } else {
                                    Task {
                                        await store.submitSingleOption(optionID, for: item, api: api)
                                    }
                                }
                            },
                            onSendDraft: {
                                Task {
                                    await store.submitDraft(for: item, api: api)
                                }
                            },
                            onRetry: {
                                Task {
                                    await store.retry(for: item, api: api)
                                }
                            }
                        )
                    }
                }
                .padding()
                .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: visible.map(\.id))
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable {
                await store.load(api: api)
            }
        }
    }

    @ViewBuilder
    private func emptyState(counts: WaitingPanelCounts) -> some View {
        VStack(spacing: 14) {
            ContentUnavailableView(
                emptyTitle,
                systemImage: "checkmark.circle"
            )
            if store.scope == .channel && counts.workspace.min > 0 {
                Button("Show all channels (\(counts.workspace.badgeText))") {
                    store.scope = .workspace
                }
                .buttonStyle(.borderedProminent)
                .frame(minHeight: 44)
            } else if store.scope != .all && counts.all.min > 0 {
                Button("Show all workspaces (\(counts.all.badgeText))") {
                    store.scope = .all
                }
                .buttonStyle(.borderedProminent)
                .frame(minHeight: 44)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyTitle: String {
        switch store.scope {
        case .channel:
            return "Nothing waiting in \(store.place.label)"
        case .workspace:
            return "Nothing waiting in \(store.place.workspaceName)"
        case .all:
            return "Nothing waiting on you"
        }
    }
}

private struct WaitingAskCardView: View {
    let item: WaitingAskItem
    let scope: WaitingScope
    @Binding var draft: WaitingChoiceDraft
    let isPending: Bool
    let failure: WaitingCardFailure?
    @Environment(\.colorScheme) private var colorScheme
    let onSelectOption: (String) -> Void
    let onSendDraft: () -> Void
    let onRetry: () -> Void

    private var recommendedForeground: Color {
        colorScheme == .dark ? Color(red: 0.49, green: 0.75, blue: 1.00) : Color(red: 0.00, green: 0.32, blue: 0.70)
    }

    private var recommendedBackground: Color {
        colorScheme == .dark ? Color(red: 0.08, green: 0.20, blue: 0.32) : Color(red: 0.89, green: 0.94, blue: 1.00)
    }

    var body: some View {
        let split = item.prompt
        let hasOther = WaitingChoiceRules.cleanOtherText(draft.otherText) != nil
        let canSendDraft = (item.multi && !draft.selected.isEmpty) || hasOther

        VStack(alignment: .leading, spacing: 12) {
            // Sender + timestamp + optional channel/workspace location
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: item.fromKind == .agent ? "cpu" : "person.crop.circle")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    Text(item.fromName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Spacer(minLength: 8)
                    let stamp = WaitingChoiceRules.formatRelativeTime(item.createdAt)
                    if !stamp.isEmpty {
                        Text(stamp)
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

            // Question prompt
            VStack(alignment: .leading, spacing: 6) {
                if let prose = split.prose, !prose.isEmpty {
                    Text(prose)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let question = split.question, !question.isEmpty {
                    Text(question)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            // Choice options (recommended first, 44pt+ tap targets)
            VStack(spacing: 8) {
                ForEach(item.orderedOptions) { option in
                    let isSelected = draft.selected.contains(option.id)
                    Button {
                        onSelectOption(option.id)
                    } label: {
                        HStack(alignment: .center, spacing: 10) {
                            if item.multi {
                                Image(systemName: isSelected ? "checkmark.square.fill" : "square")
                                    .foregroundStyle(isSelected ? Color.accentColor : .secondary)
                                    .accessibilityHidden(true)
                            }
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text(option.label)
                                        .font(.body.weight(.medium))
                                        .foregroundStyle(.primary)
                                        .multilineTextAlignment(.leading)
                                        .fixedSize(horizontal: false, vertical: true)
                                    if option.isRecommended {
                                        Text("Recommended")
                                            .font(.caption2.weight(.semibold))
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .foregroundStyle(recommendedForeground)
                                            .background(recommendedBackground, in: Capsule())
                                    }
                                }
                                if let desc = option.description, !desc.isEmpty {
                                    Text(desc)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                        .multilineTextAlignment(.leading)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            Spacer(minLength: 4)
                            if !item.multi {
                                Image(systemName: "arrow.up.circle.fill")
                                    .foregroundStyle(option.isRecommended ? Color.accentColor : .secondary)
                                    .accessibilityHidden(true)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .background(
                            optionBackground(recommended: option.isRecommended, selected: isSelected),
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(optionBorder(recommended: option.isRecommended, selected: isSelected), lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(isPending)
                }
            }

            // Inline "Other" text box + one-tap Send directly in the card
            HStack(spacing: 8) {
                TextField("Other answer…", text: $draft.otherText, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(minHeight: 44)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .disabled(isPending)
                    .accessibilityLabel("Other answer")

                Button {
                    onSendDraft()
                } label: {
                    if isPending {
                        ProgressView()
                            .frame(minWidth: 56, minHeight: 44)
                    } else {
                        Text("Send")
                            .font(.subheadline.weight(.semibold))
                            .frame(minWidth: 56, minHeight: 44)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isPending || !canSendDraft)
            }

            // Inline failure message + Retry (card remains editable)
            if let failure {
                VStack(alignment: .leading, spacing: 8) {
                    Text(failure.message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                    if failure.retryable && !isPending {
                        Button("Retry", action: onRetry)
                            .buttonStyle(.bordered)
                            .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                    }
                }
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func optionBackground(recommended: Bool, selected: Bool) -> Color {
        if selected { return Color.accentColor.opacity(0.16) }
        if recommended { return Color.accentColor.opacity(0.08) }
        return Color(.tertiarySystemGroupedBackground)
    }

    private func optionBorder(recommended: Bool, selected: Bool) -> Color {
        if selected { return Color.accentColor }
        if recommended { return Color.accentColor.opacity(0.45) }
        return Color(.separator).opacity(0.35)
    }
}
