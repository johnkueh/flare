import CryptoKit
import DeviceCheck
import Foundation
import Security

/// Accounts on a Flare server (`AUTH.md`), as the `SpaceTokens` a
/// `SpaceClient` takes. The phone signs in as an anonymous user the first
/// time it needs a token, proving with App Attest that it's a genuine copy
/// of the app. Signing in with Apple or an email code later links that
/// user, so nothing is lost.
///
/// The session token lives in the Keychain; the App Attest key's id lives
/// in UserDefaults.
public final class FlareAuth: SpaceTokens {
    /// Where the auth routes are mounted, e.g. `https://api.example.com/v1/auth`.
    public let baseURL: URL
    /// Sign in without App Attest. For the simulator (where App Attest
    /// doesn't run) against a server with `FLARE_AUTH_ALLOW_UNATTESTED` on.
    public let allowUnattested: Bool
    private let session: URLSession
    private let name: String
    private let anonymous = SignInOnce()

    /// `allowUnattested` defaults to on wherever App Attest isn't supported
    /// (the simulator). `name` keys the Keychain item and UserDefaults.
    public init(baseURL: URL, allowUnattested: Bool? = nil, session: URLSession = .shared, name: String = "flare.auth") {
        self.baseURL = baseURL
        self.allowUnattested = allowUnattested ?? !DCAppAttestService.shared.isSupported
        self.session = session
        self.name = name
    }

    /// The attested key this install signs in with, once it has one. The
    /// server records it as the session's device.
    public var deviceId: String? { UserDefaults.standard.string(forKey: "\(name).keyId") }

    /// The stored session token, or a new anonymous user's.
    public func token() async throws -> String {
        if let token = storedToken() { return token }
        // Many requests can ask at once on first launch; they share one sign-in.
        return try await anonymous.run {
            if let token = self.storedToken() { return token }
            return try await self.signIn("sign-in/anonymous", body: [:])
        }
    }

    public func clear() {
        SecItemDelete(keychainQuery() as CFDictionary)
    }

    /// Sign in with Apple's identity token (and the raw nonce, if the
    /// request had one). The anonymous user becomes this account.
    @discardableResult
    public func signInWithApple(idToken: String, nonce: String? = nil) async throws -> String {
        var token: [String: Any] = ["token": idToken]
        if let nonce { token["nonce"] = nonce }
        return try await signIn("sign-in/social", body: ["provider": "apple", "idToken": token])
    }

    /// Emails a sign-in code for `signInWithEmailCode`.
    public func sendEmailCode(_ email: String) async throws {
        _ = try await post("email-otp/send-verification-otp", body: ["email": email, "type": "sign-in"])
    }

    /// Signs in with the emailed code. The anonymous user becomes this account.
    @discardableResult
    public func signInWithEmailCode(email: String, code: String) async throws -> String {
        try await signIn("sign-in/email-otp", body: ["email": email, "otp": code])
    }

    /// Ends the session on the server and forgets it. The next `token()`
    /// starts a new anonymous user.
    public func signOut() async {
        if let token = storedToken() {
            // Best effort: signed out on the phone either way.
            _ = try? await post("sign-out", body: [:], headers: ["Authorization": "Bearer \(token)"])
        }
        clear()
    }

    // MARK: Signing in

    /// POSTs a sign-in with a fresh assertion (and the current session, so
    /// Better Auth links it), and keeps the token that comes back. A server
    /// that doesn't know the key gets a new one, once.
    private func signIn(_ path: String, body: [String: Any]) async throws -> String {
        do {
            return try await signInOnce(path, body: body)
        } catch let error as SpaceServerError where error.code == "ATTESTATION_REQUIRED" && !allowUnattested {
            forgetKey()
            return try await signInOnce(path, body: body)
        } catch let error as DCError where error.code == .invalidKey {
            // The key is gone from this phone (e.g. restored from a backup).
            forgetKey()
            return try await signInOnce(path, body: body)
        }
    }

    private func signInOnce(_ path: String, body: [String: Any]) async throws -> String {
        var headers = try await attestationHeaders()
        if let token = storedToken() { headers["Authorization"] = "Bearer \(token)" }
        let (_, response) = try await post(path, body: body, headers: headers)
        guard let token = response.value(forHTTPHeaderField: "set-auth-token"), !token.isEmpty else {
            throw SpaceServerError(status: response.statusCode, code: "NO_TOKEN", message: nil)
        }
        store(token)
        return token
    }

    /// `X-Attest-Challenge` and an App Attest assertion over it, or none
    /// when unattested.
    private func attestationHeaders() async throws -> [String: String] {
        guard !allowUnattested else { return [:] }
        let keyId = try await registeredKey()
        let challenge = try await challenge()
        let assertion = try await DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: Self.hash(challenge))
        return [
            "X-Attest-Challenge": challenge,
            "X-App-Attest-Key-Id": keyId,
            "X-App-Attest-Assertion": assertion.base64EncodedString(),
        ]
    }

    /// This install's App Attest key, registered with the server the first
    /// time it's needed.
    private func registeredKey() async throws -> String {
        if let keyId = deviceId { return keyId }
        let service = DCAppAttestService.shared
        let keyId = try await service.generateKey()
        let challenge = try await challenge()
        let attestation = try await service.attestKey(keyId, clientDataHash: Self.hash(challenge))
        _ = try await post("attest/apple", body: [
            "keyId": keyId, "attestation": attestation.base64EncodedString(), "challenge": challenge,
        ])
        UserDefaults.standard.set(keyId, forKey: "\(name).keyId")
        return keyId
    }

    private func forgetKey() {
        UserDefaults.standard.removeObject(forKey: "\(name).keyId")
    }

    /// A one-time challenge from the server.
    private func challenge() async throws -> String {
        struct Challenge: Decodable { var challenge: String }
        let (data, _) = try await send("GET", "attest/challenge", body: nil, headers: [:])
        return try JSONDecoder().decode(Challenge.self, from: data).challenge
    }

    /// What App Attest signs: SHA-256 of the challenge's UTF-8.
    private static func hash(_ challenge: String) -> Data {
        Data(SHA256.hash(data: Data(challenge.utf8)))
    }

    // MARK: Keychain

    private func keychainQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: name, kSecAttrAccount as String: "session"]
    }

    private func storedToken() -> String? {
        var query = keychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func store(_ token: String) {
        clear()
        var query = keychainQuery()
        query[kSecValueData as String] = Data(token.utf8)
        // Readable in the background once the phone has been unlocked, so
        // a sync can run then; never leaves this phone in a backup.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    // MARK: Plumbing

    private struct ErrorBody: Decodable {
        var code: String?
        var message: String?
    }

    private func post(_ path: String, body: [String: Any], headers: [String: String] = [:]) async throws -> (Data, HTTPURLResponse) {
        try await send("POST", path, body: try JSONSerialization.data(withJSONObject: body), headers: headers)
    }

    private func send(_ method: String, _ path: String, body: Data?, headers: [String: String]) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        for (field, value) in headers { request.setValue(value, forHTTPHeaderField: field) }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard let http = response as? HTTPURLResponse, (200..<300).contains(status) else {
            let error = try? JSONDecoder().decode(ErrorBody.self, from: data)
            throw SpaceServerError(status: status, code: error?.code ?? "UNKNOWN", message: error?.message)
        }
        return (data, http)
    }
}

/// Runs one sign-in at a time for everyone who asks while it's running.
private actor SignInOnce {
    private var running: Task<String, Error>?

    func run(_ work: @escaping @Sendable () async throws -> String) async throws -> String {
        if let running { return try await running.value }
        let task = Task { try await work() }
        running = task
        defer { running = nil }
        return try await task.value
    }
}
