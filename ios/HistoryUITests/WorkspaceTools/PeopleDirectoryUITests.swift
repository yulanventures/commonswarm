import XCTest

@MainActor
final class PeopleDirectoryUITests: XCTestCase {
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

    private func openPeopleDirectory() throws {
        let link = app.buttons["People & agents"].firstMatch
        if !link.waitForExistence(timeout: 3) {
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
        try tapButton("People & agents", timeout: 10)
    }

    func testPeopleDirectoryTabsSearchAndDetail() throws {
        continueAfterFailure = false
        app.launch()

        try openPeopleDirectory()

        // 1. Default Agents tab shows Atlas (Active, Local) and Beacon (Hosted MCP)
        XCTAssertTrue(app.staticTexts["Atlas"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Beacon"].firstMatch.exists)
        capture("people-agents-tab")

        // 2. Open Agent detail and expand technical details
        try tapButton("agent-row-00000000-0000-4000-8000-000000000002")
        XCTAssertTrue(app.staticTexts["Local · live listener"].firstMatch.waitForExistence(timeout: 8))
        try tapButton("agent-detail-technical-toggle")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "cswarm 0.14.2")).firstMatch.waitForExistence(timeout: 5))
        capture("people-agent-detail")

        let agentNav = app.navigationBars["Agent"].firstMatch
        XCTAssertTrue(agentNav.waitForExistence(timeout: 5))
        agentNav.buttons.element(boundBy: 0).tap()

        // 3. Switch to People tab and verify owners/admins/members
        try tapButton("people-tab-people")
        XCTAssertTrue(app.staticTexts["Alex Rivera"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Maya Chen"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Devon Park"].firstMatch.exists)
        capture("people-people-tab")

        // 4. Switch to Admins tab and verify human managers + agent admin grant
        try tapButton("people-tab-admins")
        XCTAssertTrue(app.staticTexts["People who manage this workspace"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Agents with scoped admin access"].firstMatch.exists)
        capture("people-admins-tab")
    }
}
