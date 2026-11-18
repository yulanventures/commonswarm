import CryptoKit
import Foundation
import Security

enum SignInError: Error {
    case invalidCallback, unavailable, refused, rateLimited, emailSignupDisabled
}

enum BrowserProvider: String {
    case github, google

    var callback: URL {
        switch self {
        case .github: URL(string: "com.commonswarm.ios://auth/callback")!
        case .google: URL(string: "https://commonswarm.com/ios/auth/callback")!
        }
    }
}

struct SignInAttempt {
    let provider: BrowserProvider
    let verifier: String
    let state: String

    init(provider: BrowserProvider = .github) throws {
        self.provider = provider
        verifier = Self.base64URL(try Self.randomBytes())
        state = try Self.randomBytes().map { String(format: "%02x", $0) }.joined()
    }

    private static func randomBytes() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw SignInError.unavailable
        }
        return Data(bytes)
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    func authorize(at origin: URL) -> URL {
        let redirect = provider.callback.appending(queryItems: [URLQueryItem(name: "state", value: state)])
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        return origin.appending(path: "auth/v1/authorize").appending(queryItems: [
            URLQueryItem(name: "provider", value: provider.rawValue),
            URLQueryItem(name: "code_challenge_method", value: "s256"),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "redirect_to", value: redirect.absoluteString)
        ])
    }

    func code(from callback: URL) throws -> String {
        guard let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              callback.absoluteString.components(separatedBy: "?").first == provider.callback.absoluteString,
              parts.scheme == provider.callback.scheme, parts.percentEncodedHost == provider.callback.host,
              parts.percentEncodedPath == provider.callback.path, parts.user == nil, parts.password == nil,
              parts.port == nil, parts.fragment == nil,
              let query = parts.queryItems, query.count == 2,
              query.contains(URLQueryItem(name: "state", value: state)),
              let code = query.first(where: { $0.name == "code" })?.value,
              !code.isEmpty else { throw SignInError.invalidCallback }
        return code
    }

    func exchange(code: String, at origin: URL, publicKey: String) async throws -> HumanSession {
        let url = origin.appending(path: "auth/v1/token")
            .appending(queryItems: [URLQueryItem(name: "grant_type", value: "pkce")])
        let data = try await AuthRequest.post(["auth_code": code, "code_verifier": verifier], to: url, publicKey: publicKey)
        return try await HumanSession.decode(data)
    }
}

struct EmailCodeAPI {
    let origin: URL
    let publicKey: String

    func send(to email: String) async throws {
        struct Request: Encodable {
            let email: String
            let create_user = false
        }
        do {
            _ = try await AuthRequest.post(Request(email: email), to: origin.appending(path: "auth/v1/otp"), publicKey: publicKey)
        } catch SignInError.emailSignupDisabled {
            // Stock GoTrue reports an unknown address when sign-up is disabled for this request.
            // Show the same code entry screen as for an existing account.
        }
    }

    func verify(email: String, code: String) async throws -> HumanSession {
        let data = try await AuthRequest.post(["email": email, "token": code, "type": "email"],
                                              to: origin.appending(path: "auth/v1/verify"), publicKey: publicKey)
        return try await HumanSession.decode(data)
    }
}

private enum AuthRequest {
    private struct Rejection: Decodable { let error_code: String }

    static func post(_ body: some Encodable, to url: URL, publicKey: String) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(publicKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let transport = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
        defer { transport.finishTasksAndInvalidate() }
        let (data, response) = try await transport.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode
        if status == 429 { throw SignInError.rateLimited }
        if status == 422, (try? JSONDecoder().decode(Rejection.self, from: data))?.error_code == "otp_disabled" {
            throw SignInError.emailSignupDisabled
        }
        guard status == 200 else { throw SignInError.refused }
        try Task.checkCancellation()
        return data
    }
}

final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

fileprivate struct TokenResponse: Decodable {
    struct User: Decodable { let id: UUID }
    let user: User
    let access_token: String
}


// All adapters for this login share one transport. Sign-out both closes it and
// withdraws the credential, including from callers retained by a pending UI task.
@MainActor
final class HumanSession {
    nonisolated let userID: UUID
    private struct DraftKey: Hashable { let workspace: UUID; let conversation: Conversation.ID }
    private var drafts: [DraftKey: Composer] = [:]
    private var accessToken: String?
    private let transport = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
    var isActive: Bool { accessToken != nil }

    fileprivate static func decode(_ data: Data) throws -> HumanSession {
        let result = try JSONDecoder().decode(TokenResponse.self, from: data)
        guard !result.access_token.isEmpty else { throw SignInError.refused }
        return HumanSession(result)
    }

    private init(_ response: TokenResponse) {
        userID = response.user.id
        accessToken = response.access_token
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        guard let accessToken else { throw CancellationError() }
        var authorized = request
        authorized.setValue("Bearer " + accessToken, forHTTPHeaderField: "Authorization")
        let response = try await transport.data(for: authorized)
        guard isActive else { throw CancellationError() }
        try Task.checkCancellation()
        return response
    }

    func composer(workspace: UUID, conversation: Conversation.ID) -> Composer {
        let key = DraftKey(workspace: workspace, conversation: conversation)
        if let draft = drafts[key] { return draft }
        let draft = Composer()
        drafts[key] = draft
        return draft
    }

    func signOut() {
        drafts.removeAll()
        accessToken = nil
        transport.invalidateAndCancel()
    }

    deinit { transport.invalidateAndCancel() }
}
