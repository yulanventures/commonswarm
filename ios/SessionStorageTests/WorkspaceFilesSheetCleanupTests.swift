import SwiftUI
import UIKit
import XCTest
@testable import CommonSwarm

@MainActor
final class WorkspaceFilesSheetCleanupTests: XCTestCase {
    private var window: UIWindow?
    private var hostController: UIHostingController<WorkspaceFilesView>?
    private var createdTempDirs: [URL] = []

    override func tearDown() {
        hostController?.dismiss(animated: false)
        window?.isHidden = true
        window?.rootViewController = nil
        hostController = nil
        window = nil
        for dir in createdTempDirs {
            try? FileManager.default.removeItem(at: dir)
        }
        createdTempDirs.removeAll()
        super.tearDown()
    }

    private func mountView(store: WorkspaceFilesStore, workspaceID: UUID) -> UIHostingController<WorkspaceFilesView> {
        let session = HumanSession(userID: UUID()) { "fixture-token" }
        let api = ConversationAPI(
            origin: URL(string: "http://127.0.0.1:1")!,
            publicKey: "local-fixture",
            session: session
        )
        let workspace = Workspace(workspace_id: workspaceID, name: "Sheet witness")
        let view = WorkspaceFilesView(api: api, workspace: workspace, store: store, autoLoad: false)
        let host = UIHostingController(rootView: view)

        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first
        let win: UIWindow
        if let scene {
            win = UIWindow(windowScene: scene)
        } else {
            win = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        }
        win.rootViewController = host
        win.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        self.window = win
        self.hostController = host
        return host
    }

    private func makeTempShare(fileID: String, fileName: String, version: Int = 3) throws -> DownloadedFileShare {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("commonswarm-downloads", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        createdTempDirs.append(dir)
        let fileURL = dir.appendingPathComponent(fileName)
        try Data("fixture-bytes-\(fileID)-v\(version)".utf8).write(
            to: fileURL,
            options: [.atomic, .completeFileProtection]
        )
        return DownloadedFileShare(
            fileID: fileID,
            fileName: fileName,
            version: version,
            fileURL: fileURL,
            contentWarning: WorkspaceFilesRules.defaultContentWarning
        )
    }

    private func waitUntil(
        timeout: TimeInterval = 5,
        condition: @escaping @MainActor () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() {
                return true
            }
            try? await Task.sleep(for: .milliseconds(30))
        }
        return condition()
    }

    private func findActivityViewController(from root: UIViewController?) -> UIActivityViewController? {
        guard let root else { return nil }
        if let activity = root as? UIActivityViewController {
            return activity
        }
        for child in root.children {
            if let found = findActivityViewController(from: child) {
                return found
            }
        }
        if let presented = root.presentedViewController {
            return findActivityViewController(from: presented)
        }
        return nil
    }

    func testMountedSheetDismissalDeletesTempFile() async throws {
        let workspaceID = UUID()
        let store = WorkspaceFilesStore(workspaceID: workspaceID)
        let host = mountView(store: store, workspaceID: workspaceID)

        let share = try makeTempShare(fileID: "file_budget_pdf", fileName: "Q4-home-renovation-budget.pdf", version: 3)
        let tempDir = share.fileURL.deletingLastPathComponent()
        let key = WorkspaceFileVersionKey(fileID: share.fileID, version: share.version)

        store.acceptDownloadedShare(share)

        let presented = await waitUntil { host.presentedViewController != nil }
        XCTAssertTrue(presented, "Expected SwiftUI sheet to present UIActivityViewController")
        XCTAssertTrue(FileManager.default.fileExists(atPath: share.fileURL.path), "Temp file must exist while sheet is presented")

        // Dismiss the presented UIKit controller directly (mirrors interactive swipe-down / system dismissal
        // where SwiftUI clears the sheet binding before invoking onDismiss).
        host.dismiss(animated: false)

        let cleaned = await waitUntil {
            host.presentedViewController == nil
                && !FileManager.default.fileExists(atPath: share.fileURL.path)
                && !FileManager.default.fileExists(atPath: tempDir.path)
        }
        XCTAssertTrue(cleaned, "Dismissing the mounted share sheet must delete the original temporary file and directory")
        XCTAssertNil(store.activeShareItem)
        XCTAssertEqual(store.downloadStates[key], .downloaded)
    }

    func testMountedActivityCompletionCancelAndErrorDeleteTempFile() async throws {
        let workspaceID = UUID()
        let store = WorkspaceFilesStore(workspaceID: workspaceID)
        let host = mountView(store: store, workspaceID: workspaceID)

        let outcomes: [(label: String, completed: Bool, error: Error?)] = [
            ("completion", true, nil),
            ("cancel", false, nil),
            ("error", false, CocoaError(.fileWriteUnknown)),
        ]

        for outcome in outcomes {
            let share = try makeTempShare(
                fileID: "file_\(outcome.label)",
                fileName: "\(outcome.label).pdf",
                version: 1
            )
            let tempDir = share.fileURL.deletingLastPathComponent()
            let key = WorkspaceFileVersionKey(fileID: share.fileID, version: share.version)

            store.acceptDownloadedShare(share)
            let presented = await waitUntil { self.findActivityViewController(from: host) != nil }
            XCTAssertTrue(presented, "Expected UIActivityViewController for \(outcome.label)")
            XCTAssertTrue(FileManager.default.fileExists(atPath: share.fileURL.path))

            let activityVC = try XCTUnwrap(findActivityViewController(from: host))
            XCTAssertNotNil(activityVC.completionWithItemsHandler, "Expected completionWithItemsHandler to be wired")
            activityVC.completionWithItemsHandler?(nil, outcome.completed, nil, outcome.error)

            let deleted = await waitUntil {
                !FileManager.default.fileExists(atPath: share.fileURL.path)
                    && !FileManager.default.fileExists(atPath: tempDir.path)
                    && store.activeShareItem == nil
                    && host.presentedViewController == nil
            }
            XCTAssertTrue(deleted, "Expected temp file deletion on UIActivityViewController \(outcome.label)")
            XCTAssertEqual(store.downloadStates[key], .downloaded)
        }
    }

    func testMountedSheetReplacementIdentityFence() async throws {
        let workspaceID = UUID()
        let store = WorkspaceFilesStore(workspaceID: workspaceID)
        let host = mountView(store: store, workspaceID: workspaceID)

        let shareA = try makeTempShare(fileID: "file_budget_pdf", fileName: "budget.pdf", version: 3)
        let dirA = shareA.fileURL.deletingLastPathComponent()
        let keyA = WorkspaceFileVersionKey(fileID: shareA.fileID, version: shareA.version)
        store.acceptDownloadedShare(shareA)

        let presentedA = await waitUntil { self.findActivityViewController(from: host) != nil }
        XCTAssertTrue(presentedA, "Expected initial UIActivityViewController for shareA")
        let activityA = try XCTUnwrap(findActivityViewController(from: host))
        let delegateA = activityA.presentationController?.delegate
        let presentationA = activityA.presentationController
        XCTAssertTrue(FileManager.default.fileExists(atPath: shareA.fileURL.path))

        // Assign replacement shareB while activityA is still mounted on screen.
        let shareB = try makeTempShare(fileID: "file_agent_report", fileName: "report.md", version: 1)
        let dirB = shareB.fileURL.deletingLastPathComponent()
        let keyB = WorkspaceFileVersionKey(fileID: shareB.fileID, version: shareB.version)
        store.acceptDownloadedShare(shareB)
        XCTAssertEqual(store.activeShareItem?.id, shareB.id, "Newer shareB must already be assigned before old sheet settles")

        // Drive real late dismissal callbacks on the OLD sheet (activityA) while newer shareB is assigned.
        activityA.completionWithItemsHandler?(nil, false, nil, nil)
        if let presentationA {
            delegateA?.presentationControllerDidDismiss?(presentationA)
        }

        // Wait for old sheet A to settle and replacement sheet B to mount.
        let replaced = await waitUntil {
            !FileManager.default.fileExists(atPath: dirA.path)
                && store.activeShareItem?.id == shareB.id
                && store.downloadStates[keyB] == .ready(shareB)
                && self.findActivityViewController(from: host) != nil
                && self.findActivityViewController(from: host) !== activityA
        }
        XCTAssertTrue(replaced, "Late dismissal callbacks on old sheet A must delete only dirA and allow shareB to mount intact")
        XCTAssertEqual(store.downloadStates[keyA], .downloaded)
        XCTAssertTrue(FileManager.default.fileExists(atPath: shareB.fileURL.path), "Newer shareB temp file must remain intact on disk")

        // Even a second delayed delivery from old sheet A after sheet B is mounted must leave shareB untouched.
        activityA.completionWithItemsHandler?(nil, false, nil, nil)
        if let presentationA {
            delegateA?.presentationControllerDidDismiss?(presentationA)
        }
        try? await Task.sleep(for: .milliseconds(80))
        XCTAssertTrue(FileManager.default.fileExists(atPath: shareB.fileURL.path), "Repeated late callback from sheet A must not delete sheet B's file")
        XCTAssertEqual(store.activeShareItem?.id, shareB.id)
        XCTAssertEqual(store.downloadStates[keyB], .ready(shareB))

        // Dismissing the replacement sheet B deletes shareB's temp file and directory.
        host.dismiss(animated: false)
        let cleanedB = await waitUntil {
            host.presentedViewController == nil
                && !FileManager.default.fileExists(atPath: shareB.fileURL.path)
                && !FileManager.default.fileExists(atPath: dirB.path)
        }
        XCTAssertTrue(cleanedB, "Dismissing replacement sheet B must delete its temp file and directory")
        XCTAssertNil(store.activeShareItem)
        XCTAssertEqual(store.downloadStates[keyB], .downloaded)
    }
}
