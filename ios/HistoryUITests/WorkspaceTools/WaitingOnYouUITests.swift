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

    func testChannelWaitingSheetInCardAnswerAndScopeSwitch() throws {
        continueAfterFailure = false
        app.launch()

        try openGeneralChannel()

        let waitingButton = app.buttons["waiting-on-you-button"].firstMatch
        XCTAssertTrue(waitingButton.waitForExistence(timeout: 8), "Expected Waiting on you button in channel header")
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

        // Jump to All channels from empty state
        let showAll = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Show all channels")).firstMatch
        XCTAssertTrue(showAll.waitForExistence(timeout: 5))
        showAll.tap()
        XCTAssertTrue(app.staticTexts["Which screens should we audit first on iPhone SE?"].firstMatch.waitForExistence(timeout: 5))
        capture("waiting-workspace")
    }
}
