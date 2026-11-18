import AuthenticationServices
import Combine

@MainActor
final class SignIn: ObservableObject {
    @Published private(set) var session: HumanSession?
    @Published private(set) var pending = false
    @Published private(set) var failed = false

    enum Startup { case waiting, waitingForUnlock, restoring, ready, retryRestore, retrySignOut }
    @Published private(set) var startup = Startup.waiting
    private let deployment = Deployment.current
    private lazy var storage = deployment.map { SessionPersistence(origin: $0.origin) }
    private var tokens: LoginTokens?
    private var rotation: Task<Void, Error>?
    // GoTrue may already have rotated before a temporary device-storage error.
    private var awaitingSave: LoginTokens?

    private var browser: ASWebAuthenticationSession?
    private var deadline: Task<Void, Never>?
    private var exchange: Task<Void, Never>?
    private var current: UUID?
    private var presenter: Presenter?

    private final class Presenter: NSObject, ASWebAuthenticationPresentationContextProviding {
        let window: ASPresentationAnchor
        init(_ window: ASPresentationAnchor) { self.window = window }
        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window }
    }

    func start(_ provider: BrowserProvider, origin: URL, publicKey: String, window: ASPresentationAnchor) {
        guard startup == .ready, session == nil, !pending else { return }
        guard let attempt = try? SignInAttempt(provider: provider) else { failed = true; return }
        let id = UUID()
        let expires = ContinuousClock.now.advanced(by: .seconds(300))
        current = id
        presenter = Presenter(window)
        failed = false
        pending = true
        let callback: ASWebAuthenticationSession.Callback
        switch provider {
        case .google: callback = .https(host: "commonswarm.com", path: "/ios/auth/callback")
        case .github: callback = .customScheme("com.commonswarm.ios")
        }
        let browser = ASWebAuthenticationSession(url: attempt.authorize(at: origin), callback: callback) {
            [weak self] url, error in
            Task { @MainActor in
                guard let self, self.current == id, self.browser != nil else { return }
                guard ContinuousClock.now < expires else { self.finish(failed: true); return }
                self.browser = nil // Consume only the active system session's completion.
                if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    self.finish()
                    return
                }
                guard error == nil, let url, let code = try? attempt.code(from: url) else {
                    self.finish(failed: true)
                    return
                }
                self.exchange = Task {
                    do {
                        let result = try await attempt.exchange(code: code, at: origin, publicKey: publicKey)
                        guard self.current == id else { return }
                        guard ContinuousClock.now < expires else { self.finish(failed: true); return }
                        try self.accept(result)
                        self.finish()
                    } catch {
                        if self.current == id { self.finish(failed: true) }
                    }
                }
            }
        }
        self.browser = browser
        browser.presentationContextProvider = presenter
        guard browser.start() else { finish(failed: true); return }
        deadline = Task {
            do { try await Task.sleep(for: .seconds(300)) } catch { return }
            if current == id { finish(failed: true) }
        }
    }

    private func finish(failed: Bool = false) {
        current = nil
        browser?.cancel()
        browser = nil
        deadline?.cancel()
        deadline = nil
        exchange?.cancel()
        exchange = nil
        presenter = nil
        pending = false
        self.failed = failed
    }

    func restore() async {
        guard startup == .waiting || startup == .waitingForUnlock || startup == .retryRestore else { return }
        guard let deployment, let storage else { startup = .ready; return }
        startup = .restoring
        do {
            try await storage.restore(unlocked: UIApplication.shared.isProtectedDataAvailable) { saved in
                try await self.rotate(saved, deployment)
            }
            startup = .ready
        } catch SessionStorageError.locked {
            startup = .waitingForUnlock
        } catch SessionStorageError.pendingSignOut {
            startup = .retrySignOut
        } catch {
            if startup == .restoring { startup = .retryRestore }
        }
    }

    func didUnlock() async {
        if startup == .waitingForUnlock { await restore() }
        else if startup == .retrySignOut { signOut() }
    }

    func completeEmailSignIn(_ result: LoginTokens) throws {
        guard startup == .ready, session == nil, !pending else { throw SignInError.unavailable }
        try accept(result)
        finish()
    }

    private func accept(_ result: LoginTokens) throws {
        guard let storage else { throw SignInError.unavailable }
        try storage.keychain.save(SavedLogin(userID: result.userID, refreshToken: result.refreshToken))
        tokens = result
        if session == nil {
            session = HumanSession(userID: result.userID) { [weak self] in
                guard let self else { throw CancellationError() }
                return try await self.bearer()
            }
        }
    }

    private func bearer() async throws -> String {
        guard let deployment, let tokens else { throw CancellationError() }
        if tokens.expiresAt.timeIntervalSinceNow <= 30 {
            try await rotate(SavedLogin(userID: tokens.userID, refreshToken: tokens.refreshToken), deployment)
        }
        guard let current = self.tokens else { throw CancellationError() }
        return current.accessToken
    }

    // All windows and API calls share one rotation. A cancelled reader cannot cancel its siblings.
    private func rotate(_ saved: SavedLogin, _ deployment: Deployment) async throws {
        if let rotation { return try await rotation.value }
        let task = Task {
            defer { if !Task.isCancelled { rotation = nil } }
            do {
                let result: LoginTokens
                if let awaitingSave {
                    result = awaitingSave
                } else {
                    result = try await LoginTokens.refresh(saved.refreshToken, at: deployment.origin, publicKey: deployment.publicKey)
                }
                try Task.checkCancellation()
                guard result.userID == saved.userID else { throw SignInError.sessionEnded }
                awaitingSave = result
                try accept(result)
                awaitingSave = nil
            } catch SignInError.sessionEnded {
                try Task.checkCancellation()
                signOut()
                throw SignInError.sessionEnded
            }
        }
        rotation = task
        try await task.value
    }

    func signOut() {
        finish()
        rotation?.cancel()
        rotation = nil
        awaitingSave = nil
        tokens = nil
        session?.signOut()
        session = nil
        guard let storage else { startup = .ready; return }
        do {
            try storage.signOut()
            startup = .ready
        } catch {
            startup = .retrySignOut
        }
    }
}
