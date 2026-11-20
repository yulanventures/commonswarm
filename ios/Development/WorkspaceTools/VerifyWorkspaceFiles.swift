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

    static func main() async throws {
        guard CommandLine.arguments.count >= 2, let port = Int(CommandLine.arguments[1]) else {
            fputs("Usage: VerifyWorkspaceFiles <port>\n", stderr)
            exit(2)
        }
        let origin = URL(string: "http://127.0.0.1:\(port)")!
        let publicKey = "local-fixture"

        // 0. Pure rule checks (file size, path validation, filename sanitization, accessible labels)
        expect(WorkspaceFilesRules.formatFileSize(512) == "512 B", "Expected 512 B")
        expect(WorkspaceFilesRules.formatFileSize(14_820) == "15 KB", "Expected 15 KB, got \(WorkspaceFilesRules.formatFileSize(14_820))")
        expect(WorkspaceFilesRules.formatFileSize(2_450_000) == "2.5 MB", "Expected 2.5 MB, got \(WorkspaceFilesRules.formatFileSize(2_450_000))")
        expect(WorkspaceFilesRules.validatedDownloadURL(downloadPath: "/storage/v1/object/sign/a/b?token=1", origin: origin) != nil, "Valid /storage/v1/ path should pass")
        expect(WorkspaceFilesRules.validatedDownloadURL(downloadPath: "https://evil.example/storage/v1/x", origin: origin) == nil, "Off-origin URL must fail closed")
        expect(WorkspaceFilesRules.validatedDownloadURL(downloadPath: "//evil.example/storage/v1/x", origin: origin) == nil, "Protocol-relative URL must fail closed")
        expect(WorkspaceFilesRules.validatedDownloadURL(downloadPath: "/storage/v1/../rest/v1/secret", origin: origin) == nil, "Traversal path must fail closed")
        expect(WorkspaceFilesRules.validatedDownloadURL(downloadPath: "/functions/v1/read", origin: origin) == nil, "Non-storage path must fail closed")
        let safeName = WorkspaceFilesRules.sanitizedLocalFileName("../../etc/passwd", fallbackID: "f1")
        expect(!safeName.contains("/") && !safeName.contains(".."), "Filename must strip path traversal: \(safeName)")
        expect(
            WorkspaceFilesRules.downloadButtonAccessibilityLabel(state: .idle, fileName: "budget.pdf", version: 3)
                == "Download budget.pdf, version 3",
            "Idle a11y label mismatch"
        )
        expect(
            WorkspaceFilesRules.downloadButtonAccessibilityLabel(state: .failed(message: "This download link expired."), fileName: "budget.pdf", version: 3)
                == "Retry download budget.pdf, version 3",
            "Failed a11y label must match Retry download"
        )
        let dummyShare = DownloadedFileShare(fileID: "f", fileName: "budget.pdf", version: 3, fileURL: URL(fileURLWithPath: "/tmp/x"), contentWarning: "")
        expect(
            WorkspaceFilesRules.downloadButtonAccessibilityLabel(state: .ready(dummyShare), fileName: "budget.pdf", version: 3)
                == "Download again budget.pdf, version 3",
            "Ready a11y label must match Download again"
        )

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

        // 1. Load files: filters out current_version == 0, resolves user/agent uploaders, shows restore deadline on removed file
        let store = await MainActor.run { WorkspaceFilesStore(workspaceID: ws.id) }
        await store.load(api: filesAPI)
        let loaded = await MainActor.run { store.files }
        expect(loaded.count == 3, "Expected 3 valid files (v0 skipped), got \(loaded.count)")
        let budget = loaded.first { $0.fileID == "file_budget_pdf" }!
        let report = loaded.first { $0.fileID == "file_agent_report" }!
        let removed = loaded.first { $0.fileID == "file_old_floorplan" }!
        expect(budget.uploaderLabel == "Maya Chen" && !budget.isAgentUploader, "Expected Maya Chen uploader, got \(budget.uploaderLabel)")
        expect(report.uploaderLabel == "Atlas" && report.isAgentUploader, "Expected Atlas agent uploader, got \(report.uploaderLabel)")
        expect(removed.isRemoved && removed.restoreDeadlineLabel != nil, "Removed file must carry restore deadline")

        // 2. Removed file cannot be downloaded (0 commands)
        await store.download(removed, api: filesAPI)
        let (dlData0, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/downloads"))
        struct RecordedDownload: Decodable { let command_id: String; let file_id: String; let version_n: Int? }
        let dls0 = try JSONDecoder().decode([RecordedDownload].self, from: dlData0)
        expect(dls0.isEmpty, "Removed file must not trigger file_download_url")

        // 3. Reject off-origin / bad download_path fail-closed
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/bad-download-path?path=https://evil.example/storage/v1/x")!)
        await store.download(budget, api: filesAPI)
        let badState = await MainActor.run { store.downloadState(for: budget) }
        if case .failed(let msg) = badState {
            expect(msg.contains("unusable"), "Expected unusable link message, got \(msg)")
        } else {
            expect(false, "Off-origin download_path must fail closed")
        }

        // 4. Expired signed storage link (410) -> concise expired error -> Retry fetches fresh link and downloads exact bytes
        try await postFixture(origin.appending(path: "fixture/expire-next-storage"))
        await store.download(budget, api: filesAPI)
        let expiredState = await MainActor.run { store.downloadState(for: budget) }
        if case .failed(let msg) = expiredState {
            expect(msg == "This download link expired.", "Expected exact short expiry copy, got \(msg)")
        } else {
            expect(false, "HTTP 410 storage response must surface expired link state")
        }

        // Retry downloads v3 cleanly and writes exact bytes to local temp file
        await store.download(budget, api: filesAPI)
        let readyState = await MainActor.run { store.downloadState(for: budget) }
        if case .ready(let share) = readyState {
            let bytes = try Data(contentsOf: share.fileURL)
            let text = String(decoding: bytes, as: UTF8.self)
            expect(text.contains("Q4 budget PDF v3"), "Downloaded bytes mismatch: \(text)")
            expect(share.fileURL.lastPathComponent == "Q4-home-renovation-budget.pdf", "Expected sanitized filename")
            expect(share.version == 3, "Expected ready share bound to v3")
        } else {
            expect(false, "Expected .ready download state after retry")
        }

        // 5a. Sequence 1: dismiss share sheet, publish v4, refresh -> v3 ready state cleared, v4 offers fresh Download (never hands off v3!)
        await MainActor.run { store.activeShareItem = nil }
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/bump-version?file_id=file_budget_pdf")!)
        await store.load(api: filesAPI)
        let budgetV4 = await MainActor.run { store.files.first { $0.fileID == "file_budget_pdf" } }!
        expect(budgetV4.currentVersion == 4, "Expected refreshed file at v4")
        expect(await MainActor.run { store.downloadState(for: budgetV4) == .idle }, "Refreshed v4 must clear v3 ready state and offer Download")
        await MainActor.run { store.openReadyDownload(for: budgetV4) }
        expect(await MainActor.run { store.activeShareItem == nil }, "Share / Save must never hand off older v3 when v4 is displayed")

        // 5b. Sequence 2: start downloading v4 while storage response is held -> publish v5 & refresh -> release v4 download -> stale v4 completion MUST NOT reopen share sheet or mark v5 ready!
        try await postFixture(origin.appending(path: "fixture/hold-next-storage"))
        let staleV4Task = Task { await store.download(budgetV4, api: filesAPI) }
        struct HeldState: Decodable { let held: Bool }
        var isHeld = false
        for _ in 0..<50 {
            let (hData, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/storage-held"))
            if let st = try? JSONDecoder().decode(HeldState.self, from: hData), st.held {
                isHeld = true
                break
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        expect(isHeld, "Expected v4 storage download to be held")

        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/bump-version?file_id=file_budget_pdf")!)
        await store.load(api: filesAPI)
        let budgetV5 = await MainActor.run { store.files.first { $0.fileID == "file_budget_pdf" } }!
        expect(budgetV5.currentVersion == 5, "Expected refreshed file at v5")

        try await postFixture(origin.appending(path: "fixture/release-held-storage"))
        await staleV4Task.value
        expect(await MainActor.run { store.activeShareItem == nil }, "Stale v4 completion after refresh to v5 must not reopen share sheet")
        expect(await MainActor.run { store.downloadState(for: budgetV5) == .idle }, "Stale v4 completion must not mark v5 ready")

        let (dlData1, _) = try await URLSession.shared.data(from: origin.appending(path: "fixture/downloads"))
        let dls1 = try JSONDecoder().decode([RecordedDownload].self, from: dlData1)
        expect(dls1.count == 4, "Expected 4 file_download_url commands (3 for v3 + 1 for v4), got \(dls1.count)")
        expect(dls1[1].command_id != dls1[2].command_id, "Retry after expiry must request a fresh command_id")
        expect(dls1[2].version_n == 3 && dls1[3].version_n == 4, "Downloads must pin displayed version")

        // 6. Explicit 403 access refusal clears previously loaded files completely
        try await postFixture(URL(string: "\(origin.absoluteString)/fixture/access-refused?on=1")!)
        await store.load(api: filesAPI)
        let afterRefusedFiles = await MainActor.run { store.files }
        let afterRefusedUnavailable = await MainActor.run { store.accessUnavailable }
        expect(afterRefusedFiles.isEmpty && afterRefusedUnavailable, "403 access refusal must clear stale files and set accessUnavailable")

        print("PASS: VerifyWorkspaceFiles (version-bound ready state & stale completion guard, matching a11y names + short expiry copy, off-origin/traversal fail-closed, expired link retry, 403 clears stale files)")
    }
}
