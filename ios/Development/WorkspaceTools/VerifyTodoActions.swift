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
