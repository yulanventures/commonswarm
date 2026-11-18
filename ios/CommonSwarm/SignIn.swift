import AuthenticationServices
import Combine

@MainActor
final class SignIn: ObservableObject {
    @Published private(set) var session: HumanSession?
    @Published private(set) var pending = false
    @Published private(set) var failed = false

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
        guard !pending else { return }
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
                        self.session = result
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

    func completeEmailSignIn(_ result: HumanSession) {
        finish()
        session = result
    }

    func signOut() {
        finish()
        session?.signOut()
        session = nil
    }
}
