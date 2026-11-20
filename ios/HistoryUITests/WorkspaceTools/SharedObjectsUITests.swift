import XCTest

@MainActor
final class SharedObjectsUITests: XCTestCase {
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

    private func openListsAndDocs() throws {
        let listsLink = app.buttons["Lists & docs"].firstMatch
        if !listsLink.waitForExistence(timeout: 3) {
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
        try tapButton("Lists & docs", timeout: 10)
    }

    func testListsAndDocsBrowseEditListAndReadDoc() throws {
        continueAfterFailure = false
        app.launch()

        try openListsAndDocs()

        // 1. Collection screen shows both List and Doc rows (and excludes File)
        let groceries = app.buttons["shared-object-row-obj_groceries"].firstMatch
        XCTAssertTrue(groceries.waitForExistence(timeout: 8), "Expected shared list row")
        let runbook = app.buttons["shared-object-row-obj_runbook"].firstMatch
        XCTAssertTrue(runbook.exists, "Expected shared doc row")
        XCTAssertFalse(app.staticTexts["Q4-invoice.pdf"].exists, "File objects must not appear in Lists & docs")
        capture("objects-list")

        // 2. Open shared list, toggle an item (VoiceOver Checked state), add an item
        groceries.tap()
        let toggleMilk = app.buttons["shared-list-toggle-item_milk"].firstMatch
        XCTAssertTrue(toggleMilk.waitForExistence(timeout: 8), "Expected checklist toggle row")
        XCTAssertEqual(toggleMilk.value as? String, "Not checked")
        toggleMilk.tap()
        XCTAssertTrue(app.staticTexts["Saved"].firstMatch.waitForExistence(timeout: 8), "Expected Saved confirmation banner")
        XCTAssertEqual(toggleMilk.value as? String, "Checked")

        let addField = app.textFields["shared-list-add-field"].firstMatch
        XCTAssertTrue(addField.waitForExistence(timeout: 5))
        addField.tap()
        addField.typeText("Wood glue")
        let addButton = app.buttons["shared-list-add-button"].firstMatch
        XCTAssertTrue(addButton.waitForExistence(timeout: 5))
        addButton.tap()
        XCTAssertTrue(app.staticTexts["Wood glue"].firstMatch.waitForExistence(timeout: 8), "Expected newly added item to appear from server reload")
        capture("objects-list-detail")

        // 3. Go back and open shared doc (inert Markdown + agent attribution)
        let listNavBar = app.navigationBars["List"].firstMatch
        XCTAssertTrue(listNavBar.waitForExistence(timeout: 5))
        listNavBar.buttons.element(boundBy: 0).tap()

        XCTAssertTrue(runbook.waitForExistence(timeout: 8))
        runbook.tap()
        XCTAssertTrue(app.staticTexts["Pre-flight checklist"].firstMatch.waitForExistence(timeout: 8), "Expected doc heading")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Atlas, your agent")).firstMatch.exists, "Expected agent attribution")
        capture("objects-doc-detail")
    }
}
