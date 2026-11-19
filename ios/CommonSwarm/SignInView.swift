import SwiftUI

private typealias ViewState<Value> = SwiftUI.State<Value>

struct SignInView: View {
    @ObservedObject var auth: SignIn
    let deployment: Deployment?
    let window: UIWindow?
    @ViewState private var showEmail = false

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 16) {
                    if let url = Bundle.main.url(forResource: "BrandMark", withExtension: "png"),
                       let mark = UIImage(contentsOfFile: url.path) {
                        Image(uiImage: mark).resizable().frame(width: 64, height: 64).accessibilityHidden(true)
                    }
                    Text("CommonSwarm").font(.largeTitle.bold())
                        .lineLimit(1).minimumScaleFactor(0.4)
                        .frame(maxWidth: .infinity).padding(.bottom, 12)
                    Button { start(.google) } label: { primaryLabel("Continue with Google") }
                        .buttonStyle(.borderedProminent).disabled(!canStart(.google))
                    Button { showEmail = true } label: { primaryLabel("Continue with email") }
                        .buttonStyle(.borderedProminent).disabled(deployment == nil || auth.pending)
                    Button { start(.github) } label: {
                        Text("Continue with GitHub").font(.subheadline).frame(minHeight: 44)
                    }.disabled(!canStart(.github))
                    if auth.failed { Text("Couldn’t sign in. Try again.") }
                    if deployment == nil { Text("Sign-in is unavailable in this build.") }
                }
                .frame(maxWidth: 380).padding(24)
                .frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }
        }
        .sheet(isPresented: $showEmail) {
            if let deployment {
                EmailSignInView(api: EmailCodeAPI(origin: deployment.origin, publicKey: deployment.publicKey),
                                signedIn: auth.completeEmailSignIn)
            }
        }
    }

    private func canStart(_ provider: BrowserProvider) -> Bool {
        guard deployment != nil, window != nil, !auth.pending else { return false }
        switch provider {
        case .google:
            // The custom Google return is confined to a separately enabled USB Debug build.
            #if COMMONSWARM_GOOGLE_HTTPS || (DEBUG && COMMONSWARM_USB_TEST && COMMONSWARM_GOOGLE_USB)
            return true
            #else
            return false
            #endif
        case .github:
            #if DEBUG && targetEnvironment(simulator)
            return true
            #else
            return false
            #endif
        }
    }

    private func start(_ provider: BrowserProvider) {
        guard canStart(provider), let deployment, let window else { return }
        auth.start(provider, origin: deployment.origin, publicKey: deployment.publicKey, window: window)
    }

    private func primaryLabel(_ title: LocalizedStringKey) -> some View {
        Text(title).font(.headline).multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, minHeight: 44)
    }
}

private struct EmailSignInView: View {
    let api: EmailCodeAPI
    let signedIn: (LoginTokens) throws -> Void
    @Environment(\.dismiss) private var dismiss
    @ViewState private var email = ""
    @ViewState private var sentTo: String?
    @ViewState private var code = ""
    @ViewState private var message: String?
    @ViewState private var operation: Task<Void, Never>?
    @FocusState private var focus: Field?
    private enum Field { case email, code }

    var body: some View {
        NavigationStack {
            Form {
                if let sentTo {
                    Section {
                        SecureField("Email code", text: $code)
                            .textContentType(.oneTimeCode).keyboardType(.numberPad).focused($focus, equals: .code)
                            .disabled(operation != nil)
                        Button("Sign in", action: verify)
                            .disabled(operation != nil || !validCode)
                    } header: { Text(verbatim: sentTo) }
                    Section {
                        Button("Send a new code") { send(to: sentTo) }
                        Button("Change email address") {
                            self.sentTo = nil
                            code = ""
                            message = nil
                            focus = .email
                        }
                    }.disabled(operation != nil)
                } else {
                    TextField("Email address", text: $email)
                        .keyboardType(.emailAddress).textContentType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focus, equals: .email).disabled(operation != nil)
                        .onSubmit { if canSend { send(to: address) } }
                    Button("Send code") { send(to: address) }.disabled(!canSend)
                }
                if operation != nil { ProgressView().accessibilityLabel("Signing in") }
                if let message { Text(message) }
            }
            .navigationTitle(sentTo == nil ? "Email" : "Code")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { operation?.cancel(); dismiss() }
                }
            }
            .onAppear { focus = .email }
            .onDisappear { operation?.cancel() }
            .interactiveDismissDisabled(operation != nil)
        }
    }

    private var address: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { operation == nil && !address.isEmpty }
    private var validCode: Bool { !code.isEmpty && code.utf8.allSatisfy { (48...57).contains($0) } }

    private func send(to address: String) {
        guard operation == nil else { return }
        message = nil
        let resend = sentTo != nil
        operation = Task { @MainActor in
            defer { operation = nil }
            do {
                try await api.send(to: address)
                try Task.checkCancellation()
                sentTo = address
                code = ""
                focus = .code
                message = resend ? "Check your email for the new code." : nil
            } catch {
                if !Task.isCancelled { message = errorText(error, fallback: "Couldn’t send a code. Check the address and try again.") }
            }
        }
    }

    private func verify() {
        guard let sentTo, operation == nil, validCode else { return }
        message = nil
        operation = Task { @MainActor in
            defer { operation = nil }
            do {
                let session = try await api.verify(email: sentTo, code: code)
                try Task.checkCancellation()
                code = ""
                try signedIn(session)
            } catch {
                if !Task.isCancelled {
                    message = errorText(error, fallback: "Couldn’t verify the code. Try again or request a new one.")
                }
            }
        }
    }

    private func errorText(_ error: Error, fallback: String) -> String {
        if case SignInError.rateLimited = error { return "Too many attempts. Wait a moment and try again." }
        return fallback
    }
}
