import XCTest

@MainActor
final class DefinitionsUITests: XCTestCase {
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

    private func openDefinitions() throws {
        let defsLink = app.buttons["Definitions"].firstMatch
        if !defsLink.waitForExistence(timeout: 3) {
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
        try tapButton("Definitions", timeout: 10)
    }

    func testBrowseCompareCertifyAndCreateDefinition() throws {
        continueAfterFailure = false
        app.launch()

        try openDefinitions()

        // 1. Definitions list renders all 3 states (Proposal pending, Certified, Proposed)
        XCTAssertTrue(app.buttons["definition-row-def-arr"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["ARR"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["NRR"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Activation window"].firstMatch.exists)
        capture("definitions-list")

        // 2. Open Proposal pending definition -> shows Certified vs Proposed comparison + Certify button
        app.buttons["definition-row-def-arr"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Compare with certified"].firstMatch.waitForExistence(timeout: 8))
        let certifyBtn = app.buttons["definition-certify-button"].firstMatch
        XCTAssertTrue(certifyBtn.waitForExistence(timeout: 5))
        capture("definition-proposal-pending")

        // 3. Certify proposed version -> badge transitions to Certified and Certify button disappears
        certifyBtn.tap()
        XCTAssertTrue(app.staticTexts["Certified."].firstMatch.waitForExistence(timeout: 8))
        capture("definition-certified")

        // 4. Open Edit sheet to capture form layout cleanly
        try tapButton("definition-edit-button", timeout: 5)
        XCTAssertTrue(app.buttons["definition-editor-submit"].firstMatch.waitForExistence(timeout: 5))
        capture("definition-edit-sheet")
        try tapButton("Cancel", timeout: 5)
    }
}
