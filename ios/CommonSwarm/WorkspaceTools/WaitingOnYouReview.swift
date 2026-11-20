import Foundation

struct WaitingReviewBatchResult: Equatable, Sendable {
    let sentIDs: [UUID]
    let failedIDs: [UUID]
    let skippedIDs: [UUID]

    var allSucceeded: Bool { failedIDs.isEmpty }
}

enum WaitingReviewRules {
    /// Names the whole outgoing batch when new answers are included alongside retries;
    /// keeps Retry wording only when every outgoing answer is a retry.
    static func sendButtonTitle(answeredCount: Int, failedCount: Int, isSending: Bool) -> String {
        if isSending { return "Sending…" }
        if failedCount > 0 && failedCount == answeredCount {
            return failedCount == 1 ? "Retry 1 failed" : "Retry \(failedCount) failed"
        }
        if answeredCount == 1 { return "Send 1 answer" }
        return "Send \(answeredCount) answers"
    }
}

struct WaitingDraftKey: Hashable, Sendable {
    let viewerID: UUID
    let workspaceID: UUID
    let signalID: UUID
}

@MainActor
final class WaitingSessionDraftMemory {
    static let shared = WaitingSessionDraftMemory()

    private final class Bucket {
        weak var session: HumanSession?
        let viewerID: UUID
        var drafts: [WaitingDraftKey: WaitingChoiceDraft] = [:]
        var failures: [WaitingDraftKey: WaitingCardFailure] = [:]

        init(session: HumanSession) {
            self.session = session
            self.viewerID = session.userID
        }
    }

    private var buckets: [ObjectIdentifier: Bucket] = [:]

    private func prune() {
        buckets = buckets.filter { _, bucket in
            guard let session = bucket.session else { return false }
            return session.isActive
        }
    }

    private func bucket(for session: HumanSession) -> Bucket? {
        prune()
        guard session.isActive else { return nil }
        let id = ObjectIdentifier(session)
        if let existing = buckets[id], existing.session === session, existing.viewerID == session.userID {
            return existing
        }
        let created = Bucket(session: session)
        buckets[id] = created
        return created
    }

    func setDraft(_ draft: WaitingChoiceDraft?, workspaceID: UUID, signalID: UUID, session: HumanSession?) {
        guard let session, let bucket = bucket(for: session) else { return }
        let key = WaitingDraftKey(viewerID: session.userID, workspaceID: workspaceID, signalID: signalID)
        if let draft, (!draft.selected.isEmpty || !draft.otherText.isEmpty) {
            bucket.drafts[key] = draft
        } else {
            bucket.drafts[key] = nil
        }
    }

    func draft(workspaceID: UUID, signalID: UUID, session: HumanSession?) -> WaitingChoiceDraft? {
        guard let session, let bucket = bucket(for: session) else { return nil }
        let key = WaitingDraftKey(viewerID: session.userID, workspaceID: workspaceID, signalID: signalID)
        return bucket.drafts[key]
    }

    func setFailure(_ failure: WaitingCardFailure?, workspaceID: UUID, signalID: UUID, session: HumanSession?) {
        guard let session, let bucket = bucket(for: session) else { return }
        let key = WaitingDraftKey(viewerID: session.userID, workspaceID: workspaceID, signalID: signalID)
        bucket.failures[key] = failure
    }

    func failure(workspaceID: UUID, signalID: UUID, session: HumanSession?) -> WaitingCardFailure? {
        guard let session, let bucket = bucket(for: session) else { return nil }
        let key = WaitingDraftKey(viewerID: session.userID, workspaceID: workspaceID, signalID: signalID)
        return bucket.failures[key]
    }
}

extension WaitingOnYouStore {
    /// Builds the submission currently staged in session drafts for a review-mode question, or nil if unanswered/skipped.
    func reviewSubmission(for item: WaitingAskItem) -> WaitingChoiceSubmission? {
        let current = draft(for: item.id)
        let known = Set(item.options.map(\.id))
        let validSelected = current.selected.filter { known.contains($0) }
        let other = WaitingChoiceRules.cleanOtherText(current.otherText)

        if item.multi {
            guard !validSelected.isEmpty || other != nil else { return nil }
            return WaitingChoiceSubmission(optionIds: validSelected, otherText: other)
        }
        if let first = validSelected.first {
            return WaitingChoiceSubmission(optionIds: [first], otherText: nil)
        }
        if let other {
            return WaitingChoiceSubmission(optionIds: [], otherText: other)
        }
        return nil
    }

    /// Selects or toggles an option inside survey-style Review mode without sending immediately.
    func selectReviewOption(_ optionID: String, for item: WaitingAskItem) {
        if item.multi {
            toggleOption(optionID, for: item)
            return
        }
        var current = draft(for: item.id)
        if current.selected == [optionID] {
            current.selected = []
        } else {
            current.selected = [optionID]
            current.otherText = ""
        }
        persistDraft(current, workspaceID: item.workspaceID, signalID: item.id)
        clearFailureIfChanged(for: item.id)
    }

    /// Updates inline Other answer text inside Review mode. For single-choice asks, non-empty Other clears fixed selection.
    func updateReviewOtherText(_ text: String, for item: WaitingAskItem) {
        var current = draft(for: item.id)
        current.otherText = text
        if !item.multi && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            current.selected = []
        }
        persistDraft(current, workspaceID: item.workspaceID, signalID: item.id)
        clearFailureIfChanged(for: item.id)
    }

    /// Explicitly skips a question in Review mode by clearing any staged draft so it will not be sent.
    func skipReviewQuestion(_ item: WaitingAskItem) {
        persistDraft(nil, workspaceID: item.workspaceID, signalID: item.id)
        clearFailureIfChanged(for: item.id)
    }

    /// Human-readable summary lines for the Final Review screen.
    func reviewAnswerLabels(for item: WaitingAskItem) -> [String] {
        guard let submission = reviewSubmission(for: item) else { return [] }
        let labelByID = Dictionary(uniqueKeysWithValues: item.options.map { ($0.id, $0.label) })
        var lines = submission.optionIds.compactMap { labelByID[$0] }
        if let other = submission.otherText {
            lines.append("Other: \(other)")
        }
        return lines
    }

    /// Sends ONLY the answered questions in the review batch. Unanswered/skipped questions are never sent.
    /// If a question previously failed with the same submission, reuses its original command_id for idempotent retry.
    func submitReviewBatch(items reviewItems: [WaitingAskItem], api: WaitingOnYouAPI) async -> WaitingReviewBatchResult {
        var sent: [UUID] = []
        var failed: [UUID] = []
        var skipped: [UUID] = []

        for item in reviewItems {
            guard items.contains(where: { $0.id == item.id }) else { continue }
            guard let submission = reviewSubmission(for: item) else {
                skipped.append(item.id)
                continue
            }
            let commandID: UUID
            if let existingFailure = failuresBySignal[item.id], existingFailure.submission == submission {
                commandID = existingFailure.commandID
            } else {
                commandID = UUID()
            }
            let ok = await submitChoice(submission, for: item, api: api, commandID: commandID, announceBanner: false)
            if ok {
                sent.append(item.id)
            } else {
                failed.append(item.id)
            }
        }

        if !sent.isEmpty {
            let text = sent.count == 1 ? "Sent" : "Sent \(sent.count) answers"
            showStatusBanner(.sent, text)
        }
        return WaitingReviewBatchResult(sentIDs: sent, failedIDs: failed, skippedIDs: skipped)
    }

    private func clearFailureIfChanged(for signalID: UUID) {
        guard let failure = failuresBySignal[signalID] else { return }
        if let item = items.first(where: { $0.id == signalID }),
           reviewSubmission(for: item) == failure.submission {
            return
        }
        clearFailure(for: signalID)
    }
}
