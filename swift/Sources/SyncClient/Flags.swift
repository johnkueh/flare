import Foundation
import Observation
import SyncKit
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Feature flags from the app's `flags.json`, evaluated by Cloudflare
/// Flagship through the app's Worker (`@flare/flags`).
///
/// Add `flags.json` to the app target and the `FlareFlags` build plugin,
/// and each flag becomes a typed property (`flags.newCheckout`), generated
/// at build time. Start it once:
///
/// ```swift
/// let flags = Flags.start(server: URL(string: "https://api.example.com")!)
/// if flags.newCheckout { … }
/// ```
///
/// Reads never wait and never fail: the last values the server sent (kept
/// on disk), else the defaults in flags.json. It refreshes when it starts,
/// when the app comes to the foreground and every few minutes. A flag the
/// app has read keeps its value until the app next comes to the
/// foreground, so a screen doesn't change under the user; flags marked
/// `"live": true` change at once. SwiftUI views that read a flag update
/// when it changes.
@MainActor
@Observable
public final class Flags {
    public struct Options: Sendable {
        /// How often to refresh while the app is open (nil: only on
        /// launch, foreground and `refresh()`).
        public var refreshInterval: Duration?
        /// Extra headers on each request, such as `Authorization`.
        public var headers: (@Sendable () async -> [String: String])?
        /// Extra attributes for targeting. Platform, app version, OS
        /// version and locale are sent already.
        public var context: [String: String]
        /// Where the last values live. Default: Application Support/flare.
        public var directory: URL?
        /// Mounted under a prefix on the Worker, such as "v1".
        public var prefix: String?
        public var session: URLSession

        public init(
            refreshInterval: Duration? = .seconds(300),
            headers: (@Sendable () async -> [String: String])? = nil,
            context: [String: String] = [:],
            directory: URL? = nil,
            prefix: String? = nil,
            session: URLSession = .shared
        ) {
            self.refreshInterval = refreshInterval
            self.headers = headers
            self.context = context
            self.directory = directory
            self.prefix = prefix
            self.session = session
        }
    }

    @ObservationIgnored private let store: FlagStore
    @ObservationIgnored private let endpoint: URL
    @ObservationIgnored private let options: Options
    @ObservationIgnored private var refreshing: Task<[String], Never>?
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var listeners: [UUID: AsyncStream<[String]>.Continuation] = [:]

    /// Bumped when any value changes; reading a flag reads it, so views
    /// that show a flag redraw.
    private var revision = 0
    /// When the Worker last answered.
    public private(set) var fetchedAt: Date?
    /// Why the last refresh failed, or nil.
    public private(set) var lastError: (any Error)?

    /// Use the generated `Flags.start(server:)`, which passes this app's
    /// flags.json. `schema` is flags.json's text.
    public init(server: URL, schema: String, user: String? = nil, options: Options = Options()) throws {
        let dir = options.directory
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "flare")
        store = try FlagStore.open(schemaJson: schema, cachePath: dir.appending(path: "flags.json").path, user: user)
        var url = server
        if let prefix = options.prefix { url = url.appending(path: prefix) }
        endpoint = url.appending(path: "ofrep/v1/evaluate/flags")
        self.options = options
        fetchedAt = store.fetchedAt().map { Date(timeIntervalSince1970: Double($0) / 1000) }
        watchForeground()
        startTicker()
        Task { await refresh() }
    }

    // reads (the generated properties call these)

    public func bool(_ key: String) -> Bool {
        _ = revision
        return store.boolValue(key: key)
    }

    public func int(_ key: String) -> Int {
        _ = revision
        return Int(store.intValue(key: key))
    }

    public func double(_ key: String) -> Double {
        _ = revision
        return store.numberValue(key: key)
    }

    public func string(_ key: String) -> String {
        _ = revision
        return store.stringValue(key: key)
    }

    public func json(_ key: String) -> FlagJSON {
        _ = revision
        return FlagJSON(text: store.valueJson(key: key) ?? "null")
    }

    /// Every flag's value as JSON, without holding any (for a debug screen).
    public var snapshot: String {
        _ = revision
        return store.snapshotJson()
    }

    /// The id flags are evaluated for: the user, else this install.
    public var identity: String { store.identity() }

    /// The flags whose values changed, as they change.
    public func changes() -> AsyncStream<[String]> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<[String]>.makeStream()
        listeners[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor in self?.listeners[id] = nil }
        }
        return stream
    }

    // updates

    /// Asks the Worker for fresh values; returns the flags that changed.
    /// Offline or a server error keeps the values you have (see `lastError`).
    @discardableResult
    public func refresh() async -> [String] {
        if let refreshing { return await refreshing.value }
        let task = Task { await fetch() }
        refreshing = task
        let changed = await task.value
        refreshing = nil
        return changed
    }

    /// Lets flags that were read take their latest values. Called when the
    /// app comes to the foreground; call it yourself at other safe moments.
    @discardableResult
    public func activate() -> [String] {
        let changed = store.activate()
        publish(changed)
        return changed
    }

    /// Evaluates for a signed-in user from now on (nil: this install, after
    /// signing out). Values go back to their defaults until the user's
    /// arrive, which apply at once.
    public func setUser(_ user: String?) async {
        if let refreshing { _ = await refreshing.value }
        publish(store.setUser(user: user))
        await refresh()
    }

    private func fetch() async -> [String] {
        do {
            var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let etag = store.etag() { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
            let extra = await options.headers?() ?? [:]
            for (name, value) in extra { request.setValue(value, forHTTPHeaderField: name) }
            let context = try JSONSerialization.data(withJSONObject: Self.deviceContext.merging(options.context) { $1 })
            let asked = store.identity()
            request.httpBody = Data(try store.requestBody(contextJson: String(decoding: context, as: UTF8.self)).utf8)
            let (data, response) = try await options.session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            // Signed in or out meanwhile: this answer is for someone else.
            guard asked == store.identity() else { return [] }
            let changed = try store.applyResponse(
                status: UInt16(http.statusCode), etag: http.value(forHTTPHeaderField: "ETag"),
                body: String(decoding: data, as: UTF8.self))
            fetchedAt = Date()
            lastError = nil
            publish(changed)
            return changed
        } catch {
            lastError = error
            return []
        }
    }

    private func publish(_ changed: [String]) {
        guard !changed.isEmpty else { return }
        revision += 1
        for l in listeners.values { l.yield(changed) }
    }

    private func startTicker() {
        guard let interval = options.refreshInterval else { return }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard let self else { return }
                await self.refresh()
            }
        }
    }

    private func watchForeground() {
        #if canImport(UIKit)
        let name = UIApplication.willEnterForegroundNotification
        #elseif canImport(AppKit)
        let name = NSApplication.willBecomeActiveNotification
        #endif
        #if canImport(UIKit) || canImport(AppKit)
        observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.activate()
                // Values that arrive within a moment of coming back still
                // count as this foreground's; later ones wait for the next.
                let start = ContinuousClock.now
                Task {
                    await self.refresh()
                    if ContinuousClock.now - start < .seconds(2) { self.activate() }
                }
            }
        })
        #endif
    }

    private static let deviceContext: [String: String] = {
        var c: [String: String] = ["locale": Locale.current.identifier]
        #if os(iOS)
        c["platform"] = "ios"
        #elseif os(macOS)
        c["platform"] = "macos"
        #endif
        let v = ProcessInfo.processInfo.operatingSystemVersion
        c["osVersion"] = "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
        if let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String { c["appVersion"] = app }
        return c
    }()
}

/// An object or array flag. Decode it into your own type:
/// `flags.paywall.decode(Paywall.self)`.
public struct FlagJSON: Sendable, Equatable {
    /// The value as JSON text.
    public let text: String

    public func decode<T: Decodable>(_ type: T.Type = T.self, decoder: JSONDecoder = JSONDecoder()) -> T? {
        try? decoder.decode(T.self, from: Data(text.utf8))
    }

    /// As Foundation objects (`[String: Any]`, `[Any]`).
    public var object: Any? {
        try? JSONSerialization.jsonObject(with: Data(text.utf8), options: .fragmentsAllowed)
    }
}
