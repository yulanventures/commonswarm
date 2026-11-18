import XCTest

@MainActor
final class SessionUpgradeTests: XCTestCase {
    func testEmailSessionAcrossInPlaceUpdate() async throws {
        let (data, response) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:8765/fixture/upgrade-stage")!)
        try XCTSkipUnless((response as? HTTPURLResponse)?.statusCode == 200, "Run with the upgrade fixture")
        let stage = try JSONDecoder().decode(String.self, from: data)
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "com.commonswarm.ios")
        app.launch()
        let workspace = app.buttons["Simulator workspace"]
        let email = app.buttons["Continue with email"]

        if stage == "sign-in" {
            XCTAssertTrue(email.waitForExistence(timeout: 10))
            email.tap()
            let address = app.textFields["Email address"]
            address.tap()
            address.typeText("reader@example.test")
            app.buttons["Send code"].tap()
            let code = app.secureTextFields["Email code"]
            XCTAssertTrue(code.waitForExistence(timeout: 8))
            code.tap()
            code.typeText("012345")
            app.buttons["Sign in"].tap()
            XCTAssertTrue(workspace.waitForExistence(timeout: 10))
            app.terminate()
            return
        }

        XCTAssertEqual(stage, "restore")
        // A newer build reaches authenticated workspace content without any input.
        XCTAssertTrue(workspace.waitForExistence(timeout: 10))
        XCTAssertFalse(email.exists)
        app.terminate()
        app.launch()

        // A temporary 503 on the next launch must preserve the saved login for Retry.
        XCTAssertTrue(app.staticTexts["Couldn’t restore sign-in"].waitForExistence(timeout: 10))
        XCTAssertFalse(email.exists)
        app.buttons["Retry"].tap()
        XCTAssertTrue(workspace.waitForExistence(timeout: 10))

        // The fixture consumes each refresh token once. This launch needs the replacement.
        app.terminate()
        app.launch()
        XCTAssertTrue(workspace.waitForExistence(timeout: 10))
        app.buttons["Sign out"].tap()
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        app.terminate()
        app.launch()
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        XCTAssertFalse(workspace.exists)
    }
}
