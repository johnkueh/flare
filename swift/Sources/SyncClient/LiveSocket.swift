import Foundation
import os

/// The space's live WebSocket: stays connected while the app is in front,
/// backing off between tries, and asks for a sync when another phone
/// pushed something this one hasn't pulled.
@MainActor
public final class LiveSocket {
    public struct Handlers: Sendable {
        /// Still wanted (the app hasn't left the space or turned sync off).
        public var shouldRun: @MainActor @Sendable () -> Bool
        /// The store's cursor, to compare with the server's version.
        public var cursor: @MainActor @Sendable () -> UInt64
        /// Run a sync pass: on every connect, and when the server is ahead.
        public var sync: @MainActor @Sendable () -> Void
        /// After a dropped connection's back-off: a chance to push writes
        /// made while offline.
        public var retry: @MainActor @Sendable () -> Void
        public var log: @MainActor @Sendable (String) -> Void

        public init(
            shouldRun: @escaping @MainActor @Sendable () -> Bool, cursor: @escaping @MainActor @Sendable () -> UInt64,
            sync: @escaping @MainActor @Sendable () -> Void, retry: @escaping @MainActor @Sendable () -> Void = {},
            log: @escaping @MainActor @Sendable (String) -> Void = { _ in }
        ) {
            self.shouldRun = shouldRun
            self.cursor = cursor
            self.sync = sync
            self.retry = retry
            self.log = log
        }
    }

    /// Connected right now.
    public private(set) var isLive = false {
        didSet { if isLive != oldValue { onChange?(isLive) } }
    }
    /// Told whenever `isLive` changes.
    public var onChange: (@MainActor (Bool) -> Void)?

    private var task: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?

    public init() {}

    public var isRunning: Bool { task != nil }

    public func start(client: SpaceClient, spaceID: String, handlers: Handlers) {
        guard task == nil else { return }
        task = Task { await run(client: client, spaceID: spaceID, handlers: handlers) }
    }

    public func stop() {
        task?.cancel()
        task = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        isLive = false
    }

    /// Each connection starts with a sync, so coming back online catches
    /// up without waiting.
    private func run(client: SpaceClient, spaceID: String, handlers: Handlers) async {
        var delay = 1.0
        while !Task.isCancelled, handlers.shouldRun() {
            do {
                let socket = try await client.live(spaceID: spaceID)
                self.socket = socket
                socket.resume()
                try await Self.ping(socket)
                isLive = true
                delay = 1
                handlers.sync()
                let keepAlive = Task {
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(25))
                        if (try? await Self.ping(socket)) == nil { socket.cancel(with: .goingAway, reason: nil) }
                    }
                }
                defer { keepAlive.cancel() }
                while !Task.isCancelled {
                    guard case let .string(text) = try await socket.receive(),
                          let version = (try? JSONDecoder().decode(LiveVersion.self, from: Data(text.utf8)))?.version
                    else { continue }
                    if version > handlers.cursor() { handlers.sync() }
                }
            } catch {
                handlers.log("live socket closed: \(error.localizedDescription)")
            }
            isLive = false
            if Task.isCancelled { return }
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 30)
            handlers.retry()
        }
    }

    private struct LiveVersion: Decodable { var version: UInt64 }

    /// URLSession can call a ping's handler twice (again with an error when
    /// the socket closes under it), and resuming twice traps, so only the
    /// first call counts.
    private nonisolated static func ping(_ socket: URLSessionWebSocketTask) async throws {
        let answered = OSAllocatedUnfairLock(initialState: false)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            socket.sendPing { error in
                let first = answered.withLock { done in
                    defer { done = true }
                    return !done
                }
                guard first else { return }
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }
}
