import XCTest

@MainActor
final class WaitingOnYouUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "com.commonswarm.ios")

    private func tapButton(_ name: String, timeout: TimeInterval = 8) throws {
        let button = app.buttons[name].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: timeout), "Missing button: " + name)
        button.tap()
    }

    private func postFixture(_ pathAndQuery: String) {
        guard let url = URL(string: "http://127.0.0.1:8765" + pathAndQuery) else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { _, _, _ in sem.signal() }.resume()
        _ = sem.wait(timeout: .now() + 5)
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func ensureSignedInOnWorkspace() throws {
        let general = app.buttons["#general"].firstMatch
        if !general.waitForExistence(timeout: 3) {
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
        XCTAssertTrue(general.waitForExistence(timeout: 10), "Expected workspace directory with #general")
    }

    func testChannelWaitingSheetInCardAnswerAndScopeSwitch() throws {
        continueAfterFailure = false
        app.launch()

        try ensureSignedInOnWorkspace()

        // 1. Quiet channel (group DM) shows cross-workspace Waiting 4 in channel header
        let groupButton = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Maya Chen, Atlas")).firstMatch
        XCTAssertTrue(groupButton.waitForExistence(timeout: 8), "Expected group DM in directory")
        groupButton.tap()

        let waitingButton = app.buttons["waiting-on-you-button"].firstMatch
        XCTAssertTrue(waitingButton.waitForExistence(timeout: 8), "Expected Waiting on you button in quiet channel header")
        let crossWorkspacePredicate = NSPredicate(format: "label CONTAINS %@", "Waiting 4")
        wait(for: [expectation(for: crossWorkspacePredicate, evaluatedWith: waitingButton)], timeout: 8)
        capture("waiting-quiet-header")

        // 2. Incomplete read shows Retry instead of a false empty state
        postFixture("/fixture/fail-decision-queue?ws=00000000-0000-4000-8000-000000000003")
        waitingButton.tap()
        XCTAssertTrue(app.staticTexts["Couldn’t check all waiting questions"].firstMatch.waitForExistence(timeout: 8), "Expected incomplete-read message instead of empty state")
        let retryButton = app.buttons["Retry"].firstMatch
        XCTAssertTrue(retryButton.waitForExistence(timeout: 5), "Expected Retry button on incomplete read")
        capture("waiting-incomplete-retry")

        // Restore read, tap Retry, and switch scope to "All workspaces (4)"
        postFixture("/fixture/fail-decision-queue")
        retryButton.tap()
        let allWorkspacesScope = app.buttons["waiting-scope-all"].firstMatch
        XCTAssertTrue(allWorkspacesScope.waitForExistence(timeout: 8), "Expected All workspaces scope button")
        allWorkspacesScope.tap()
        XCTAssertTrue(app.staticTexts["All workspaces (4)"].firstMatch.waitForExistence(timeout: 5) || allWorkspacesScope.label.contains("All workspaces"), "Expected All workspaces label in scope selector")
        capture("waiting-all-workspaces")

        try tapButton("Done", timeout: 5)

        // Go back to directory and open #general
        let backButton = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(backButton.waitForExistence(timeout: 5))
        backButton.tap()
        try tapButton("#general", timeout: 10)

        XCTAssertTrue(waitingButton.waitForExistence(timeout: 8))
        waitingButton.tap()

        let question = app.staticTexts["Should we publish build 14 to internal testers now?"].firstMatch
        XCTAssertTrue(question.waitForExistence(timeout: 8), "Expected channel-scoped choice question")
        XCTAssertTrue(app.staticTexts["Recommended"].firstMatch.exists, "Expected Recommended badge")
        capture("waiting-channel")

        // Answer directly in the card with one tap
        let publishOption = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Publish now")).firstMatch
        XCTAssertTrue(publishOption.waitForExistence(timeout: 5))
        publishOption.tap()

        XCTAssertTrue(app.staticTexts["Sent"].firstMatch.waitForExistence(timeout: 8), "Expected visible Sent confirmation")
        XCTAssertTrue(app.staticTexts["Nothing waiting in #general"].firstMatch.waitForExistence(timeout: 5))
        capture("waiting-sent")

        // Jump to All channels from empty state and verify VoiceOver checked state
        let showAll = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Show all channels")).firstMatch
        XCTAssertTrue(showAll.waitForExistence(timeout: 5))
        showAll.tap()
        XCTAssertTrue(app.staticTexts["Which screens should we audit first on iPhone SE?"].firstMatch.waitForExistence(timeout: 5))
        let multiOption = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "To-dos list and detail")).firstMatch
        XCTAssertTrue(multiOption.waitForExistence(timeout: 5))
        XCTAssertEqual(multiOption.value as? String, "Not checked")
        multiOption.tap()
        XCTAssertEqual(multiOption.value as? String, "Checked")
        capture("waiting-workspace")
    }
}
