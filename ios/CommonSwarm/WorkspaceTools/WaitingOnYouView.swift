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
    @Environment(\.colorScheme) private var colorScheme

    private var badgeFill: Color {
        colorScheme == .dark
            ? Color(red: 0.08, green: 0.40, blue: 0.80)
            : Color(red: 0.00, green: 0.35, blue: 0.80)
    }

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
                ),
                session: api.session
            )
        )
    }

    func body(content: Content) -> some View {
        let count = store.counts.all
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
                                        count.min > 0 ? badgeFill : Color(.tertiarySystemFill),
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
    @State private var openedTodo: WaitingTodoItem?
    @State private var reviewSnapshot: [WaitingAskItem]?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

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

    private var neutralBannerForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.90, green: 0.91, blue: 0.94)
            : Color(red: 0.15, green: 0.17, blue: 0.21)
    }

    private var neutralBannerBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.20, green: 0.21, blue: 0.24)
            : Color(red: 0.90, green: 0.91, blue: 0.94)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                scopePicker
                    .padding(.top, 8)
                    .padding(.bottom, 10)

                if let banner = store.statusBanner {
                    let isDropped = banner.kind == .dropped
                    HStack(spacing: 8) {
                        Image(systemName: isDropped ? "info.circle.fill" : "checkmark.circle.fill")
                            .foregroundStyle(isDropped ? neutralBannerForeground : bannerForeground)
                            .accessibilityHidden(true)
                        Text(banner.text)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(isDropped ? neutralBannerForeground : bannerForeground)
                        Spacer()
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(isDropped ? neutralBannerBackground : bannerBackground)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(banner.accessibilityLabel)
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
            .navigationDestination(item: $openedTodo) { todo in
                WaitingTodoDetailView(
                    item: todo,
                    api: api,
                    onMarkedDone: { completedID in
                        store.removeCompletedTodo(completedID)
                    },
                    onDropped: { droppedID, announce in
                        store.removeDroppedTodo(droppedID, announce: announce)
                    }
                )
            }
            .navigationDestination(item: $reviewSnapshot) { snapshot in
                WaitingQuestionReviewView(store: store, api: api, initialItems: snapshot)
            }
        }
        .task {
            await store.load(api: api)
        }
        .onChange(of: store.statusBanner) { _, newValue in
            if let newValue {
                UIAccessibility.post(notification: .announcement, argument: newValue.text)
            }
        }
    }

    private var selectedScopeBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.08, green: 0.40, blue: 0.80)
            : Color(red: 0.00, green: 0.35, blue: 0.80)
    }

    private var unselectedScopeForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.94, green: 0.94, blue: 0.96)
            : Color(red: 0.11, green: 0.11, blue: 0.12)
    }

    private var unselectedScopeBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.20, green: 0.20, blue: 0.22)
            : Color(red: 0.90, green: 0.90, blue: 0.92)
    }

    private var scopePicker: some View {
        let counts = store.counts
        let options: [(scope: WaitingScope, title: String)] = [
            (.channel, counts.channel.optionTitle("This channel")),
            (.workspace, counts.workspace.optionTitle("All channels")),
            (.all, counts.all.optionTitle("All workspaces")),
        ]
        return ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(options, id: \.scope) { option in
                        let selected = store.scope == option.scope
                        Button {
                            store.scope = option.scope
                        } label: {
                            Text(option.title)
                                .font(.footnote.weight(.semibold))
                                .lineLimit(1)
                                .foregroundStyle(selected ? Color.white : unselectedScopeForeground)
                                .padding(.horizontal, 12)
                                .frame(minHeight: 44)
                                .background(
                                    selected ? selectedScopeBackground : unselectedScopeBackground,
                                    in: Capsule()
                                )
                        }
                        .buttonStyle(.plain)
                        .id(option.scope)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                        .accessibilityIdentifier("waiting-scope-\(option.scope.rawValue)")
                    }
                }
                .padding(.horizontal)
            }
            .onChange(of: store.scope) { _, newScope in
                proxy.scrollTo(newScope, anchor: .center)
            }
        }
        .accessibilityLabel("Waiting on you scope")
    }

    @ViewBuilder
    private var content: some View {
        let visibleAsks = store.visibleItems
        let visibleTodos = store.visibleTodos
        let isEmpty = visibleAsks.isEmpty && visibleTodos.isEmpty
        let counts = store.counts
        let incomplete = store.scopeFailed || (store.hasLoadedOnce && !store.scopeComplete)

        if isEmpty && incomplete && !store.isLoading {
            incompleteEmptyState(counts: counts)
        } else if store.isLoading && isEmpty && !store.scopeComplete {
            ProgressView("Checking waiting items…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if isEmpty {
            emptyState(counts: counts)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if visibleAsks.count >= 2 {
                        Button {
                            reviewSnapshot = visibleAsks
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "checklist.checked")
                                    .accessibilityHidden(true)
                                Text("Review questions (\(visibleAsks.count))")
                                    .font(.subheadline.weight(.semibold))
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .accessibilityHidden(true)
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 16)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(selectedScopeBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("waiting-review-questions-button")
                    }

                    ForEach(visibleAsks) { item in
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

                    ForEach(visibleTodos) { todo in
                        WaitingTodoCardView(
                            item: todo,
                            scope: store.scope,
                            isPending: store.pendingByTodo.contains(todo.id),
                            failure: store.failuresByTodo[todo.id],
                            onMarkDone: {
                                Task {
                                    await store.markTodoDone(todo, api: api)
                                }
                            },
                            onRetry: {
                                Task {
                                    await store.markTodoDone(todo, api: api)
                                }
                            },
                            onOpen: {
                                openedTodo = todo
                            }
                        )
                    }

                    if incomplete && !store.isLoading {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Some waiting items couldn’t be loaded.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            Button("Retry") {
                                Task { await store.load(api: api) }
                            }
                            .buttonStyle(.bordered)
                            .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                }
                .padding()
                .animation(
                    reduceMotion ? nil : .easeOut(duration: 0.2),
                    value: visibleAsks.map(\.id) + visibleTodos.map(\.id)
                )
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable {
                await store.load(api: api)
            }
        }
    }

    @ViewBuilder
    private func incompleteEmptyState(counts: WaitingPanelCounts) -> some View {
        VStack(spacing: 14) {
            Text("Couldn’t check all waiting items")
                .font(.headline)
                .multilineTextAlignment(.center)
            Button {
                Task { await store.load(api: api) }
            } label: {
                Text("Retry")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(unselectedScopeForeground)
                    .padding(.horizontal, 20)
                    .frame(minWidth: 88, minHeight: 44)
                    .background(unselectedScopeBackground, in: Capsule())
            }
            .buttonStyle(.plain)
            if store.scope == .channel && counts.workspace.min > 0 {
                scopeJumpButton("Show all channels (\(counts.workspace.badgeText))", target: .workspace)
            } else if store.scope != .all && counts.all.min > 0 {
                scopeJumpButton("Show all workspaces (\(counts.all.badgeText))", target: .all)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func emptyState(counts: WaitingPanelCounts) -> some View {
        VStack(spacing: 14) {
            ContentUnavailableView(
                emptyTitle,
                systemImage: "checkmark.circle"
            )
            if store.scope == .channel && counts.workspace.min > 0 {
                scopeJumpButton("Show all channels (\(counts.workspace.badgeText))", target: .workspace)
            } else if store.scope != .all && counts.all.min > 0 {
                scopeJumpButton("Show all workspaces (\(counts.all.badgeText))", target: .all)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func scopeJumpButton(_ title: String, target: WaitingScope) -> some View {
        Button {
            store.scope = target
        } label: {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 18)
                .frame(minHeight: 44)
                .background(selectedScopeBackground, in: Capsule())
        }
        .buttonStyle(.plain)
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
                    .accessibilityAddTraits(item.multi && isSelected ? .isSelected : [])
                    .accessibilityValue(item.multi ? (isSelected ? "Checked" : "Not checked") : "")
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
