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

    private func postFixture(_ path: String) throws {
        let exp = expectation(description: "fixture " + path)
        var req = URLRequest(url: URL(string: "http://127.0.0.1:8765" + path)!)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req) { _, _, _ in
            exp.fulfill()
        }.resume()
        wait(for: [exp], timeout: 5)
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

        // 2. Create a new doc from the + New sheet and auto-navigate into it
        let newButton = app.buttons["shared-objects-new-button"].firstMatch
        XCTAssertTrue(newButton.waitForExistence(timeout: 5), "Expected + New toolbar button")
        newButton.tap()
        try tapButton("shared-create-kind-doc")
        let titleField = app.textFields["shared-create-title-field"].firstMatch
        XCTAssertTrue(titleField.waitForExistence(timeout: 5))
        titleField.tap()
        titleField.typeText("Weekend notes")
        let bodyField = app.textViews["shared-create-doc-body"].firstMatch
        XCTAssertTrue(bodyField.waitForExistence(timeout: 5))
        bodyField.tap()
        bodyField.typeText("# Notes\n\nCheck tire pressure.")
        let createSubmit = app.buttons["shared-create-submit-button"].firstMatch
        XCTAssertTrue(createSubmit.waitForExistence(timeout: 5), "Expected Create button in navigation bar")
        XCTAssertTrue(createSubmit.isHittable, "Create button must stay visible and tappable with the keyboard open")
        capture("objects-create-sheet")
        createSubmit.tap()

        XCTAssertTrue(app.staticTexts["Weekend notes"].firstMatch.waitForExistence(timeout: 8), "Expected newly created doc to open")
        let createdNavBar = app.navigationBars["Doc"].firstMatch
        XCTAssertTrue(createdNavBar.waitForExistence(timeout: 5))
        createdNavBar.buttons.element(boundBy: 0).tap()

        // 3. Open shared doc, edit & save, and inspect an earlier revision from history
        XCTAssertTrue(runbook.waitForExistence(timeout: 8))
        runbook.tap()
        XCTAssertTrue(app.staticTexts["Pre-flight checklist"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Atlas, your agent")).firstMatch.exists)

        let editDocButton = app.buttons["shared-doc-edit-button"].firstMatch
        XCTAssertTrue(editDocButton.waitForExistence(timeout: 5), "Expected doc Edit button")
        editDocButton.tap()
        let docEditor = app.textViews["shared-doc-editor"].firstMatch
        XCTAssertTrue(docEditor.waitForExistence(timeout: 5))
        capture("objects-doc-edit")
        try tapButton("shared-doc-save-button")
        XCTAssertTrue(app.staticTexts["Saved"].firstMatch.waitForExistence(timeout: 8), "Expected Saved banner after doc edit")

        // Scroll to Revision history and open earlier revision rev_runbook_1
        let earlierRow = app.buttons["shared-history-row-rev_runbook_1"].firstMatch
        for _ in 0..<4 where !earlierRow.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(earlierRow.waitForExistence(timeout: 5), "Expected earlier revision row in history")
        earlierRow.tap()
        XCTAssertTrue(app.staticTexts["Reading an earlier revision"].firstMatch.waitForExistence(timeout: 8), "Expected earlier revision banner")
        capture("objects-history-earlier")
        try tapButton("shared-history-back-to-current")
        XCTAssertTrue(app.buttons["shared-doc-edit-button"].firstMatch.waitForExistence(timeout: 5))

        let docNavBar = app.navigationBars["Doc"].firstMatch
        XCTAssertTrue(docNavBar.waitForExistence(timeout: 5))
        docNavBar.buttons.element(boundBy: 0).tap()

        // 4. Open shared list -> toggle + add -> trigger 409 conflict -> recover 3-way draft -> confirm & save
        XCTAssertTrue(groceries.waitForExistence(timeout: 8))
        groceries.tap()
        let toggleMilk = app.buttons["shared-list-toggle-item_milk"].firstMatch
        XCTAssertTrue(toggleMilk.waitForExistence(timeout: 8))
        toggleMilk.tap()
        XCTAssertTrue(app.staticTexts["Saved"].firstMatch.waitForExistence(timeout: 8))
        capture("objects-list-detail")

        try postFixture("/fixture/conflict-next-update")
        let toggleTape = app.buttons["shared-list-toggle-item_tape"].firstMatch
        XCTAssertTrue(toggleTape.waitForExistence(timeout: 5))
        toggleTape.tap()

        try tapButton("Recover my draft", timeout: 8)
        XCTAssertTrue(app.staticTexts["Review conflicting changes"].firstMatch.waitForExistence(timeout: 8), "Expected 3-way conflict review card")
        let checkedRow = app.staticTexts["Oat milk and espresso beans"].firstMatch
        XCTAssertTrue(checkedRow.waitForExistence(timeout: 5), "Expected checked comparison row")
        XCTAssertEqual(checkedRow.value as? String, "Checked", "Comparison row must expose Checked accessibility value")
        let uncheckedCompeting = app.staticTexts["Sourdough loaf (added by Maya)"].firstMatch
        XCTAssertTrue(uncheckedCompeting.waitForExistence(timeout: 5), "Expected competing current revision item")
        XCTAssertEqual(uncheckedCompeting.value as? String, "Not checked", "Comparison row must expose Not checked accessibility value")
        capture("objects-conflict-review")

        let confirmBox = app.buttons["shared-conflict-confirm"].firstMatch
        for _ in 0..<3 where !confirmBox.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(confirmBox.waitForExistence(timeout: 5))
        confirmBox.tap()
        let saveConflict = app.buttons["shared-conflict-save"].firstMatch
        XCTAssertTrue(saveConflict.waitForExistence(timeout: 5))
        saveConflict.tap()
        XCTAssertTrue(app.staticTexts["Saved"].firstMatch.waitForExistence(timeout: 8), "Expected Saved banner after conflict resolution")
    }
}
