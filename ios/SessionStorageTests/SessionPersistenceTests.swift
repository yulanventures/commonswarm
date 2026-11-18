import Security
import XCTest
@testable import CommonSwarm

@MainActor
final class SessionPersistenceTests: XCTestCase {
    func testRealItemProtectionOnAddAndRotation() throws {
        let origin = try XCTUnwrap(URL(string: "https://session-witness.invalid/" + UUID().uuidString))
        let keychain = RefreshKeychain(origin: origin)
        defer { try? keychain.remove() }
        let user = UUID()
        let match: [CFString: Any] = [kSecClass: kSecClassGenericPassword,
            kSecAttrService: "com.commonswarm.ios.auth", kSecAttrAccount: origin.absoluteString]
        for rotation in [false, true] {
            if rotation {
                // A previously created synthetic item must acquire the stronger protection on update too.
                let previous = [kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock] as CFDictionary
                XCTAssertEqual(SecItemUpdate(match as CFDictionary, previous), errSecSuccess)
            }
            try keychain.save(SavedLogin(userID: user, refreshToken: UUID().uuidString))
            // Request only the metadata of the test runner's own synthetic item.
            var query = match
            query[kSecReturnAttributes] = true
            query[kSecMatchLimit] = kSecMatchLimitOne
            var result: CFTypeRef?
            XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
            let attributes = try XCTUnwrap(result as? [String: Any])
            XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String, kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
            XCTAssertNotEqual(attributes[kSecAttrSynchronizable as String] as? Bool, true)
            XCTAssertNil(attributes[kSecValueData as String])
        }
    }

    // Only the platform deletion error is supplied. Every coordinator uses the real fence file.
    private final class FailingDelete: LoginKeychain {
        var saved: SavedLogin?
        var refusesDelete = true
        var reads = 0
        func read() -> SavedLogin? { reads += 1; return saved }
        func save(_ login: SavedLogin) { saved = login }
        func remove() throws {
            if refusesDelete { throw CocoaError(.fileWriteNoPermission) }
            saved = nil
        }
    }

    func testDurableSignOutPrecedesRefreshOnImmediateRelaunch() async throws {
        let keychain = FailingDelete()
        keychain.save(SavedLogin(userID: UUID(), refreshToken: UUID().uuidString))
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let fence = folder.appending(path: "signed-out")
        func launch() -> SessionPersistence { SessionPersistence(keychain: keychain, fence: fence) }
        var renewals = 0
        func restore(_ unlocked: Bool) async throws {
            try await launch().restore(unlocked: unlocked) { _ in renewals += 1 }
        }
        do {
            try await restore(false)
            XCTFail("Locked launch must wait")
        } catch SessionStorageError.locked {}
        XCTAssertEqual(keychain.reads, 0)
        XCTAssertEqual(renewals, 0)
        try await restore(true)
        XCTAssertEqual(renewals, 1, "Unlock restores the original session")

        XCTAssertThrowsError(try launch().signOut())
        XCTAssertNotNil(keychain.saved)
        for canDelete in [false, true] {
            keychain.refusesDelete = !canDelete
            do {
                try await restore(true)
                XCTAssertTrue(canDelete)
            } catch SessionStorageError.pendingSignOut { XCTAssertFalse(canDelete) }
            XCTAssertEqual(keychain.reads, 1, "A fenced launch must not read the surviving token")
            XCTAssertEqual(renewals, 1, "A fenced launch must send zero additional refresh requests")
        }
        XCTAssertNil(keychain.saved)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fence.path))
        try await restore(true)
        XCTAssertEqual(renewals, 1)

        try Data([0]).write(to: fence)
        let readsBeforeCorruption = keychain.reads
        do {
            try await restore(true)
            XCTFail("An invalid fence must fail closed")
        } catch let error as CocoaError { XCTAssertEqual(error.code, .fileReadCorruptFile) }
        XCTAssertEqual(keychain.reads, readsBeforeCorruption)
    }
}
