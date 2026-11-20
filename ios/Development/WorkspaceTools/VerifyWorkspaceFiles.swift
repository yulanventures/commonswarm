import Foundation

@main
struct VerifyWorkspaceFiles {
    static func expect(_ condition: Bool, _ message: String) {
        if !condition {
            fputs("FAIL: \(message)\n", stderr)
            exit(1)
        }
    }

    static func postFixture(_ url: URL) async throws {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        let (_, _) = try await URLSession.shared.data(for: req)
    }

    static func waitForHeld(_ origin: URL, path: String) async throws -> Bool {
        struct HeldState: Decodable { let held: Bool }
        for _ in 0..<50 {
            let (hData, _) = try await URLSession.shared.data(from: origin.appending(path: path))
            if let st = try? JSONDecoder().decode(HeldState.self, from: hData), st.held {
                return true
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        return false
    }

    static func waitForHeldStorage(_ origin: URL) async throws -> Bool {
        try await waitForHeld(origin, path: "fixture/storage-held")
    }

    static func waitForHeldList(_ origin: URL) async throws -> Bool {
        try await waitForHeld(origin, path: "fixture/list-held")
    }

    static func managedDownloadEntries() -> [URL] {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("commonswarm-downloads", isDirectory: true)
        return (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
    }

    static func main() async throws {
        guard CommandLine.arguments.count >= 2, let port = Int(CommandLine.arguments[1]) else {
            fputs("Usage: VerifyWorkspaceFiles <port>\n", stderr)
            exit(2)
        }
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let publicKey = "local-fixture"

        // Clean slate for leftover-file checks
        let downloadsRoot = FileManager.default.temporaryDirectory.appendingPathComponent("commonswarm-downloads", isDirectory: true)
        try? FileManager.default.removeItem(at: downloadsRoot)

        let emailAPI = EmailCodeAPI(origin: origin, publicKey: publicKey)
        try await emailAPI.send(to: "reader@example.test")
        let tokens = try await emailAPI.verify(email: "reader@example.test", code: "012345")
        let session = await MainActor.run {
            HumanSession(userID: tokens.userID) { tokens.accessToken }
        }
        let convAPI = ConversationAPI(origin: origin, publicKey: publicKey, session: session)
        let workspaces = try await convAPI.workspaces()
        expect(workspaces.count == 1, "Expected 1 workspace")
        let ws = workspaces[0]
        let filesAPI = WorkspaceFilesAPI(api: convAPI)

        // 0. Pure rule checks (exact swarm-files path binding, off-origin, wrong ws/file/version, missing token, filename sanitization, a11y labels)
        let wsStr = ws.id.uuidString.lowercased()
        let otherWS = UUID().uuidString.lowercased()
        expect(WorkspaceFilesRules.formatFileSize(512) == "512 B", "Expected 512 B")
        expect(WorkspaceFilesRules.formatFileSize(14_820) == "15 KB", "Expected 15 KB")
        expect(WorkspaceFilesRules.formatFileSize(2_450_000) == "2.5 MB", "Expected 2.5 MB")
        expect(
            WorkspaceFilesRules.validatedDownloadURL(
                downloadPath: "/storage/v1/object/sign/swarm-files/\(wsStr)/file_budget_pdf/3?token=abc",
                origin: origin,
                workspaceID: ws.id,
                fileID: "file_budget_pdf",
                version: 3
            ) != nil,
            "Exact swarm-files path bound to workspace/file/version + token must pass"
        )
        expect(
            WorkspaceFilesRules.validatedDownloadURL(
                downloadPath: "/storage/v1/object/sign/swarm-files/\(otherWS)/file_budget_pdf/3?token=abc",
                origin: origin,
                workspaceID: ws.id,
                fileID: "file_budget_pdf",
                version: 3
            ) == nil,
            "Wrong workspace in download_path must fail closed"
        )
        expect(
            WorkspaceFilesRules.validatedDownloadURL(
                downloadPath: "/storage/v1/object/sign/swarm-files/\(wsStr)/other_file/3?token=abc",
                origin: origin,
                workspaceID: ws.id,
                fileID: "file_budget_pdf",
                version: 3
            ) == nil,
            "Wrong file_id in download_path must fail closed"
        )
        expect(
            WorkspaceFilesRules.validatedDownloadURL(
                downloadPath: "/storage/v1/object/sign/swarm-files/\(wsStr)/file_budget_pdf/4?token=abc",
                origin: origin,
                workspaceID: ws.id,
                fileID: "file_budget_pdf",
                version: 3
            ) == nil,
            "Wrong version in download_path must fail closed"
        )
        expect(
            WorkspaceFilesRules.validatedDownloadURL(
                downloadPath: "/storage/v1/object/sign/swarm-files/\(wsStr)/file_budget_pdf/3",
                origin: origin,
                workspaceID: ws.id,
                fileID: "file_budget_pdf",
                version: 3
            ) == nil,
            "Missing token query param must fail closed"
        )
        expect(
            WorkspaceFilesRules.validatedDownloadURL(
                downloadPath: "https://evil.example/storage/v1/object/sign/swarm-files/\(wsStr)/file_budget_pdf/3?token=abc",
                origin: origin,
                workspaceID: ws.id,
                fileID: "file_budget_pdf",
                version: 3
            ) == nil,
            "Off-origin URL must fail closed"
        )
        let safeName = WorkspaceFilesRules.sanitizedLocalFileName("../../etc/passwd", fallbackID: "f1")
        expect(!safeName.contains("/") && !safeName.contains(".."), "Filename must strip path traversal")
        expect(WorkspaceFilesRules.downloadButtonAccessibilityLabel(state: .idle, fileName: "budget.pdf", version: 3) == "Download budget.pdf, version 3", "Idle a11y label")
        expect(WorkspaceFilesRules.downloadButtonAccessibilityLabel(state: .failed(message: "This download link expired."), fileName: "budget.pdf", version: 3) == "Retry download budget.pdf, version 3", "Failed a11y label")
        expect(WorkspaceFilesRules.downloadButtonAccessibilityLabel(state: .downloaded, fileName: "budget.pdf", version: 3) == "Download again budget.pdf, version 3", "Downloaded a11y label")

        // 1. Load files: filters out v0, resolves user/agent uploaders, shows restore deadline on removed file
        let store = await MainActor.run { WorkspaceFilesStore(workspaceID: ws.id) }
        await store.load(api: filesAPI)
        let loaded = await MainActor.run { store.files }
        expect(loaded.count == 3, "Expected 3 valid files, got \(loaded.count)")
        let budget = loaded.first { $0.fileID == "file_budget_pdf" }!
        let report = loaded.first { $0.fileID == "file_agent_report" }!
        let removed = loaded.first { $0.fileID == "file_old_floorplan" }!
        expect(budget.uploaderLabel == "Maya Chen" && !budget.isAgentUploader, "Expected Maya Chen")
        expect(report.uploaderLabel == "Atlas" && report.isAgentUploader, "Expected Atlas agent")
        expect(removed.isRemoved && removed.restoreDeadlineLabel != nil, "Removed file must carry restore deadline")

        // 2. Removed file triggers 0 download commands
        await store.download(removed, api: filesAPI)
        struct RecordedDownload: Decodable { let command_id: String; let file_id: String; let version_n: Int? }
        let (dlData0, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/downloads"))
        expect((try JSONDecoder().decode([RecordedDownload].self, from: dlData0)).isEmpty, "Removed file must not trigger file_download_url")

        // 3. Reject off-origin download_path fail-closed
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/bad-download-path?path=https://evil.example/storage/v1/x")!)
        await store.download(budget, api: filesAPI)
        let badDownloadState = await MainActor.run { store.downloadState(for: budget) }
        if case .failed(let msg) = badDownloadState {
            expect(msg.contains("unusable"), "Expected unusable link message")
        } else {
            expect(false, "Off-origin download_path must fail closed")
        }

        // 4. Expired signed storage link (410) -> short expiry copy -> Retry downloads v3 cleanly with complete protection
        try await postFixture(origin.appending(path: "fixture/expire-next-storage"))
        await store.download(budget, api: filesAPI)
        let expiredDownloadState = await MainActor.run { store.downloadState(for: budget) }
        if case .failed(let msg) = expiredDownloadState {
            expect(msg == "This download link expired.", "Expected exact short expiry copy, got \(msg)")
        } else {
            expect(false, "HTTP 410 storage response must surface expired link state")
        }

        await store.download(budget, api: filesAPI)
        let readyV3Share: DownloadedFileShare
        let readyDownloadState = await MainActor.run { store.downloadState(for: budget) }
        if case .ready(let share) = readyDownloadState {
            readyV3Share = share
            let bytes = try Data(contentsOf: share.fileURL)
            expect(String(decoding: bytes, as: UTF8.self).contains("Q4 budget PDF v3"), "Downloaded bytes mismatch")
            expect(FileManager.default.fileExists(atPath: share.fileURL.path), "Expected temp file on disk while active")
        } else {
            expect(false, "Expected .ready download state after retry")
            return
        }

        // 5. HezSec C1 Witness A: Share / Save after production-shaped empty [] membership loss MUST NOT open cached copy and MUST purge temp file!
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/empty-list?on=1")!)
        await store.openReadyDownload(for: budget, api: filesAPI)
        expect(await MainActor.run { store.activeShareItem == nil && store.files.isEmpty }, "Empty-list membership loss must dismiss sheet and clear files")
        expect(!FileManager.default.fileExists(atPath: readyV3Share.fileURL.deletingLastPathComponent().path), "Empty-list membership loss must delete managed temp copy on disk")
        expect(managedDownloadEntries().isEmpty, "Zero leftover files after empty-list omission")

        // Restore list and download again for C1 Witness B (explicit 403 refusal on Share / Save)
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/empty-list?on=0")!)
        await store.load(api: filesAPI)
        await store.download(budget, api: filesAPI)
        let readyFor403 = await MainActor.run { store.activeShareItem }!
        expect(FileManager.default.fileExists(atPath: readyFor403.fileURL.path), "Temp file should exist before 403 check")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-refused?on=1")!)
        await store.openReadyDownload(for: budget, api: filesAPI)
        expect(await MainActor.run { store.accessUnavailable && store.activeShareItem == nil && store.files.isEmpty }, "Explicit 403 on Share / Save must clear state and dismiss sheet")
        expect(!FileManager.default.fileExists(atPath: readyFor403.fileURL.deletingLastPathComponent().path), "Explicit 403 must delete managed temp copy on disk")
        expect(managedDownloadEntries().isEmpty, "Zero leftover files after explicit 403")

        // 6. HezSec R2 C1 store-level witness: finishShare deletes temp file even if SwiftUI cleared activeShareItem first,
        //    and fences cleanup by share.id if a newer share replaced activeShareItem before the older sheet closed.
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-refused?on=0")!)
        await store.load(api: filesAPI)
        await store.download(budget, api: filesAPI)
        let shareToDismiss = await MainActor.run { store.activeShareItem }!
        // Simulate SwiftUI resetting the item binding to nil BEFORE onDismiss runs
        await MainActor.run {
            store.activeShareItem = nil
            store.finishShare(shareToDismiss)
        }
        expect(!FileManager.default.fileExists(atPath: shareToDismiss.fileURL.deletingLastPathComponent().path), "finishShare must delete temp dir even after binding cleared activeShareItem")
        expect(await MainActor.run { store.downloadState(for: budget) == .downloaded }, "Dismissed state should transition .ready -> .downloaded even after binding cleared activeShareItem")

        // Replacement identity fence: older sheet callback must delete only older temp dir and preserve newer share
        await store.download(budget, api: filesAPI)
        let olderShare = await MainActor.run { store.activeShareItem }!
        await store.download(report, api: filesAPI)
        let newerShare = await MainActor.run { store.activeShareItem }!
        await MainActor.run { store.finishShare(olderShare) }
        expect(!FileManager.default.fileExists(atPath: olderShare.fileURL.deletingLastPathComponent().path), "Older sheet dismissal must delete older temp dir")
        expect(FileManager.default.fileExists(atPath: newerShare.fileURL.path), "Older sheet dismissal must NOT delete newer sheet temp file")
        expect(await MainActor.run { store.activeShareItem?.id == newerShare.id }, "Older sheet dismissal must NOT clear newer activeShareItem")
        await MainActor.run { store.finishShare(newerShare) }
        expect(managedDownloadEntries().isEmpty, "Finishing both sheets must leave zero temp files")

        // 7. HezSec R2 C2 Witness A: Held successful list load across an observed 403 -> list stays cleared and accessUnavailable remains true
        try await postFixture(origin.appending(path: "fixture/hold-next-list"))
        let heldLoadTask = Task { await store.load(api: filesAPI) }
        expect(try await waitForHeldList(origin), "Expected list load to be held before 403")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-refused?on=1")!)
        await store.download(budget, api: filesAPI) // observes 403 -> applyAccessUnavailable() increments accessGeneration & loadGeneration
        expect(await MainActor.run { store.accessUnavailable && store.files.isEmpty }, "Observed 403 from download must mark accessUnavailable and clear files")
        try await postFixture(origin.appending(path: "fixture/release-held-list"))
        await heldLoadTask.value
        let afterHeldList403 = await MainActor.run { store.accessUnavailable && store.files.isEmpty && !store.isLoading && store.activeShareItem == nil }
        expect(afterHeldList403, "Held successful list load released after observed 403 must NOT restore files or clear accessUnavailable")
        expect(managedDownloadEntries().isEmpty, "Held list race across 403 must leave zero temp files")

        // 8. HezSec R2 C2 Witness B: Held Share / Save list read across an observed 403 -> list stays cleared, no sheet or temp file
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-refused?on=0")!)
        await store.load(api: filesAPI)
        await store.download(budget, api: filesAPI)
        let shareBeforeHold = await MainActor.run { store.activeShareItem }!
        await MainActor.run { store.finishShare(shareBeforeHold) }
        try await postFixture(origin.appending(path: "fixture/hold-next-list"))
        let heldShareListTask = Task { await store.openReadyDownload(for: budget, api: filesAPI) }
        expect(try await waitForHeldList(origin), "Expected Share / Save list read to be held before 403")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-refused?on=1")!)
        await store.load(api: filesAPI) // observes 403 immediately
        try await postFixture(origin.appending(path: "fixture/release-held-list"))
        await heldShareListTask.value
        let afterHeldShareList403 = await MainActor.run { store.accessUnavailable && store.files.isEmpty && store.activeShareItem == nil && store.downloadStates.isEmpty }
        expect(afterHeldShareList403, "Held Share / Save list released after observed 403 must NOT restore files or open sheet")
        expect(managedDownloadEntries().isEmpty, "Held Share / Save list across 403 must leave zero temp files")

        // 9. HezSec R2 C2 Witness C: Held replacement download inside Share / Save across observed empty-list omission
        //    -> outer tracked task stays registered during replacement download, omission cancels it through trackedTasks, no sheet or temp file returns
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-refused?on=0")!)
        await store.load(api: filesAPI)
        await store.download(budget, api: filesAPI)
        let dismissedForReplacement = await MainActor.run { store.activeShareItem }!
        await MainActor.run { store.finishShare(dismissedForReplacement) }
        expect(managedDownloadEntries().isEmpty, "Dismissed file must be gone before replacement download test")
        try await postFixture(origin.appending(path: "fixture/hold-next-storage"))
        let replacementTask = Task { await store.openReadyDownload(for: budget, api: filesAPI) }
        expect(try await waitForHeldStorage(origin), "Expected Share / Save replacement storage download to be held")
        let trackedDuringReplacement = await MainActor.run { store.hasTrackedTask(for: budget) }
        expect(trackedDuringReplacement, "Replacement download inside Share / Save must remain under trackedTasks ownership through settlement")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/empty-list?on=1")!)
        await store.load(api: filesAPI) // observes empty-list omission -> pruneStaleDownloads cancels trackedTasks[key]
        let cancelledOnOmission = await MainActor.run { !store.hasTrackedTask(for: budget) && store.files.isEmpty }
        expect(cancelledOnOmission, "Observed empty-list omission must cancel replacement download through trackedTasks immediately")
        try await postFixture(origin.appending(path: "fixture/release-held-storage"))
        await replacementTask.value
        let afterReplacementOmission = await MainActor.run { store.files.isEmpty && store.activeShareItem == nil && store.downloadStates.isEmpty }
        expect(afterReplacementOmission, "Held replacement download after omission must leave list cleared with no sheet or ready state")
        expect(managedDownloadEntries().isEmpty, "Held replacement download after omission must leave zero temp files")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/empty-list?on=0")!)
        await store.load(api: filesAPI)

        // Bump v3 -> v4 and refresh -> clears .downloaded so v4 offers fresh Download
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/bump-version?file_id=file_budget_pdf")!)
        await store.load(api: filesAPI)
        let budgetV4 = await MainActor.run { store.files.first { $0.fileID == "file_budget_pdf" } }!
        let v4StateIdle = await MainActor.run { store.downloadState(for: budgetV4) == .idle }
        expect(budgetV4.currentVersion == 4 && v4StateIdle, "Refreshed v4 must clear v3 state")

        // 10. HezSec R1 C2 Witness A: Held storage response across observed workspace refusal (403) -> no ready item, no sheet, no leftover file!
        try await postFixture(origin.appending(path: "fixture/hold-next-storage"))
        let refusalRaceTask = Task { await store.download(budgetV4, api: filesAPI) }
        expect(try await waitForHeldStorage(origin), "Expected storage download to be held before 403")
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-refused?on=1")!)
        await store.load(api: filesAPI) // observes 403, increments accessGeneration, cancels tracked tasks
        try await postFixture(origin.appending(path: "fixture/release-held-storage"))
        await refusalRaceTask.value
        expect(await MainActor.run { store.accessUnavailable && store.activeShareItem == nil && store.downloadStates.isEmpty }, "Held storage response after observed 403 must produce no ready item or sheet")
        expect(managedDownloadEntries().isEmpty, "Held storage response after observed 403 must leave zero temp files")

        // 11. HezSec R1 C2 Witness B: Held storage response across sign-out (session.signOut()) -> no ready item, no sheet, no leftover file!
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-refused?on=0")!)
        await store.load(api: filesAPI)
        let liveV4 = await MainActor.run { store.files.first { $0.fileID == "file_budget_pdf" } }!
        try await postFixture(origin.appending(path: "fixture/hold-next-storage"))
        let signOutRaceTask = Task { await store.download(liveV4, api: filesAPI) }
        expect(try await waitForHeldStorage(origin), "Expected storage download to be held before sign-out")
        await MainActor.run { session.signOut() } // real sign-out closes login-scoped HumanSession transport!
        try await postFixture(origin.appending(path: "fixture/release-held-storage"))
        await signOutRaceTask.value
        expect(await MainActor.run { store.activeShareItem == nil && store.downloadStates.isEmpty }, "Held storage response after sign-out must produce no ready item or sheet")
        expect(managedDownloadEntries().isEmpty, "Held storage response after sign-out must leave zero temp files")

        print("PASS: VerifyWorkspaceFiles (C1 identity-fenced dismissal cleanup + live reauth on 403 & omission, C2 generation-fenced list reads across 403 + tracked Share/Save replacement download cancellation on omission + held transfer retirement across sign-out & 403)")
    }
}
