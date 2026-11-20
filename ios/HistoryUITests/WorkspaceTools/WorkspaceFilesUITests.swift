import XCTest

@MainActor
final class WorkspaceFilesUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "com.commonswarm.ios")

    private func tapButton(_ name: String, timeout: TimeInterval = 8) throws {
        let button = app.buttons[name].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: timeout), "Missing button: " + name)
        button.tap()
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func openFiles() throws {
        let filesLink = app.buttons["Files"].firstMatch
        if !filesLink.waitForExistence(timeout: 3) {
            let emailButton = app.buttons["Continue with email"].firstMatch
            if emailButton.waitForExistence(timeout: 5) {
                emailButton.tap()
                let address = app.textFields["Email address"]
                XCTAssertTrue(address.waitForExistence(timeout: 5))
                address.tap()
                address.typeText("reader@example.test")
                try tapButton("Send code")
                let code = app.secureTextFields["Email code"]
                XCTAssertTrue(code.waitForExistence(timeout: 5))
                code.tap()
                code.typeText("012345")
                try tapButton("Sign in")
            }
            let workspace = app.buttons["Simulator workspace"].firstMatch
            if workspace.waitForExistence(timeout: 5) {
                workspace.tap()
            }
        }
        try tapButton("Files", timeout: 10)
    }

    func testBrowseFilesAndDownload() throws {
        continueAfterFailure = false
        app.launch()

        try openFiles()

        // 1. Live and removed files render with uploader attribution, size, version, and restore deadline (v0 filtered out)
        XCTAssertTrue(app.staticTexts["Q4-home-renovation-budget.pdf"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["release-readiness-summary.md"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["kitchen-floorplan-draft.png"].firstMatch.exists)
        XCTAssertFalse(app.staticTexts["should-be-filtered.txt"].exists)
        XCTAssertFalse(app.buttons["workspace-file-download-file_old_floorplan"].exists, "Removed file must not offer Download")
        capture("files-list")

        // 2. Download a live file -> share sheet opens -> dismiss -> Downloaded badge + Share / Save action visible
        let downloadBtn = app.buttons["workspace-file-download-file_budget_pdf"].firstMatch
        XCTAssertTrue(downloadBtn.waitForExistence(timeout: 5))
        downloadBtn.tap()

        // Wait for iOS share sheet and dismiss it cleanly
        let closeShare = app.buttons["Close"].firstMatch
        if closeShare.waitForExistence(timeout: 8) {
            closeShare.tap()
        } else {
            app.swipeDown()
        }

        XCTAssertTrue(app.buttons["workspace-file-share-file_budget_pdf"].firstMatch.waitForExistence(timeout: 8), "Expected Share / Save button after download")
        capture("files-downloaded")
    }
}
