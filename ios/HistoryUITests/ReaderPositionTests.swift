import XCTest

@MainActor
final class ReaderPositionTests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "com.commonswarm.ios")

    private func tap(_ name: String) throws {
        let button = app.buttons[name].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 8), "Missing " + name)
        button.tap()
    }

    private func scrollToEarlierButton() {
        let button = app.buttons["Load earlier messages"].firstMatch
        for _ in 0..<20 {
            if button.exists && button.isHittable { return }
            app.scrollViews.firstMatch.swipeDown(velocity: .fast)
        }
        XCTFail("Earlier-page control did not enter the viewport")
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func assertAnchor(_ label: String, after action: () -> Void) {
        let row = app.staticTexts[label].firstMatch
        XCTAssertTrue(row.exists && row.isHittable, label + " must be visible before loading")
        let y = row.frame.minY
        screenshot(label + "-before")
        action()
        let samePosition = NSPredicate { _, _ in
            row.exists && row.isHittable && abs(row.frame.minY - y) <= 2
        }
        let restored = XCTNSPredicateExpectation(predicate: samePosition, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [restored], timeout: 5), .completed, label + " moved from y=" + String(describing: y))
        screenshot(label + "-after")
    }

    func testReadingPositionSurvivesPrependAndOlderRetry() throws {
        continueAfterFailure = false
        app.launch()
        try tap("Continue with email")
        let address = app.textFields["Email address"]
        address.tap()
        address.typeText("reader@example.test")
        try tap("Send code")
        let code = app.secureTextFields["Email code"]
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        code.tap()
        code.typeText("012345")
        try tap("Sign in")
        try tap("Simulator workspace")
        try tap("#general")
        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 5))
        scrollToEarlierButton()
        let older = app.buttons["Load earlier messages"].firstMatch
        assertAnchor("History message 81") {
            older.tap()
            // After prepending, the button has moved one page above the reader.
            let moved = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !older.isHittable }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [moved], timeout: 5), .completed)
        }
        scrollToEarlierButton()
        older.tap()
        let retry = app.buttons["Retry"].firstMatch
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        assertAnchor("History message 31") {
            retry.tap()
            XCTAssertTrue(retry.waitForNonExistence(timeout: 5))
            XCTAssertFalse(older.exists)
        }
    }
}
