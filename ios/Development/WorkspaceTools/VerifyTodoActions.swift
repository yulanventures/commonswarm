import Foundation

@MainActor
final class ControllableBearer {
    private let token: String
    private var remainingHolds = 0
    private var waitForHold: CheckedContinuation<Void, Never>?
    private var releaseHold: CheckedContinuation<Void, Never>?
    private(set) var isHeld = false

    init(token: String) {
        self.token = token
    }

    func holdNext(_ count: Int = 1) {
        remainingHolds = count
    }

    func nextToken() async -> String {
        if remainingHolds > 0 {
            remainingHolds -= 1
            isHeld = true
            waitForHold?.resume()
            waitForHold = nil
            await withCheckedContinuation { cont in
                releaseHold = cont
            }
            isHeld = false
        }
        return token
    }

    func waitUntilHeld() async {
        if isHeld { return }
        await withCheckedContinuation { cont in
            waitForHold = cont
        }
    }

    func release() {
        releaseHold?.resume()
        releaseHold = nil
    }
}

@main
struct VerifyTodoActions {
    static func expect(_ condition: Bool, _ message: String) {
        if !condition {
            fputs("FAIL: \(message)\n", stderr)
            exit(1)
        }
    }

    static func postFixture(_ urlString: String) async throws {
        var req = URLRequest(url: URL(string: urlString)!)
        req.httpMethod = "POST"
        let (_, _) = try await URLSession.shared.data(for: req)
    }

    struct RecordedCommand: Decodable {
        let command_id: String
        let kind: String
        let request_id: String?
        let base_version: Int?
        let mentions: [TodoParty]?
    }

    struct MutationCounts: Decodable {
        let total: Int
        let by_kind: [String: Int]
    }

    struct HeldFlag: Decodable {
        let held: Bool
    }

    static func recordedCommands(_ origin: URL) async throws -> [RecordedCommand] {
        let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/commands"))
        return try JSONDecoder().decode([RecordedCommand].self, from: data)
    }

    static func mutationCounts(_ origin: URL) async throws -> MutationCounts {
        let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/mutations"))
        return try JSONDecoder().decode(MutationCounts.self, from: data)
    }

    static func waitUntilCommentPageHeld(_ origin: URL) async throws {
        for _ in 0..<100 {
            let (data, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/comment-page-held"))
            if (try? JSONDecoder().decode(HeldFlag.self, from: data).held) == true {
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        expect(false, "Timed out waiting for comment page request to be held")
    }

    static func main() async throws {
        guard CommandLine.arguments.count >= 2, let port = Int(CommandLine.arguments[1]) else {
            fputs("Usage: VerifyTodoActions <port>\n", stderr)
            exit(2)
        }
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let base = origin.absoluteString
        let publicKey = "local-fixture"

        let emailAPI = EmailCodeAPI(origin: origin, publicKey: publicKey)
        try await emailAPI.send(to: "reader@example.test")
        let tokens = try await emailAPI.verify(email: "reader@example.test", code: "012345")
        let bearer = await MainActor.run { ControllableBearer(token: tokens.accessToken) }
        let session = await MainActor.run {
            HumanSession(userID: tokens.userID) {
                await bearer.nextToken()
            }
        }
        let convAPI = ConversationAPI(origin: origin, publicKey: publicKey, session: session)
        let workspaces = try await convAPI.workspaces()
        let ws = workspaces[0]
        let todoAPI = TodoAPI(api: convAPI)

        // =========================================================================
        // 1. C1: Fail-closed initial state + Fresh Reader + Commenter capability checks
        // =========================================================================
        let readerListVM = await MainActor.run { TodoListViewModel(viewerUserID: tokens.userID) }
        let readerDetailVM = await MainActor.run { TodoDetailViewModel() }
        let initialFailClosed = await MainActor.run {
            !readerListVM.canCreate && !readerDetailVM.canCreateComment && !readerDetailVM.canUpdate
        }
        expect(initialFailClosed, "Both stores must start fail-closed before access is granted")

        try await postFixture("\(base)/fixture/content-role?role=reader")
        await readerListVM.load(api: todoAPI, workspaceID: ws.id)
        let seededTodos = await MainActor.run { readerListVM.orderedTodos }
        expect(seededTodos.count == 1, "Fresh Reader must still be able to read todos")
        let todoID = seededTodos[0].todo_id
        await readerDetailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)

        let readerStateOK = await MainActor.run {
            !readerListVM.canCreate
                && readerListVM.openCreateSheet() == nil
                && !readerDetailVM.canUpdate
                && !readerDetailVM.canCreateComment
                && readerDetailVM.beginEdit() == nil
                && readerDetailVM.beginAssign() == nil
        }
        expect(readerStateOK, "Fresh Reader must not receive create/edit/assign/comment capabilities")

        let cmdsBeforeReaderWrites = try await recordedCommands(origin).count
        let readerCreate = await readerListVM.createTodo(title: "Blocked", notes: "", dueOn: nil, assignee: nil, api: todoAPI, workspaceID: ws.id)
        let readerDetailVer = await MainActor.run { readerDetailVM.detail!.version }
        let readerOfferID = await MainActor.run { readerDetailVM.detail!.offer!.offer_id }
        let readerState = await readerDetailVM.setState(.done, todoID: todoID, baseVersion: readerDetailVer, api: todoAPI, workspaceID: ws.id)
        let readerOffer = await readerDetailVM.answerOffer(.accept, todoID: todoID, offerID: readerOfferID, api: todoAPI, workspaceID: ws.id)
        let readerComment = await readerDetailVM.postComment(body: "Blocked comment", api: todoAPI, workspaceID: ws.id)
        let cmdsAfterReaderWrites = try await recordedCommands(origin).count
        expect(
            readerCreate == nil && !readerState && !readerOffer && !readerComment && cmdsBeforeReaderWrites == cmdsAfterReaderWrites,
            "Fresh Reader write attempts must send ZERO network commands"
        )

        // Commenter gets create + comment, NOT update
        try await postFixture("\(base)/fixture/content-role?role=commenter")
        await readerListVM.load(api: todoAPI, workspaceID: ws.id)
        await readerDetailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let commenterOK = await MainActor.run {
            readerListVM.canCreate && readerDetailVM.canCreateComment && !readerDetailVM.canUpdate
        }
        expect(commenterOK, "Commenter must get create/comment only, never update")

        // Switch to Editor for full action + security tests
        try await postFixture("\(base)/fixture/content-role?role=editor")
        let listVM = await MainActor.run { TodoListViewModel(viewerUserID: tokens.userID) }
        await listVM.load(api: todoAPI, workspaceID: ws.id)
        let directory = await MainActor.run { listVM.directory }
        let atlasParty = directory.sortedAgents[0].party
        let mayaParty = directory.sortedPeople.first(where: { $0.label == "Maya Chen" })!.party

        let detailVM = await MainActor.run { TodoDetailViewModel() }
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let initialComments = await MainActor.run { detailVM.comments }
        expect(initialComments.count == 1 && directory.actorLabel(initialComments[0].author) == "Maya Chen", "First comment must decode {kind,id} author Maya Chen")
        let nextOff1 = await MainActor.run { detailVM.nextCommentOffset }
        expect(nextOff1 == 1, "Expected nextCommentOffset == 1")
        await detailVM.loadMoreComments(api: todoAPI, workspaceID: ws.id)
        let allComments = await MainActor.run { detailVM.comments }
        expect(allComments.count == 2 && directory.actorLabel(allComments[1].author) == "Atlas", "Paginated second comment must decode agent author Atlas")

        // =========================================================================
        // 2. C1: Held-bearer canDispatch control (commits) vs dismissal/retire (ZERO sends)
        // =========================================================================
        let controlSession = await MainActor.run { listVM.openCreateSheet() }!
        await MainActor.run { bearer.holdNext(1) }
        let controlTask = Task {
            await listVM.createTodo(session: controlSession, title: "Held control task", notes: "", dueOn: nil, assignee: nil, api: todoAPI, workspaceID: ws.id)
        }
        await bearer.waitUntilHeld()
        await MainActor.run { bearer.release() }
        let controlCreated = await controlTask.value
        expect(controlCreated != nil && controlCreated?.title == "Held control task", "Held-bearer control with active create sheet must commit")

        // Held-bearer + sheet dismissed before transport -> ZERO writes
        let dismissedSession = await MainActor.run { listVM.openCreateSheet() }!
        let cmdsBeforeDismissedCreate = try await recordedCommands(origin).count
        await MainActor.run { bearer.holdNext(1) }
        let dismissedTask = Task {
            await listVM.createTodo(session: dismissedSession, title: "Dismissed during bearer", notes: "", dueOn: nil, assignee: nil, api: todoAPI, workspaceID: ws.id)
        }
        await bearer.waitUntilHeld()
        await MainActor.run {
            listVM.dismissCreateSession(dismissedSession.id)
            bearer.release()
        }
        let dismissedResult = await dismissedTask.value
        let cmdsAfterDismissedCreate = try await recordedCommands(origin).count
        expect(dismissedResult == nil && cmdsBeforeDismissedCreate == cmdsAfterDismissedCreate, "Dismissing create sheet while bearer is held must send ZERO writes")

        // Held-bearer + detailVM.retire() before transport -> ZERO writes
        let verBeforeRetire = await MainActor.run { detailVM.detail!.version }
        let cmdsBeforeHeldRetire = try await recordedCommands(origin).count
        await MainActor.run { bearer.holdNext(1) }
        let retiredWriteTask = Task {
            await detailVM.setState(.doing, todoID: todoID, baseVersion: verBeforeRetire, api: todoAPI, workspaceID: ws.id)
        }
        await bearer.waitUntilHeld()
        await MainActor.run {
            detailVM.retire()
            bearer.release()
        }
        let retiredWriteResult = await retiredWriteTask.value
        let cmdsAfterHeldRetire = try await recordedCommands(origin).count
        expect(!retiredWriteResult && cmdsBeforeHeldRetire == cmdsAfterHeldRetire, "Retiring detailVM while bearer is held must send ZERO writes")
        await MainActor.run { detailVM.activate() }

        // Lead lifecycle witness: already-retired listVM & detailVM refuse writes at entry with ZERO sends; activate() restores
        let cmdsBeforeEntryRetire = try await recordedCommands(origin).count
        await MainActor.run { listVM.retire() }
        let entryRetiredCreate = await listVM.createTodo(title: "Should not send", notes: "", dueOn: nil, assignee: nil, api: todoAPI, workspaceID: ws.id)
        let cmdsAfterEntryRetire = try await recordedCommands(origin).count
        expect(entryRetiredCreate == nil && cmdsBeforeEntryRetire == cmdsAfterEntryRetire, "Already-retired listVM must refuse createTodo at entry with ZERO sends")
        await MainActor.run { listVM.activate() }

        // =========================================================================
        // 3. C2: Offer authorization, bound offer across replacement, bound assign across refresh, "Work request sent."
        // =========================================================================
        // 3a. Unrelated editor (not decider, not offerer, not admin) sees neither Accept/Decline nor Withdraw and is denied locally with ZERO sends
        try await postFixture("\(base)/fixture/workspace-role?role=member")
        try await postFixture("\(base)/fixture/set-offer?decider=other&by=maya&to=atlas")
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let unrelatedOffer = await MainActor.run { detailVM.detail!.offer! }
        let unrelatedAuthOK = await MainActor.run {
            !detailVM.canAcceptOrDeclineOffer(unrelatedOffer, viewerUserID: tokens.userID)
                && !detailVM.canWithdrawOffer(unrelatedOffer, viewerUserID: tokens.userID)
        }
        expect(unrelatedAuthOK, "Unrelated editor must not see Accept/Decline or Withdraw")
        let cmdsBeforeUnrelatedOffer = try await recordedCommands(origin).count
        let u1 = await detailVM.answerOffer(.accept, todoID: todoID, offerID: unrelatedOffer.offer_id, api: todoAPI, workspaceID: ws.id)
        let u2 = await detailVM.answerOffer(.decline, todoID: todoID, offerID: unrelatedOffer.offer_id, api: todoAPI, workspaceID: ws.id)
        let u3 = await detailVM.answerOffer(.withdraw, todoID: todoID, offerID: unrelatedOffer.offer_id, api: todoAPI, workspaceID: ws.id)
        let cmdsAfterUnrelatedOffer = try await recordedCommands(origin).count
        expect(!u1 && !u2 && !u3 && cmdsBeforeUnrelatedOffer == cmdsAfterUnrelatedOffer, "Unrelated editor answerOffer must send ZERO network calls")

        // 3b. Decider who is ALSO workspace admin sees BOTH Accept/Decline AND Withdraw
        try await postFixture("\(base)/fixture/workspace-role?role=admin")
        try await postFixture("\(base)/fixture/set-offer?decider=me&by=maya&to=atlas")
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let adminDeciderOffer = await MainActor.run { detailVM.detail!.offer! }
        let adminDeciderBothOK = await MainActor.run {
            detailVM.canAcceptOrDeclineOffer(adminDeciderOffer, viewerUserID: tokens.userID)
                && detailVM.canWithdrawOffer(adminDeciderOffer, viewerUserID: tokens.userID)
        }
        expect(adminDeciderBothOK, "Qualifying decider who is also workspace admin must see BOTH Accept/Decline and Withdraw")

        // 3c. Offer button click across replaced offer sends ZERO network calls
        let staleOfferID = adminDeciderOffer.offer_id
        try await postFixture("\(base)/fixture/workspace-role?role=member")
        try await postFixture("\(base)/fixture/set-offer?decider=me&by=maya&to=atlas")
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let replacementOfferID = await MainActor.run { detailVM.detail!.offer!.offer_id }
        expect(replacementOfferID != staleOfferID, "Fixture must have replaced offer")
        let cmdsBeforeStaleOffer = try await recordedCommands(origin).count
        let staleOfferResult = await detailVM.answerOffer(.accept, todoID: todoID, offerID: staleOfferID, api: todoAPI, workspaceID: ws.id)
        let cmdsAfterStaleOffer = try await recordedCommands(origin).count
        expect(!staleOfferResult && cmdsBeforeStaleOffer == cmdsAfterStaleOffer, "Stale offer click across replacement must send ZERO network calls")

        // Accept the current replacement offer cleanly (also proves C4 real write receipt without gate_clear/queue_position)
        let acceptedOffer = await detailVM.answerOffer(.accept, todoID: todoID, offerID: replacementOfferID, api: todoAPI, workspaceID: ws.id)
        let acceptedCheck = await MainActor.run { detailVM.detail?.offer == nil && detailVM.detail?.assignee == atlasParty }
        expect(acceptedOffer && acceptedCheck, "Accepting current offer must succeed with production stored write receipt")

        // 3d. Bound assign sheet retires across refresh & stale assign session sends ZERO network calls
        let staleAssign = await MainActor.run { detailVM.beginAssign() }!
        try await postFixture("\(base)/fixture/advance-version")
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let assignRetired = await MainActor.run { detailVM.activeAssignSession == nil }
        expect(assignRetired, "Assign sheet must retire when detail version advances on refresh")
        let cmdsBeforeStaleAssign = try await recordedCommands(origin).count
        let staleAssignResult = await detailVM.assign(session: staleAssign, to: nil, api: todoAPI, workspaceID: ws.id)
        let cmdsAfterStaleAssign = try await recordedCommands(origin).count
        expect(!staleAssignResult && cmdsBeforeStaleAssign == cmdsAfterStaleAssign, "Stale assign session must send ZERO network calls")

        // 3e. Assign returning an offer says "Work request sent." and offerer can Withdraw (not Accept/Decline)
        try await postFixture("\(base)/fixture/assign-makes-offer?on=1")
        let offerAssignSession = await MainActor.run { detailVM.beginAssign() }!
        let assignOfferOK = await detailVM.assign(session: offerAssignSession, to: atlasParty, api: todoAPI, workspaceID: ws.id)
        let sentOfferState = await MainActor.run {
            (detailVM.statusMessage, detailVM.detail?.offer)
        }
        expect(assignOfferOK && sentOfferState.0 == "Work request sent." && sentOfferState.1 != nil, "Assign returning an offer must report 'Work request sent.'")
        try await postFixture("\(base)/fixture/assign-makes-offer?on=0")
        let createdOffer = sentOfferState.1!
        let offererAuthOK = await MainActor.run {
            !detailVM.canAcceptOrDeclineOffer(createdOffer, viewerUserID: tokens.userID)
                && detailVM.canWithdrawOffer(createdOffer, viewerUserID: tokens.userID)
        }
        expect(offererAuthOK, "Offerer who is not decider must see Withdraw only")
        let withdrawOK = await detailVM.answerOffer(.withdraw, todoID: todoID, offerID: createdOffer.offer_id, api: todoAPI, workspaceID: ws.id)
        let offerClearedAfterWithdraw = await MainActor.run { detailVM.detail?.offer == nil }
        expect(withdrawOK && offerClearedAfterWithdraw, "Offerer must be able to withdraw own work request")

        // 3f. Frozen TodoEditSession: conflict closes editor + stale edit sends ZERO calls; fresh edit commits with real write receipt
        let staleEdit = await MainActor.run { detailVM.beginEdit() }!
        try await postFixture("\(base)/fixture/conflict-next-write")
        let conflictUpdate = await detailVM.updateDetails(session: staleEdit, title: "Stale title", notes: "Stale", dueOn: nil, api: todoAPI, workspaceID: ws.id)
        let editClosed = await MainActor.run { detailVM.activeEditSession == nil && (detailVM.actionError ?? "").contains("Someone else updated") }
        expect(!conflictUpdate && editClosed, "Conflict update must close editor and decode production stored conflict.current")
        let cmdsBeforeStaleEdit = try await recordedCommands(origin).count
        let blockedEdit = await detailVM.updateDetails(session: staleEdit, title: "Stale title", notes: "Stale", dueOn: nil, api: todoAPI, workspaceID: ws.id)
        let cmdsAfterStaleEdit = try await recordedCommands(origin).count
        expect(!blockedEdit && cmdsBeforeStaleEdit == cmdsAfterStaleEdit, "Stale edit session must send ZERO network calls")

        let freshEdit = await MainActor.run { detailVM.beginEdit() }!
        let editOK = await detailVM.updateDetails(session: freshEdit, title: "Confirm tile delivery", notes: "Updated notes", dueOn: nil, api: todoAPI, workspaceID: ws.id)
        let editedDetail = await MainActor.run { detailVM.detail! }
        expect(editOK && editedDetail.title == "Confirm tile delivery" && editedDetail.notes == "Updated notes", "Fresh edit must commit with production stored write receipt")

        // =========================================================================
        // 4. C3: Committed-then-503 + same-login 401 + pre-receipt/unclassified refusal + inconclusive read + canonical mention order + exact 1 mutation
        // =========================================================================
        let mutBeforeComment = (try await mutationCounts(origin)).by_kind["todo_comment"] ?? 0
        try await postFixture("\(base)/fixture/commit-then-503")
        // First attempt uses [mayaParty, atlasParty]
        let commentFirst = await detailVM.postComment(body: "Committed before 503", mentions: [mayaParty, atlasParty], api: todoAPI, workspaceID: ws.id)
        let pendingCommentID = await MainActor.run { detailVM.pendingComment?.commandID }
        let commentUnknown1 = await MainActor.run { detailVM.hasUnknownPendingComment }
        expect(!commentFirst && commentUnknown1 && pendingCommentID != nil, "Committed-then-503 comment must stay outcomeUnknown with commandID")
        let mutAfterFirstComment = (try await mutationCounts(origin)).by_kind["todo_comment"] ?? 0
        expect(mutAfterFirstComment == mutBeforeComment + 1, "Fixture must have committed the comment before returning 503")

        // Same-login 401 on retry (with REVERSED mention order [atlasParty, mayaParty]) must preserve commandID & unknown state
        try await postFixture("\(base)/fixture/edge-401?on=1")
        let comment401 = await detailVM.postComment(body: "Committed before 503", mentions: [atlasParty, mayaParty], api: todoAPI, workspaceID: ws.id)
        let preservedAfter401 = await MainActor.run {
            !comment401
                && detailVM.hasUnknownPendingComment
                && detailVM.pendingComment?.commandID == pendingCommentID
                && (detailVM.actionError ?? "").lowercased().contains("unknown")
        }
        expect(preservedAfter401, "Same-login 401 on retry must preserve pendingComment commandID and unknown status")
        try await postFixture("\(base)/fixture/edge-401?on=0")

        // Inconclusive read (detailVM.load) must NOT clear pendingComment
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let preservedAfterRead = await MainActor.run {
            detailVM.hasUnknownPendingComment && detailVM.pendingComment?.commandID == pendingCommentID
        }
        expect(preservedAfterRead, "Inconclusive detail read must NOT clear pendingComment")

        // Unclassified pre-receipt refusal (e.g., rate_limited) on retry must preserve commandID & unknown state
        try await postFixture("\(base)/fixture/pre-receipt-refusal?reason=rate_limited")
        let commentUnclassified = await detailVM.postComment(body: "Committed before 503", mentions: [atlasParty, mayaParty], api: todoAPI, workspaceID: ws.id)
        let preservedAfterUnclassified = await MainActor.run {
            !commentUnclassified
                && detailVM.hasUnknownPendingComment
                && detailVM.pendingComment?.commandID == pendingCommentID
                && (detailVM.actionError ?? "").lowercased().contains("unknown")
        }
        expect(preservedAfterUnclassified, "Unclassified pre-receipt refusal must preserve pendingComment commandID and unknown status")

        // Different comment must be blocked locally with ZERO sends while outcome is unknown
        let cmdsBeforeDiffComment = try await recordedCommands(origin).count
        let diffComment = await detailVM.postComment(body: "Different comment", mentions: [], api: todoAPI, workspaceID: ws.id)
        let cmdsAfterDiffComment = try await recordedCommands(origin).count
        expect(!diffComment && cmdsBeforeDiffComment == cmdsAfterDiffComment, "Different comment while unknown must be blocked with ZERO sends")

        // Unchanged retry with reversed mention order [atlasParty, mayaParty] replays cached receipt -> EXACTLY 1 server mutation!
        let commentReplayOK = await detailVM.postComment(body: "Committed before 503", mentions: [atlasParty, mayaParty], api: todoAPI, workspaceID: ws.id)
        let commentPendingCleared = await MainActor.run { !detailVM.hasUnknownPendingComment }
        let mutAfterReplayComment = (try await mutationCounts(origin)).by_kind["todo_comment"] ?? 0
        let allCommentCmds = try await recordedCommands(origin).filter { $0.kind == "todo_comment" }
        let expectedIDStr = pendingCommentID!.uuidString.lowercased()
        let sameIDAndCanonicalMentions = allCommentCmds.count == 3
            && allCommentCmds.allSatisfy { $0.command_id == expectedIDStr && $0.mentions == allCommentCmds[0].mentions }
        expect(
            commentReplayOK && commentPendingCleared && mutAfterReplayComment == mutBeforeComment + 1 && sameIDAndCanonicalMentions,
            "Comment retry with reversed mention order must reuse exact command_id + canonical mentions and execute EXACTLY 1 mutation"
        )

        // Same committed-then-503 + same-login 401 + inconclusive list refresh + pre-receipt refusal witness for todo_create
        let mutBeforeCreate = (try await mutationCounts(origin)).by_kind["todo_create"] ?? 0
        try await postFixture("\(base)/fixture/commit-then-503")
        let createSess = await MainActor.run { listVM.openCreateSheet() }!
        let createFirst = await listVM.createTodo(session: createSess, title: "Schedule electrician", notes: "Morning", dueOn: "2026-11-28", assignee: atlasParty, api: todoAPI, workspaceID: ws.id)
        let pendingCreateID = await MainActor.run { listVM.pendingCreate?.commandID }
        let createUnknownNow = await MainActor.run { listVM.hasUnknownPendingCreate }
        expect(createFirst == nil && createUnknownNow && pendingCreateID != nil, "Committed-then-503 create must remain unknown")

        try await postFixture("\(base)/fixture/edge-401?on=1")
        let create401 = await listVM.retryPendingCreate(api: todoAPI, workspaceID: ws.id)
        let createPreserved401 = await MainActor.run {
            create401 == nil && listVM.hasUnknownPendingCreate && listVM.pendingCreate?.commandID == pendingCreateID
        }
        expect(createPreserved401, "Same-login 401 on create retry must preserve commandID")
        try await postFixture("\(base)/fixture/edge-401?on=0")

        // Inconclusive list refresh must NOT clear pendingCreate
        await listVM.load(api: todoAPI, workspaceID: ws.id)
        expect(await MainActor.run { listVM.hasUnknownPendingCreate && listVM.pendingCreate?.commandID == pendingCreateID }, "List refresh must NOT clear pendingCreate")

        // Pre-receipt refusal must NOT clear pendingCreate
        try await postFixture("\(base)/fixture/pre-receipt-refusal?reason=rate_limited")
        let createPreRefusal = await listVM.retryPendingCreate(api: todoAPI, workspaceID: ws.id)
        let createPreservedPreRefusal = await MainActor.run { listVM.hasUnknownPendingCreate && listVM.pendingCreate?.commandID == pendingCreateID }
        expect(createPreRefusal == nil && createPreservedPreRefusal, "Pre-receipt refusal must preserve pendingCreate")

        // Different create blocked with ZERO sends
        let cmdsBeforeDiffCreate = try await recordedCommands(origin).count
        let diffCreate = await listVM.createTodo(title: "Another task", notes: "", dueOn: nil, assignee: nil, api: todoAPI, workspaceID: ws.id)
        let cmdsAfterDiffCreate = try await recordedCommands(origin).count
        expect(diffCreate == nil && cmdsBeforeDiffCreate == cmdsAfterDiffCreate, "Different create while unknown must send ZERO commands")

        // Final unchanged retry replays receipt -> EXACTLY 1 create mutation!
        let createReplayed = await listVM.retryPendingCreate(api: todoAPI, workspaceID: ws.id)
        let mutAfterCreate = (try await mutationCounts(origin)).by_kind["todo_create"] ?? 0
        let createPendingCleared = await MainActor.run { !listVM.hasUnknownPendingCreate }
        expect(
            createReplayed != nil && createReplayed?.title == "Schedule electrician" && createPendingCleared && mutAfterCreate == mutBeforeCreate + 1,
            "Create retry must replay receipt with EXACTLY 1 server mutation"
        )

        // =========================================================================
        // 5. C4: Replayed older receipt after newer refresh MUST NOT regress displayed state
        // =========================================================================
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let vStart = await MainActor.run { detailVM.detail!.version }
        try await postFixture("\(base)/fixture/commit-then-503")
        let stateFirst = await detailVM.setState(.done, todoID: todoID, baseVersion: vStart, api: todoAPI, workspaceID: ws.id)
        let stateUnknownNow = await MainActor.run { detailVM.hasUnknownPendingState }
        expect(!stateFirst && stateUnknownNow, "Committed-then-503 setState must remain unknown")

        // Server advances past the committed state (vStart+1 -> vStart+3, reopened with newer title)
        try await postFixture("\(base)/fixture/advance-version?title=Newer%20server%20title&state=open")
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let newerLoaded = await MainActor.run {
            detailVM.detail?.version == vStart + 3 && detailVM.detail?.state == .open && detailVM.detail?.title == "Newer server title"
        }
        expect(newerLoaded, "Refresh must load newer server version vStart+3")

        // Now retry the older pending state change -> server replays vStart+1 (.done), MUST NOT regress displayed vStart+3 (.open)!
        let replayedOlderState = await detailVM.retryPendingState(api: todoAPI, workspaceID: ws.id)
        let notRegressed = await MainActor.run {
            replayedOlderState
                && !detailVM.hasUnknownPendingState
                && detailVM.detail?.version == vStart + 3
                && detailVM.detail?.state == .open
                && detailVM.detail?.title == "Newer server title"
        }
        expect(notRegressed, "Replayed older receipt (vStart+1) must NOT overwrite newer displayed state (vStart+3)")

        // =========================================================================
        // 5b. C2: Role demotion drops still-pending offer retry with ZERO sends;
        //         disappeared offer keeps explicit receipt reconciliation (EXACTLY 1 mutation)
        // =========================================================================
        try await postFixture("\(base)/fixture/workspace-role?role=admin")
        try await postFixture("\(base)/fixture/set-offer?decider=other&by=maya&to=atlas")
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let adminOnlyOffer = await MainActor.run { detailVM.detail!.offer! }
        let adminCanWithdrawBeforeDemotion = await MainActor.run { detailVM.canWithdrawOffer(adminOnlyOffer, viewerUserID: tokens.userID) }
        expect(adminCanWithdrawBeforeDemotion, "Admin must be allowed to withdraw someone else's offer")

        // Fail BEFORE receipt lookup (offer remains live on server)
        try await postFixture("\(base)/fixture/fail-next-write")
        let failedWithdraw = await detailVM.answerOffer(.withdraw, todoID: todoID, offerID: adminOnlyOffer.offer_id, api: todoAPI, workspaceID: ws.id)
        let capturedWithdrawRetry = await MainActor.run {
            detailVM.eligiblePendingRetries(viewerUserID: tokens.userID).first {
                if case .offer(_, let oid, .withdraw) = $0.action { return oid == adminOnlyOffer.offer_id }
                return false
            }
        }
        expect(!failedWithdraw && capturedWithdrawRetry != nil, "Unconfirmed admin withdraw must expose bound retry item")

        // Demote viewer from admin to ordinary workspace member (still Editor content role) while exact offer is still pending
        try await postFixture("\(base)/fixture/workspace-role?role=member")
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let demotedStateOK = await MainActor.run {
            let live = detailVM.detail?.offer
            let eligible = detailVM.eligiblePendingRetries(viewerUserID: tokens.userID)
            return live?.offer_id == adminOnlyOffer.offer_id
                && !detailVM.canWithdrawOffer(live!, viewerUserID: tokens.userID)
                && !detailVM.hasUnknownPendingOffer
                && eligible.isEmpty
        }
        expect(demotedStateOK, "Demotion while original offer is still pending must drop pending withdrawal and hide retry")
        let cmdsBeforeDemotedRetry = try await recordedCommands(origin).count
        let demotedRetrySent = await detailVM.retryPending(capturedWithdrawRetry!, api: todoAPI, workspaceID: ws.id)
        let cmdsAfterDemotedRetry = try await recordedCommands(origin).count
        expect(!demotedRetrySent && cmdsBeforeDemotedRetry == cmdsAfterDemotedRetry, "Retrying captured withdrawal after demotion must send ZERO commands")

        // Counter-case: admin Withdraw commits before 503 (offer disappears), then viewer is demoted -> receipt reconciliation still works with EXACTLY 1 mutation!
        let mutBeforeAdminWithdraw = (try await mutationCounts(origin)).by_kind["household_todo_answer"] ?? 0
        try await postFixture("\(base)/fixture/workspace-role?role=admin")
        try await postFixture("\(base)/fixture/set-offer?decider=other&by=maya&to=atlas")
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let committedWithdrawOffer = await MainActor.run { detailVM.detail!.offer! }
        try await postFixture("\(base)/fixture/commit-then-503")
        let commit503Withdraw = await detailVM.answerOffer(.withdraw, todoID: todoID, offerID: committedWithdrawOffer.offer_id, api: todoAPI, workspaceID: ws.id)
        let withdrawUnknownNow = await MainActor.run { detailVM.hasUnknownPendingOffer }
        expect(!commit503Withdraw && withdrawUnknownNow, "Committed-then-503 withdraw must remain unknown")

        try await postFixture("\(base)/fixture/workspace-role?role=member")
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let reconcileRetryItem = await MainActor.run {
            detailVM.eligiblePendingRetries(viewerUserID: tokens.userID).first {
                if case .offer(_, let oid, .withdraw) = $0.action { return oid == committedWithdrawOffer.offer_id }
                return false
            }
        }
        let offerGoneOnScreen = await MainActor.run { detailVM.detail?.offer == nil }
        expect(offerGoneOnScreen && reconcileRetryItem != nil, "Disappeared offer must preserve explicit receipt reconciliation retry even after demotion")
        let reconciledOK = await detailVM.retryPending(reconcileRetryItem!, api: todoAPI, workspaceID: ws.id)
        let mutAfterAdminWithdraw = (try await mutationCounts(origin)).by_kind["household_todo_answer"] ?? 0
        let pendingOfferClearedAfterReconcile = await MainActor.run { !detailVM.hasUnknownPendingOffer }
        expect(reconciledOK && pendingOfferClearedAfterReconcile && mutAfterAdminWithdraw == mutBeforeAdminWithdraw + 1, "Receipt reconciliation for disappeared offer must succeed with EXACTLY 1 mutation")

        // =========================================================================
        // 5c. C3: Two pending actions with different targets + retry visibility after refresh
        //         (retrying comment must NEVER commit the earlier pending withdrawal!)
        // =========================================================================
        try await postFixture("\(base)/fixture/workspace-role?role=admin")
        try await postFixture("\(base)/fixture/set-offer?decider=other&by=maya&to=atlas")
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let dualOffer = await MainActor.run { detailVM.detail!.offer! }
        let mutBeforeDualComment = (try await mutationCounts(origin)).by_kind["todo_comment"] ?? 0

        // Pending action #1: unconfirmed Withdraw offer
        try await postFixture("\(base)/fixture/fail-next-write")
        let dualOfferFail = await detailVM.answerOffer(.withdraw, todoID: todoID, offerID: dualOffer.offer_id, api: todoAPI, workspaceID: ws.id)
        expect(!dualOfferFail, "Pending action #1 (withdraw) should be unconfirmed")

        // Pending action #2: committed-then-503 comment (failed last)
        try await postFixture("\(base)/fixture/commit-then-503")
        let dualCommentFail = await detailVM.postComment(body: "Bound retry comment", mentions: [atlasParty], api: todoAPI, workspaceID: ws.id)
        expect(!dualCommentFail, "Pending action #2 (comment) should be unconfirmed")

        // Normal reload clears actionError, yet BOTH action-specific retry buttons MUST remain visible & eligible!
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let dualAfterRefresh = await MainActor.run {
            let items = detailVM.eligiblePendingRetries(viewerUserID: tokens.userID)
            let offerItem = items.first { if case .offer = $0.action { return true }; return false }
            let commentItem = items.first { if case .comment = $0.action { return true }; return false }
            return (detailVM.actionError == nil, items.count, offerItem, commentItem)
        }
        expect(
            dualAfterRefresh.0 && dualAfterRefresh.1 == 2 && dualAfterRefresh.2 != nil && dualAfterRefresh.3 != nil,
            "Normal refresh clearing actionError must keep BOTH action-specific retries visible and distinct"
        )

        // Tap ONLY the comment retry button -> MUST replay ONLY the comment, leaving the withdrawal pending & untouched (0 offer sends)!
        let offerCmdsBeforeCommentRetry = try await recordedCommands(origin).filter { $0.kind == "household_todo_answer" }.count
        let commentBoundRetryOK = await detailVM.retryPending(dualAfterRefresh.3!, api: todoAPI, workspaceID: ws.id)
        let offerCmdsAfterCommentRetry = try await recordedCommands(origin).filter { $0.kind == "household_todo_answer" }.count
        let mutAfterDualComment = (try await mutationCounts(origin)).by_kind["todo_comment"] ?? 0
        let dualIsolationOK = await MainActor.run {
            commentBoundRetryOK
                && !detailVM.hasUnknownPendingComment
                && detailVM.hasUnknownPendingOffer
                && detailVM.detail?.offer?.offer_id == dualOffer.offer_id
        }
        expect(
            dualIsolationOK && offerCmdsBeforeCommentRetry == offerCmdsAfterCommentRetry && mutAfterDualComment == mutBeforeDualComment + 1,
            "Retrying comment must ONLY replay the comment (1 mutation) and MUST NOT send or commit the earlier pending withdrawal"
        )
        // Now explicitly retry the bound withdrawal item to finish cleanly
        let offerBoundRetryOK = await detailVM.retryPending(dualAfterRefresh.2!, api: todoAPI, workspaceID: ws.id)
        let offerClearedAfterBoundRetry = await MainActor.run { offerBoundRetryOK && !detailVM.hasUnknownPendingOffer && detailVM.detail?.offer == nil }
        expect(offerClearedAfterBoundRetry, "Explicit bound withdrawal retry must commit cleanly")
        try await postFixture("\(base)/fixture/workspace-role?role=member")

        // =========================================================================
        // 5d. C3: Back / reopen with two successive stores in same login preserves commandID & payload
        //         (EXACTLY 1 server mutation on comment AND create; fresh login sees nothing)
        // =========================================================================
        let mutBeforeReopenComment = (try await mutationCounts(origin)).by_kind["todo_comment"] ?? 0
        let firstDetailStore = await MainActor.run { TodoDetailViewModel() }
        await firstDetailStore.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        try await postFixture("\(base)/fixture/commit-then-503")
        let lostCommentFirst = await firstDetailStore.postComment(body: "Survives Back and reopen", mentions: [mayaParty, atlasParty], api: todoAPI, workspaceID: ws.id)
        let originalReopenCmdID = await MainActor.run { firstDetailStore.pendingComment?.commandID }
        expect(!lostCommentFirst && originalReopenCmdID != nil, "First detail store must record unknown comment with commandID")
        // Simulate Back navigation (retire first detail store)
        await MainActor.run { firstDetailStore.retire() }

        // Simulate Reopen: brand new TodoDetailViewModel in the SAME HumanSession!
        let reopenedDetailStore = await MainActor.run { TodoDetailViewModel() }
        await reopenedDetailStore.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let recoveredComment = await MainActor.run {
            (
                reopenedDetailStore.hasUnknownPendingComment,
                reopenedDetailStore.pendingComment?.commandID,
                reopenedDetailStore.eligiblePendingRetries(viewerUserID: tokens.userID)
            )
        }
        expect(
            recoveredComment.0 && recoveredComment.1 == originalReopenCmdID && recoveredComment.2.count == 1,
            "Reopening detail under the same login must recover original pending comment commandID and retry action"
        )
        // Posting a DIFFERENT comment in the reopened store must be blocked with ZERO network sends
        let cmdsBeforeReopenDiff = try await recordedCommands(origin).count
        let blockedDiffAfterReopen = await reopenedDetailStore.postComment(body: "Brand new unrelated comment", mentions: [], api: todoAPI, workspaceID: ws.id)
        let cmdsAfterReopenDiff = try await recordedCommands(origin).count
        expect(!blockedDiffAfterReopen && cmdsBeforeReopenDiff == cmdsAfterReopenDiff, "Reopened store must block a different comment with ZERO sends while original is unknown")

        // Posting the same comment again (even with reversed mentions!) OR tapping Retry MUST reuse originalReopenCmdID -> EXACTLY 1 mutation!
        let replayedAfterReopen = await reopenedDetailStore.postComment(body: "Survives Back and reopen", mentions: [atlasParty, mayaParty], api: todoAPI, workspaceID: ws.id)
        let mutAfterReopenComment = (try await mutationCounts(origin)).by_kind["todo_comment"] ?? 0
        let reopenCmds = try await recordedCommands(origin).filter { $0.command_id == originalReopenCmdID!.uuidString.lowercased() }
        let reopenCleared = await MainActor.run { !reopenedDetailStore.hasUnknownPendingComment }
        expect(
            replayedAfterReopen && reopenCleared && mutAfterReopenComment == mutBeforeReopenComment + 1 && reopenCmds.count == 2,
            "Reopened detail store must replay original commandID with EXACTLY 1 server mutation (never posting a second comment)"
        )

        // Same Back / reopen persistence witness for TodoListViewModel pendingCreate
        let mutBeforeReopenCreate = (try await mutationCounts(origin)).by_kind["todo_create"] ?? 0
        let firstListStore = await MainActor.run { TodoListViewModel(viewerUserID: tokens.userID) }
        await firstListStore.load(api: todoAPI, workspaceID: ws.id)
        try await postFixture("\(base)/fixture/commit-then-503")
        let reopenCreateSess = await MainActor.run { firstListStore.openCreateSheet() }!
        let lostCreate = await firstListStore.createTodo(session: reopenCreateSess, title: "Survives list reopen", notes: "", dueOn: nil, assignee: nil, api: todoAPI, workspaceID: ws.id)
        let origCreateCmdID = await MainActor.run { firstListStore.pendingCreate?.commandID }
        expect(lostCreate == nil && origCreateCmdID != nil, "First list store must record unknown create")
        await MainActor.run { firstListStore.retire() }

        let reopenedListStore = await MainActor.run { TodoListViewModel(viewerUserID: tokens.userID) }
        await reopenedListStore.load(api: todoAPI, workspaceID: ws.id)
        let recoveredCreateRetry = await MainActor.run { reopenedListStore.eligiblePendingCreateRetry }
        expect(recoveredCreateRetry?.commandID == origCreateCmdID, "Reopened list store in same login must recover original create commandID")
        let replayedCreate = await reopenedListStore.retryPendingCreate(recoveredCreateRetry!, api: todoAPI, workspaceID: ws.id)
        let mutAfterReopenCreate = (try await mutationCounts(origin)).by_kind["todo_create"] ?? 0
        expect(replayedCreate != nil && mutAfterReopenCreate == mutBeforeReopenCreate + 1, "Reopened list store retry must replay with EXACTLY 1 server mutation")

        // =========================================================================
        // 5e. C3: Held-before-Back late cleanup from retired view MUST NOT erase
        //         a reopened view's unresolved comment or create (EXACTLY 1 mutation)
        // =========================================================================
        // 5e-1. Comment held-before-Back race (exact 3-view overlap)
        let mutBeforeOverlapComment = (try await mutationCounts(origin)).by_kind["todo_comment"] ?? 0
        let overlapDetail1 = await MainActor.run { TodoDetailViewModel() }
        await overlapDetail1.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        await MainActor.run { bearer.holdNext(1) }
        let overlapCommentTask1 = Task {
            await overlapDetail1.postComment(body: "Held before Back comment", mentions: [atlasParty], api: todoAPI, workspaceID: ws.id)
        }
        await bearer.waitUntilHeld()
        // User taps Back while view 1's bearer lookup is still suspended
        await MainActor.run { overlapDetail1.retire() }

        // User reopens detail (view 2) in same login, posts same comment -> commits on server then gets 503
        let overlapDetail2 = await MainActor.run { TodoDetailViewModel() }
        await overlapDetail2.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        try await postFixture("\(base)/fixture/commit-then-503")
        let overlapComment2 = await overlapDetail2.postComment(body: "Held before Back comment", mentions: [atlasParty], api: todoAPI, workspaceID: ws.id)
        let overlapCommentID = await MainActor.run { overlapDetail2.pendingComment?.commandID }
        let overlap2Unknown = await MainActor.run { overlapDetail2.hasUnknownPendingComment }
        expect(!overlapComment2 && overlap2Unknown && overlapCommentID != nil, "View 2 must mark committed-then-503 comment as unknown")

        // NOW release view 1's held bearer so view 1 runs its late pre-dispatch cleanup!
        await MainActor.run { bearer.release() }
        let overlapComment1Result = await overlapCommentTask1.value
        expect(!overlapComment1Result, "Retired view 1 must abort before transport")

        // Open view 3 in same login -> MUST still recover view 2's unknown commandID and replay with EXACTLY 1 mutation!
        let overlapDetail3 = await MainActor.run { TodoDetailViewModel() }
        await overlapDetail3.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let overlap3Recovered = await MainActor.run {
            overlapDetail3.hasUnknownPendingComment && overlapDetail3.pendingComment?.commandID == overlapCommentID
        }
        expect(overlap3Recovered, "Late pre-dispatch cleanup from retired view 1 must NOT erase view 2's unknown comment")
        let overlapComment3Replay = await overlapDetail3.postComment(body: "Held before Back comment", mentions: [atlasParty], api: todoAPI, workspaceID: ws.id)
        let mutAfterOverlapComment = (try await mutationCounts(origin)).by_kind["todo_comment"] ?? 0
        expect(
            overlapComment3Replay && mutAfterOverlapComment == mutBeforeOverlapComment + 1,
            "View 3 must replay original commandID with EXACTLY 1 server mutation (never 2)"
        )

        // 5e-2. Create held-before-Back race (exact 3-view overlap)
        let mutBeforeOverlapCreate = (try await mutationCounts(origin)).by_kind["todo_create"] ?? 0
        let overlapList1 = await MainActor.run { TodoListViewModel(viewerUserID: tokens.userID) }
        await overlapList1.load(api: todoAPI, workspaceID: ws.id)
        let overlapCreateSess1 = await MainActor.run { overlapList1.openCreateSheet() }!
        await MainActor.run { bearer.holdNext(1) }
        let overlapCreateTask1 = Task {
            await overlapList1.createTodo(session: overlapCreateSess1, title: "Held before Back create", notes: "", dueOn: nil, assignee: nil, api: todoAPI, workspaceID: ws.id)
        }
        await bearer.waitUntilHeld()
        await MainActor.run { overlapList1.retire() }

        let overlapList2 = await MainActor.run { TodoListViewModel(viewerUserID: tokens.userID) }
        await overlapList2.load(api: todoAPI, workspaceID: ws.id)
        let overlapCreateSess2 = await MainActor.run { overlapList2.openCreateSheet() }!
        try await postFixture("\(base)/fixture/commit-then-503")
        let overlapCreate2 = await overlapList2.createTodo(session: overlapCreateSess2, title: "Held before Back create", notes: "", dueOn: nil, assignee: nil, api: todoAPI, workspaceID: ws.id)
        let overlapCreateID = await MainActor.run { overlapList2.pendingCreate?.commandID }
        let overlapList2Unknown = await MainActor.run { overlapList2.hasUnknownPendingCreate }
        expect(overlapCreate2 == nil && overlapList2Unknown && overlapCreateID != nil, "List view 2 must mark committed-then-503 create as unknown")

        // Release list view 1's held bearer so its late cleanup runs
        await MainActor.run { bearer.release() }
        let overlapCreate1Result = await overlapCreateTask1.value
        expect(overlapCreate1Result == nil, "Retired list view 1 must abort before transport")

        // Open list view 3 -> MUST still recover view 2's unknown create commandID and replay with EXACTLY 1 mutation!
        let overlapList3 = await MainActor.run { TodoListViewModel(viewerUserID: tokens.userID) }
        await overlapList3.load(api: todoAPI, workspaceID: ws.id)
        let overlapList3Retry = await MainActor.run { overlapList3.eligiblePendingCreateRetry }
        expect(overlapList3Retry?.commandID == overlapCreateID, "Late pre-dispatch cleanup from retired list view 1 must NOT erase view 2's unknown create")
        let overlapCreate3Replay = await overlapList3.retryPendingCreate(overlapList3Retry!, api: todoAPI, workspaceID: ws.id)
        let mutAfterOverlapCreate = (try await mutationCounts(origin)).by_kind["todo_create"] ?? 0
        expect(overlapCreate3Replay != nil && mutAfterOverlapCreate == mutBeforeOverlapCreate + 1, "List view 3 must replay create with EXACTLY 1 server mutation")

        // =========================================================================
        // 5f. C3: HumanSession.signOut() eagerly clears TodoPendingWriteStore (no lazy retention)
        //         and account switch clears prior login's bucket immediately
        // =========================================================================
        let signOutSession = await MainActor.run { HumanSession(userID: tokens.userID) { tokens.accessToken } }
        let signOutSID = ObjectIdentifier(signOutSession)
        let signOutAPI = TodoAPI(api: ConversationAPI(origin: origin, publicKey: publicKey, session: signOutSession))
        let signOutList = await MainActor.run { TodoListViewModel(viewerUserID: tokens.userID) }
        let signOutDetail = await MainActor.run { TodoDetailViewModel() }
        await signOutList.load(api: signOutAPI, workspaceID: ws.id)
        await signOutDetail.load(api: signOutAPI, workspaceID: ws.id, todoID: todoID)

        try await postFixture("\(base)/fixture/fail-next-write")
        _ = await signOutDetail.postComment(body: "Sensitive comment cleared on sign-out", mentions: [], api: signOutAPI, workspaceID: ws.id)
        try await postFixture("\(base)/fixture/fail-next-write")
        let signOutCreateSess = await MainActor.run { signOutList.openCreateSheet() }!
        _ = await signOutList.createTodo(session: signOutCreateSess, title: "Sensitive create cleared on sign-out", notes: "", dueOn: nil, assignee: nil, api: signOutAPI, workspaceID: ws.id)

        let storedBeforeSignOut = await MainActor.run { TodoPendingWriteStore.shared.hasStoredEntriesUnpruned(for: signOutSID) }
        expect(storedBeforeSignOut, "Expected pending comment and create stored before sign-out")

        // Sign out WITHOUT calling any Todo store method -> store must be eagerly empty immediately!
        await MainActor.run { signOutSession.signOut() }
        let storedImmediatelyAfterSignOut = await MainActor.run { TodoPendingWriteStore.shared.hasStoredEntriesUnpruned(for: signOutSID) }
        expect(!storedImmediatelyAfterSignOut, "HumanSession.signOut() must eagerly clear TodoPendingWriteStore without waiting for a later store call")

        // Account switch on a live view model clears the previous session's bucket immediately
        let acctASession = await MainActor.run { HumanSession(userID: tokens.userID) { tokens.accessToken } }
        let acctASID = ObjectIdentifier(acctASession)
        let acctAAPI = TodoAPI(api: ConversationAPI(origin: origin, publicKey: publicKey, session: acctASession))
        let switchedDetail = await MainActor.run { TodoDetailViewModel() }
        await switchedDetail.load(api: acctAAPI, workspaceID: ws.id, todoID: todoID)
        try await postFixture("\(base)/fixture/fail-next-write")
        _ = await switchedDetail.postComment(body: "Account A pending comment", mentions: [], api: acctAAPI, workspaceID: ws.id)
        let acctAStored = await MainActor.run { TodoPendingWriteStore.shared.hasStoredEntriesUnpruned(for: acctASID) }
        expect(acctAStored, "Expected Account A pending comment stored before switch")

        let acctBSession = await MainActor.run { HumanSession(userID: tokens.userID) { tokens.accessToken } }
        let acctBAPI = TodoAPI(api: ConversationAPI(origin: origin, publicKey: publicKey, session: acctBSession))
        await switchedDetail.load(api: acctBAPI, workspaceID: ws.id, todoID: todoID)
        let switchedClean = await MainActor.run {
            !TodoPendingWriteStore.shared.hasStoredEntriesUnpruned(for: acctASID)
                && !switchedDetail.hasUnknownPendingComment
                && switchedDetail.eligiblePendingRetries(viewerUserID: tokens.userID).isEmpty
        }
        expect(switchedClean, "Account switch must immediately clear prior session bucket and expose zero prior retries")

        // =========================================================================
        // 6. C1: Refusal clears named directory, closes mention picker & sheets, and drops older held comment page errors
        // =========================================================================
        await listVM.load(api: todoAPI, workspaceID: ws.id)
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        let hasDirBeforeRefusal = await MainActor.run {
            !listVM.directory.sortedPeople.isEmpty && !listVM.directory.sortedAgents.isEmpty
        }
        expect(hasDirBeforeRefusal, "Expected populated directory before refusal")

        await MainActor.run {
            detailVM.showingMentionPicker = true
            _ = detailVM.beginEdit()
            _ = detailVM.beginAssign()
            _ = listVM.openCreateSheet()
        }
        // Start an older comment page request and hold it on the server
        try await postFixture("\(base)/fixture/hold-next-comment-page")
        let heldPageTask = Task {
            await detailVM.loadMoreComments(api: todoAPI, workspaceID: ws.id)
        }
        try await waitUntilCommentPageHeld(origin)

        // Now trigger production-shaped 403 {"error":"forbidden"} refusal on both stores
        try await postFixture("\(base)/fixture/edge-403?on=1")
        await detailVM.load(api: todoAPI, workspaceID: ws.id, todoID: todoID)
        await listVM.load(api: todoAPI, workspaceID: ws.id)

        let clearedOnRefusal = await MainActor.run {
            listVM.todos == nil
                && listVM.directory.sortedPeople.isEmpty
                && listVM.directory.sortedAgents.isEmpty
                && listVM.activeCreateSession == nil
                && listVM.failure == .refused("forbidden")
                && detailVM.detail == nil
                && detailVM.comments.isEmpty
                && !detailVM.showingMentionPicker
                && detailVM.activeEditSession == nil
                && detailVM.activeAssignSession == nil
                && detailVM.failure == .refused("forbidden")
                && detailVM.actionError == nil
        }
        expect(clearedOnRefusal, "Refusal must clear list, named directory, detail, comments, and close mention picker + all action sheets")

        // Release the older held comment page with a 500 error -> MUST NOT overwrite refusal or set actionError
        try await postFixture("\(base)/fixture/release-held-comment-page?status=500")
        await heldPageTask.value
        let stillCleanAfterOlderPageError = await MainActor.run {
            detailVM.detail == nil
                && detailVM.comments.isEmpty
                && detailVM.failure == .refused("forbidden")
                && detailVM.actionError == nil
        }
        expect(stillCleanAfterOlderPageError, "Error from an older comment page must NOT mutate state after a newer refusal")

        print("PASS: VerifyTodoActions (C1 positive capabilities/fresh Reader/held-bearer zero-send/directory+mention-picker+older-page refusal, C2 bound assign+state+offer/unrelated-editor zero-send/admin+decider/Work request sent, C3 committed-then-503+401+unclassified+inconclusive+canonical-mentions exact-1-mutation, C4 real stored write receipts+no replay regression)")
    }
}
