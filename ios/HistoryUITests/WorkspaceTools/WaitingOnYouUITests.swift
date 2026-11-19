import XCTest

@MainActor
final class WaitingOnYouUITests: XCTestCase {
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

    private func openGeneralChannel() throws {
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
        try tapButton("#general", timeout: 10)
    }

    func testChannelWaitingSheetAsksAndTodos() throws {
        continueAfterFailure = false
        app.launch()

        try openGeneralChannel()

        let waitingButton = app.buttons["waiting-on-you-button"].firstMatch
        XCTAssertTrue(waitingButton.waitForExistence(timeout: 8), "Expected Waiting on you button in channel header")
        let crossWorkspacePredicate = NSPredicate(format: "label CONTAINS %@", "Waiting 8")
        let crossWorkspaceExpectation = expectation(for: crossWorkspacePredicate, evaluatedWith: waitingButton)
        wait(for: [crossWorkspaceExpectation], timeout: 8)
        waitingButton.tap()

        let question = app.staticTexts["Should we publish build 14 to internal testers now?"].firstMatch
        XCTAssertTrue(question.waitForExistence(timeout: 8), "Expected channel-scoped choice question")
        XCTAssertTrue(app.staticTexts["Recommended"].firstMatch.exists, "Expected Recommended badge")
        capture("waiting-channel")

        // Answer the ask directly in the card with one tap
        let publishOption = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Publish now")).firstMatch
        XCTAssertTrue(publishOption.waitForExistence(timeout: 5))
        publishOption.tap()
        XCTAssertTrue(app.staticTexts["Sent"].firstMatch.waitForExistence(timeout: 8), "Expected visible Sent confirmation")

        // Channel-placed assigned to-do now sits at the top of This channel
        let generalTodoTitle = app.staticTexts["Approve App Store release notes for iOS 1.0"].firstMatch
        XCTAssertTrue(generalTodoTitle.waitForExistence(timeout: 8), "Expected #general assigned to-do card")
        capture("waiting-todo-card")

        // Open to-do detail inside the sheet
        let openTodo = app.buttons["waiting-todo-open-50000000-0000-4000-8000-000000000001"].firstMatch
        XCTAssertTrue(openTodo.waitForExistence(timeout: 5))
        openTodo.tap()
        XCTAssertTrue(app.staticTexts["Verify screenshots, privacy labels, and TestFlight release summary before submission."].firstMatch.waitForExistence(timeout: 8), "Expected to-do notes in detail view")
        XCTAssertTrue(app.staticTexts["Maya Chen"].firstMatch.exists, "Expected resolved comment author")
        capture("waiting-todo-detail")

        // Return to Waiting on you sheet and mark the assigned to-do done
        let backButton = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(backButton.waitForExistence(timeout: 5))
        backButton.tap()

        let markDone = app.buttons["waiting-todo-done-50000000-0000-4000-8000-000000000001"].firstMatch
        XCTAssertTrue(markDone.waitForExistence(timeout: 8))
        markDone.tap()

        XCTAssertTrue(app.staticTexts["Done"].firstMatch.waitForExistence(timeout: 8), "Expected visible Done banner")
        XCTAssertTrue(app.staticTexts["Nothing waiting in #general"].firstMatch.waitForExistence(timeout: 5))
        capture("waiting-todo-done")

        // Jump to All channels from empty state, verify accessible multi-select toggle + waiting to-dos
        let showAll = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Show all channels")).firstMatch
        XCTAssertTrue(showAll.waitForExistence(timeout: 5))
        showAll.tap()
        XCTAssertTrue(app.staticTexts["Which screens should we audit first on iPhone SE?"].firstMatch.waitForExistence(timeout: 5))
        let multiOption = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "To-dos list and detail")).firstMatch
        XCTAssertTrue(multiOption.waitForExistence(timeout: 5))
        XCTAssertEqual(multiOption.value as? String, "Not checked")
        multiOption.tap()
        XCTAssertEqual(multiOption.value as? String, "Checked")
        let mobileTodo = app.staticTexts["Review dark mode token audit for iPhone SE"].firstMatch
        for _ in 0..<4 where !mobileTodo.exists {
            app.swipeUp()
        }
        XCTAssertTrue(mobileTodo.exists, "Expected #mobile waiting to-do in All channels")
        capture("waiting-workspace")
    }
}
