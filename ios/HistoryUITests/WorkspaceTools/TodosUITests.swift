import XCTest

@MainActor
final class TodosUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "com.commonswarm.ios")

    private let longTitle = "Finalize Q4 mobile release checklist and confirm production sign-in flow with security and design"

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

    private func signInIfNeeded() throws {
        let todosButton = app.buttons["To-dos"].firstMatch
        if todosButton.waitForExistence(timeout: 3) {
            return
        }
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
        if !todosButton.waitForExistence(timeout: 5) {
            let workspace = app.buttons["Simulator workspace"].firstMatch
            if workspace.waitForExistence(timeout: 3) {
                workspace.tap()
            }
        }
    }

    func testTodosListAndDetailDisplayNamedAssigneesAndAllStates() throws {
        continueAfterFailure = false
        app.launch()

        try signInIfNeeded()
        try tapButton("To-dos", timeout: 10)

        let taskTitle = app.staticTexts[longTitle].firstMatch
        XCTAssertTrue(taskTitle.waitForExistence(timeout: 8), "Expected populated long-title to-do in list")
        XCTAssertTrue(app.staticTexts["Maya Chen"].firstMatch.waitForExistence(timeout: 5), "Expected named person assignee in list")
        XCTAssertTrue(app.staticTexts["Atlas"].firstMatch.waitForExistence(timeout: 5), "Expected named agent assignee in list")
        XCTAssertTrue(app.staticTexts["Unassigned"].firstMatch.waitForExistence(timeout: 5), "Expected Unassigned label in list")
        capture("todos-list")

        try tapButton("All")
        XCTAssertTrue(app.staticTexts["Audit dark mode contrast across workspace list"].firstMatch.waitForExistence(timeout: 5), "Expected done to-do under All")
        XCTAssertTrue(app.staticTexts["Archive legacy preview route after migration"].firstMatch.waitForExistence(timeout: 5), "Expected dropped to-do under All")
        try tapButton("Open")
        XCTAssertTrue(taskTitle.waitForExistence(timeout: 5))

        taskTitle.tap()

        XCTAssertTrue(app.staticTexts["Assigned to"].firstMatch.waitForExistence(timeout: 8), "Expected Assigned to row in detail")
        XCTAssertTrue(app.staticTexts["Maya Chen"].firstMatch.waitForExistence(timeout: 5), "Expected Maya Chen in detail")
        XCTAssertTrue(app.staticTexts["Tue, Nov 24"].firstMatch.waitForExistence(timeout: 5), "Expected local calendar due date in detail")
        XCTAssertTrue(app.staticTexts["Started walking through the release checklist on the test phone."].firstMatch.waitForExistence(timeout: 5), "Expected comment in detail")
        XCTAssertFalse(app.staticTexts["00000000..."].exists, "Detail must never show abbreviated UUID")
        capture("todos-detail")
    }
}
