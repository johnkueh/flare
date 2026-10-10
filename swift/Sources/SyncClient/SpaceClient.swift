import Foundation

// SpaceInfo, InvitePreview, NewSpace and JoinSpace are generated from the
// server's contract (Generated/WireTypes.swift).

extension SpaceInfo {
    public var isOwner: Bool { owner == you }
}

extension SpaceInfo.Device: Identifiable {}

/// The server refused a request. `code` is the protocol's (`NOT_MEMBER`,
/// `NOT_FOUND`, `FULL`, …) or the app's own (`ATTESTATION_REQUIRED`).
public struct SpaceServerError: LocalizedError, Equatable, Sendable {
    public var status: Int
    public var code: String
    public var message: String?

    public var errorDescription: String? { message ?? "Something went wrong. Try again in a moment." }

    /// Removed by the owner, or the space is gone.
    public var isGone: Bool { code == "NOT_MEMBER" || code == "NOT_FOUND" }
}

/// The bearer token every request carries. The app decides how a device
/// proves itself (e.g. App Attest buys a token).
public protocol SpaceTokens: Sendable {
    func token() async throws -> String
    /// Forgets the token, so the next `token()` gets a fresh one.
    func clear()
}

/// `/spaces` over HTTP (`PROTOCOL.md`, "HTTP"). A request that comes back
/// `ATTESTATION_REQUIRED` gets a fresh token and is tried once more.
public final class SpaceClient: Sendable {
    public let baseURL: URL
    private let platform: String
    private let tokens: any SpaceTokens
    private let session: URLSession
    private let isOffline: @Sendable () -> Bool

    /// `isOffline` lets a debug switch fail every request as if offline.
    public init(
        baseURL: URL, platform: String = "ios", tokens: any SpaceTokens, session: URLSession = .shared,
        isOffline: @escaping @Sendable () -> Bool = { false }
    ) {
        self.baseURL = baseURL
        self.platform = platform
        self.tokens = tokens
        self.session = session
        self.isOffline = isOffline
    }

    public func create(name: String, deviceName: String) async throws -> SpaceInfo {
        try await send("POST", "spaces", body: NewSpace(name: name, deviceName: deviceName, platform: platform))
    }

    public func preview(code: String) async throws -> InvitePreview {
        try await send("GET", "invites/\(code)")
    }

    public func join(spaceID: String, code: String, deviceName: String) async throws -> SpaceInfo {
        try await send("POST", "spaces/\(spaceID)/join", body: JoinSpace(code: code, deviceName: deviceName, platform: platform))
    }

    public func info(spaceID: String) async throws -> SpaceInfo {
        try await send("GET", "spaces/\(spaceID)")
    }

    public func leave(spaceID: String) async throws {
        _ = try await data("POST", "spaces/\(spaceID)/leave", body: Data("{}".utf8))
    }

    /// `body` comes from `SyncStore.takePush()`; the answer goes to `ackPush`.
    public func push(spaceID: String, body: String) async throws -> String {
        String(decoding: try await data("POST", "spaces/\(spaceID)/push", body: Data(body.utf8)), as: UTF8.self)
    }

    /// One page of changes, for `SyncStore.applyPull`.
    public func changes(spaceID: String, since: UInt64) async throws -> String {
        String(decoding: try await data("GET", "spaces/\(spaceID)/changes", query: [URLQueryItem(name: "since", value: String(since))]), as: UTF8.self)
    }

    /// Stores a file under the hex SHA-256 of its bytes.
    public func putBlob(spaceID: String, hash: String, data: Data, contentType: String = "image/jpeg") async throws {
        _ = try await self.data("PUT", "spaces/\(spaceID)/blobs/\(hash)", body: data, contentType: contentType)
    }

    /// A file the space stored with `putBlob`.
    public func blob(spaceID: String, hash: String) async throws -> Data {
        try await data("GET", "spaces/\(spaceID)/blobs/\(hash)")
    }

    /// The space's WebSocket, not yet resumed. It sends `{"version": N}`
    /// after every push that changed something.
    public func live(spaceID: String) async throws -> URLSessionWebSocketTask {
        guard !isOffline() else { throw URLError(.notConnectedToInternet) }
        var components = URLComponents(url: baseURL.appending(path: "spaces/\(spaceID)/live"), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(try await tokens.token())", forHTTPHeaderField: "Authorization")
        return session.webSocketTask(with: request)
    }

    // MARK: Plumbing

    private struct ErrorBody: Decodable {
        var code: String
        var message: String?
    }

    private func send<Response: Decodable>(_ method: String, _ path: String) async throws -> Response {
        try JSONDecoder().decode(Response.self, from: try await data(method, path))
    }

    private func send<Response: Decodable>(_ method: String, _ path: String, body: some Encodable) async throws -> Response {
        let payload = try JSONEncoder().encode(body)
        return try JSONDecoder().decode(Response.self, from: try await data(method, path, body: payload))
    }

    private func data(
        _ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil,
        contentType: String = "application/json"
    ) async throws -> Data {
        do {
            return try await attempt(method, path, query: query, body: body, contentType: contentType)
        } catch let error as SpaceServerError where error.code == "ATTESTATION_REQUIRED" {
            // The token expired or the server forgot it: get another, once.
            tokens.clear()
            return try await attempt(method, path, query: query, body: body, contentType: contentType)
        }
    }

    private func attempt(
        _ method: String, _ path: String, query: [URLQueryItem], body: Data?, contentType: String
    ) async throws -> Data {
        guard !isOffline() else { throw URLError(.notConnectedToInternet) }
        var request = URLRequest(url: baseURL.appending(path: path).appending(queryItems: query))
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(try await tokens.token())", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let error = try? JSONDecoder().decode(ErrorBody.self, from: data)
            throw SpaceServerError(status: status, code: error?.code ?? "UNKNOWN", message: error?.message)
        }
        return data
    }
}
