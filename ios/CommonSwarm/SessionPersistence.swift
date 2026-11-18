import Foundation

struct SavedLogin: Codable {
    let userID: UUID
    let refreshToken: String
}

protocol LoginKeychain {
    func read() throws -> SavedLogin?
    func save(_ login: SavedLogin) throws
    func remove() throws
}

enum SessionStorageError: Error { case locked, pendingSignOut }

@MainActor
struct SessionPersistence {
    let keychain: any LoginKeychain
    let fence: URL

    init(keychain: any LoginKeychain, fence: URL) {
        self.keychain = keychain
        self.fence = fence
    }

    init(origin: URL) {
        let account = Data(origin.absoluteString.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_")
        self.init(keychain: RefreshKeychain(origin: origin),
                  fence: URL.applicationSupportDirectory.appending(path: "sign-out-" + account))
    }

    func restore(unlocked: Bool, renew: (SavedLogin) async throws -> Void) async throws {
        guard unlocked else { throw SessionStorageError.locked }
        let marker: Data
        do {
            marker = try Data(contentsOf: fence)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            if let saved = try keychain.read() { try await renew(saved) }
            return
        }
        // A corrupt or inaccessible fence also prevents reading the credential.
        guard marker == Data([1]) else { throw CocoaError(.fileReadCorruptFile) }
        try finishSignOut()
    }

    func signOut() throws {
        // Commit the intent synchronously before touching the Keychain. This file contains no credential.
        do {
            try FileManager.default.createDirectory(at: fence.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data([1]).write(to: fence, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            // Even if app storage is full, deletion can still complete sign-out.
            try keychain.remove()
            return
        }
        try finishSignOut()
    }

    private func finishSignOut() throws {
        do {
            try keychain.remove()
            try FileManager.default.removeItem(at: fence)
        } catch {
            throw SessionStorageError.pendingSignOut
        }
    }
}
