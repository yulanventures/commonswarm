import SwiftUI

struct WaitingQuestionReviewView: View {
    @ObservedObject var store: WaitingOnYouStore
    let api: WaitingOnYouAPI
    let initialItems: [WaitingAskItem]

    @State private var reviewItems: [WaitingAskItem] = []
    @State private var stepIndex = 0
    @State private var isSending = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

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

    private var recommendedForeground: Color {
        colorScheme == .dark
            ? Color(red: 0.49, green: 0.75, blue: 1.00)
            : Color(red: 0.00, green: 0.32, blue: 0.70)
    }

    private var recommendedBackground: Color {
        colorScheme == .dark
            ? Color(red: 0.08, green: 0.20, blue: 0.32)
            : Color(red: 0.89, green: 0.94, blue: 1.00)
    }

    private var errorForeground: Color {
        colorScheme == .dark
            ? Color(red: 1.00, green: 0.48, blue: 0.46)
            : Color(red: 0.72, green: 0.08, blue: 0.08)
    }

    private var activeItems: [WaitingAskItem] {
        let liveIDs = Set(store.items.map(\.id))
        return reviewItems.filter { liveIDs.contains($0.id) }
    }

    private var answeredItems: [WaitingAskItem] {
        activeItems.filter { store.reviewSubmission(for: $0) != nil }
    }

    private var skippedItems: [WaitingAskItem] {
        activeItems.filter { store.reviewSubmission(for: $0) == nil }
    }

    private var isReviewSummary: Bool {
        stepIndex >= activeItems.count
    }

    var body: some View {
        Group {
            if activeItems.isEmpty {
                ContentUnavailableView("All questions answered", systemImage: "checkmark.circle")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if isReviewSummary {
                summaryStep
            } else {
                questionStep(item: activeItems[stepIndex], index: stepIndex, total: activeItems.count)
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(isReviewSummary ? "Review answers" : "Review questions")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if reviewItems.isEmpty {
                reviewItems = initialItems
            }
        }
    }

    @ViewBuilder
    private func questionStep(item: WaitingAskItem, index: Int, total: Int) -> some View {
        let draft = store.draft(for: item.id)
        let split = item.prompt
        let isLast = index == total - 1

        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Question \(index + 1) of \(total)")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                        Spacer()
                        Text("\(answeredItems.count) answered")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    ProgressView(value: Double(index + 1), total: Double(max(total, 1)))
                        .tint(primaryBackground)
                }

                VStack(alignment: .leading, spacing: 12) {
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
                        if let location = item.locationText(for: store.scope) {
                            Text(location)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

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

                    VStack(spacing: 8) {
                        ForEach(item.orderedOptions) { option in
                            let isSelected = draft.selected.contains(option.id)
                            Button {
                                store.selectReviewOption(option.id, for: item)
                            } label: {
                                HStack(alignment: .center, spacing: 10) {
                                    Image(systemName: item.multi
                                          ? (isSelected ? "checkmark.square.fill" : "square")
                                          : (isSelected ? "largecircle.fill.circle" : "circle"))
                                        .foregroundStyle(isSelected ? primaryBackground : .secondary)
                                        .accessibilityHidden(true)
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
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 10)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .background(
                                    isSelected ? primaryBackground.opacity(0.14)
                                        : (option.isRecommended ? primaryBackground.opacity(0.06) : Color(.tertiarySystemGroupedBackground)),
                                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                                )
                                .overlay(
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .strokeBorder(
                                            isSelected ? primaryBackground
                                                : (option.isRecommended ? primaryBackground.opacity(0.45) : Color(.separator).opacity(0.35)),
                                            lineWidth: isSelected ? 1.5 : 1
                                        )
                                )
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(isSelected ? .isSelected : [])
                            .accessibilityValue(item.multi
                                                ? (isSelected ? "Checked" : "Not checked")
                                                : (isSelected ? "Selected" : "Not selected"))
                        }
                    }

                    TextField(
                        "Other answer…",
                        text: Binding(
                            get: { store.draft(for: item.id).otherText },
                            set: { store.updateReviewOtherText($0, for: item) }
                        ),
                        axis: .vertical
                    )
                    .lineLimit(1...4)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(minHeight: 44)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityLabel("Other answer")
                }
                .padding(14)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .padding()
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 10) {
                Button {
                    if stepIndex > 0 { stepIndex -= 1 }
                } label: {
                    Text("Back")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(secondaryForeground.opacity(index == 0 ? 0.45 : 1))
                        .padding(.horizontal, 16)
                        .frame(minWidth: 72, minHeight: 44)
                        .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(index == 0)
                .accessibilityIdentifier("review-back-button")

                Button {
                    store.skipReviewQuestion(item)
                    stepIndex = min(stepIndex + 1, total)
                } label: {
                    Text("Skip")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(secondaryForeground)
                        .padding(.horizontal, 16)
                        .frame(minWidth: 72, minHeight: 44)
                        .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("review-skip-button")

                Spacer(minLength: 0)

                Button {
                    stepIndex = min(stepIndex + 1, total)
                } label: {
                    Text(isLast ? "Review" : "Next")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 20)
                        .frame(minWidth: 96, minHeight: 44)
                        .background(primaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("review-next-button")
            }
            .padding(.horizontal)
            .padding(.vertical, 10)
            .background(.bar)
        }
    }

    private var summaryStep: some View {
        let answered = answeredItems
        let skipped = skippedItems
        let failedCount = answered.filter { store.failuresBySignal[$0.id] != nil }.count

        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(answered.isEmpty ? "No answers ready to send" : "\(answered.count) ready to send")
                        .font(.headline)
                        .foregroundStyle(.primary)
                    if !skipped.isEmpty {
                        Text("\(skipped.count) skipped, won’t be sent")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }

                if !answered.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Ready to send")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)

                        ForEach(answered) { item in
                            summaryCard(item: item, answered: true)
                        }
                    }
                }

                if !skipped.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Skipped")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)

                        ForEach(skipped) { item in
                            summaryCard(item: item, answered: false)
                        }
                    }
                }
            }
            .padding()
        }
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 10) {
                Button {
                    if !activeItems.isEmpty {
                        stepIndex = activeItems.count - 1
                    }
                } label: {
                    Text("Back")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(secondaryForeground)
                        .padding(.horizontal, 16)
                        .frame(minWidth: 72, minHeight: 44)
                        .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(isSending)
                .accessibilityIdentifier("review-summary-back-button")

                Spacer(minLength: 0)

                Button {
                    Task { await sendAllAnswered() }
                } label: {
                    HStack(spacing: 6) {
                        if isSending { ProgressView().tint(.white) }
                        Text(sendButtonTitle(answeredCount: answered.count, failedCount: failedCount))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                    }
                    .padding(.horizontal, 20)
                    .frame(minWidth: 140, minHeight: 44)
                    .background(
                        primaryBackground.opacity(answered.isEmpty || isSending ? 0.5 : 1),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                    )
                }
                .buttonStyle(.plain)
                .disabled(answered.isEmpty || isSending)
                .accessibilityIdentifier("review-send-all-button")
            }
            .padding(.horizontal)
            .padding(.vertical, 10)
            .background(.bar)
        }
    }

    private func sendButtonTitle(answeredCount: Int, failedCount: Int) -> String {
        if isSending { return "Sending…" }
        if failedCount > 0 { return failedCount == 1 ? "Retry 1 failed" : "Retry \(failedCount) failed" }
        if answeredCount == 1 { return "Send 1 answer" }
        return "Send \(answeredCount) answers"
    }

    @ViewBuilder
    private func summaryCard(item: WaitingAskItem, answered: Bool) -> some View {
        let title = item.prompt.question ?? item.prompt.prose ?? item.body
        let labels = store.reviewAnswerLabels(for: item)
        let failure = store.failuresBySignal[item.id]

        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)

            if answered {
                ForEach(labels, id: \.self) { line in
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(primaryBackground)
                            .accessibilityHidden(true)
                        Text(line)
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else {
                Text("Skipped, won’t be sent")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if let failure {
                Text(failure.message)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(errorForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button {
                if let idx = activeItems.firstIndex(where: { $0.id == item.id }) {
                    stepIndex = idx
                }
            } label: {
                Text(answered ? "Edit" : "Answer")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(secondaryForeground)
                    .padding(.horizontal, 14)
                    .frame(minWidth: 72, minHeight: 44)
                    .background(secondaryBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(isSending)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func sendAllAnswered() async {
        guard !isSending else { return }
        isSending = true
        let result = await store.submitReviewBatch(items: activeItems, api: api)
        isSending = false
        if result.allSucceeded && !result.sentIDs.isEmpty {
            dismiss()
        }
    }
}
