import Foundation
import Observation
import UserNotifications
#if canImport(UIKit)
import UIKit
#endif

/// Where this phone stands on notifications, the same four states on iOS
/// and Android (`PUSH.md`).
public enum PushPermission: String, Sendable, Codable {
    /// Never asked: the system prompt is still available.
    case notAsked = "not_asked"
    /// Delivered quietly to Notification Center (iOS provisional). A full
    /// ask is still available.
    case quiet
    case allowed
    /// Denied. Only Settings can turn them back on.
    case blocked
}

/// Push notifications from a Flare server (`@flare/push`): the permission,
/// the APNs token, and keeping the server's copy of both current.
///
/// No UI. Show your own inline entry point ("Get told when Mia adds to the
/// list") where the feature lives, and call `request()` from its button.
/// App Review rejects a screen before the system prompt that has a "Not
/// now" exit, so the button goes straight to the prompt (PUSH.md).
///
/// ```swift
/// let push = FlarePush(baseURL: api, tokens: auth)
/// // The token and taps: @UIApplicationDelegateAdaptor(FlarePushAppDelegate.self),
/// // with FlarePushAppDelegate.push = push.
/// // On launch and whenever the scene becomes active:
/// await push.refresh()
/// ```
@MainActor
@Observable
public final class FlarePush {
    /// The current state; SwiftUI views reading it update by themselves.
    public private(set) var permission: PushPermission = .notAsked

    /// Whether to show an ask now: the system prompt is available and the
    /// app hasn't been snoozed recently.
    public var canAsk: Bool {
        guard permission == .notAsked || permission == .quiet else { return false }
        guard let until = defaults.object(forKey: key("snoozedUntil")) as? Date else { return true }
        return until <= Date()
    }

    /// Where the routes are mounted, e.g. `https://api.example.com/v1`.
    public let baseURL: URL
    private let tokens: SpaceTokens
    private let appId: String?
    private let environment: APNsEnvironment
    private let defaults: UserDefaults
    private let session: URLSession
    private let name: String
    private let onEvent: (@MainActor (String, [String: String]) -> Void)?

    public enum APNsEnvironment: String, Sendable {
        case sandbox, production
        /// Read from the app's provisioning profile: development-signed
        /// builds (Xcode, the simulator) are sandbox, App Store and
        /// TestFlight builds production.
        case automatic
    }

    /// `onEvent` gets `push_prompt_shown`, `push_permission_result`,
    /// `push_permission_changed` and `push_opened`; hand them to your
    /// telemetry client for an opt-in funnel.
    public init(
        baseURL: URL,
        tokens: SpaceTokens,
        appId: String? = Bundle.main.bundleIdentifier,
        environment: APNsEnvironment = .automatic,
        defaults: UserDefaults = .standard,
        session: URLSession = .shared,
        name: String = "flare.push",
        onEvent: (@MainActor (String, [String: String]) -> Void)? = nil
    ) {
        self.baseURL = baseURL
        self.tokens = tokens
        self.appId = appId
        self.environment = environment
        self.defaults = defaults
        self.session = session
        self.name = name
        self.onEvent = onEvent
        if let raw = defaults.string(forKey: key("permission")), let saved = PushPermission(rawValue: raw) {
            permission = saved
        }
    }

    // MARK: Permission

    /// Reads the system setting (the user may have changed it in Settings),
    /// registers for a token when notifications can show, and updates the
    /// server. Call on launch and whenever the app comes to the foreground.
    public func refresh() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        update(Self.state(for: settings.authorizationStatus))
        if permission == .allowed || permission == .quiet { registerForRemoteNotifications() }
        await upload()
    }

    /// The system prompt. Call it from a button the person tapped, at the
    /// moment the value is obvious. Returns the new state.
    @discardableResult
    public func request() async -> PushPermission {
        await ask(options: [.alert, .sound, .badge], quiet: false)
    }

    /// Quiet (provisional) delivery with no prompt: notifications go to
    /// Notification Center, and the first one offers Keep or Turn Off. A
    /// later `request()` can still ask for the full thing.
    @discardableResult
    public func requestQuiet() async -> PushPermission {
        await ask(options: [.alert, .sound, .badge, .provisional], quiet: true)
    }

    /// The person dismissed your ask: `canAsk` is false for `days`.
    public func snooze(days: Int = 14) {
        defaults.set(Date().addingTimeInterval(TimeInterval(days) * 86_400), forKey: key("snoozedUntil"))
    }

    #if canImport(UIKit)
    /// This app's notification settings, the only way back from `blocked`.
    public func openSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
    #endif

    private func ask(options: UNAuthorizationOptions, quiet: Bool) async -> PushPermission {
        let mode = quiet ? "quiet" : "full"
        if !quiet { emit("push_prompt_shown", ["mode": mode]) }
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: options)) ?? false
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        update(Self.state(for: settings.authorizationStatus))
        emit("push_permission_result", ["mode": mode, "granted": granted ? "true" : "false", "permission": permission.rawValue])
        if permission == .allowed || permission == .quiet { registerForRemoteNotifications() }
        await upload()
        return permission
    }

    private func update(_ next: PushPermission) {
        let previous = permission
        permission = next
        defaults.set(next.rawValue, forKey: key("permission"))
        if previous != next { emit("push_permission_changed", ["from": previous.rawValue, "to": next.rawValue]) }
    }

    static func state(for status: UNAuthorizationStatus) -> PushPermission {
        switch status {
        case .notDetermined: .notAsked
        case .provisional: .quiet
        case .denied: .blocked
        // .authorized, and .ephemeral (App Clips, iOS only).
        default: .allowed
        }
    }

    private func registerForRemoteNotifications() {
        #if canImport(UIKit)
        UIApplication.shared.registerForRemoteNotifications()
        #endif
    }

    // MARK: Token

    /// The APNs token, from `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`.
    public func didRegister(deviceToken: Data) async {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        defaults.set(hex, forKey: key("token"))
        await upload()
    }

    /// Stops notifications to this phone (signing out, say).
    public func unregister() async {
        defaults.removeObject(forKey: key("token"))
        defaults.removeObject(forKey: key("uploaded"))
        _ = try? await send("DELETE", body: nil)
    }

    /// The notification's key and data, for routing a tap, and records the
    /// open. Call it from `userNotificationCenter(_:didReceive:)`.
    @discardableResult
    public func opened(_ userInfo: [AnyHashable: Any]) -> (key: String, data: [String: String])? {
        guard let key = userInfo["key"] as? String else { return nil }
        let data = userInfo["data"] as? [String: String] ?? [:]
        emit("push_opened", ["key": key])
        return (key, data)
    }

    /// Sends the token and permission when either changed, or once a week
    /// so the server knows the device is still around.
    private func upload() async {
        guard let token = defaults.string(forKey: key("token")) else { return }
        var body: [String: Any] = [
            "platform": "ios",
            "token": token,
            "apnsEnv": resolvedEnvironment.rawValue,
            "permission": permission.rawValue,
            "locale": Locale.current.identifier,
        ]
        if let appId { body["appId"] = appId }
        let signature = "\(token)|\(permission.rawValue)|\(resolvedEnvironment.rawValue)|\(appId ?? "")"
        if let last = defaults.dictionary(forKey: key("uploaded")),
           last["signature"] as? String == signature,
           let at = last["at"] as? Date, Date().timeIntervalSince(at) < 7 * 86_400 {
            return
        }
        do {
            try await send("PUT", body: body)
            defaults.set(["signature": signature, "at": Date()], forKey: key("uploaded"))
        } catch {
            // Tried again on the next refresh.
        }
    }

    private var resolvedEnvironment: APNsEnvironment {
        switch environment {
        case .sandbox, .production: environment
        case .automatic: Self.provisioningEnvironment() ?? .production
        }
    }

    /// `aps-environment` from embedded.mobileprovision. App Store and
    /// TestFlight builds have no profile; the simulator is always sandbox.
    static func provisioningEnvironment() -> APNsEnvironment? {
        #if targetEnvironment(simulator)
        return .sandbox
        #else
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1),
              let start = text.range(of: "<?xml"),
              let end = text.range(of: "</plist>"),
              let plist = try? PropertyListSerialization.propertyList(
                  from: Data(text[start.lowerBound..<end.upperBound].utf8), format: nil
              ) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              let aps = entitlements["aps-environment"] as? String
        else { return nil }
        return aps == "development" ? .sandbox : .production
        #endif
    }

    private func send(_ method: String, body: [String: Any]?) async throws {
        do {
            try await sendOnce(method, body: body)
        } catch let error as SpaceServerError where error.status == 401 {
            tokens.clear()
            try await sendOnce(method, body: body)
        }
    }

    private func sendOnce(_ method: String, body: [String: Any]?) async throws {
        var request = URLRequest(url: baseURL.appending(path: "push/device"))
        request.httpMethod = method
        request.setValue("Bearer \(try await tokens.token())", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw SpaceServerError(status: status, code: json?["code"] as? String ?? "HTTP_\(status)", message: json?["message"] as? String)
        }
    }

    private func emit(_ event: String, _ params: [String: String]) {
        onEvent?(event, params)
    }

    private func key(_ suffix: String) -> String { "\(name).\(suffix)" }
}

#if canImport(UIKit)
/// The app-delegate side of push, so an app doesn't write it:
///
/// ```swift
/// @main struct MyApp: App {
///     @UIApplicationDelegateAdaptor(FlarePushAppDelegate.self) var delegate
///     init() {
///         FlarePushAppDelegate.push = push
///         FlarePushAppDelegate.onOpen = { key, data in router.open(key, data) }
///     }
/// }
/// ```
///
/// It hands the APNs token to `push`, shows notifications that arrive while
/// the app is open, and passes taps to `onOpen` (after `push.opened`
/// records them). An app with its own delegate subclasses this one and
/// calls `super` where it overrides.
@MainActor
open class FlarePushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    public static var push: FlarePush?
    /// A tapped notification's key and data.
    public static var onOpen: ((String, [String: String]) -> Void)?
    /// How a notification shows while the app is open. Default: as a banner.
    public static var foreground: UNNotificationPresentationOptions = [.banner, .list, .sound]

    open func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    open func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await Self.push?.didRegister(deviceToken: deviceToken) }
    }

    open func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        // No token, usually the simulator without a signed-in Apple account or
        // a missing aps-environment entitlement. refresh() asks again.
    }

    nonisolated open func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        await MainActor.run { Self.foreground }
    }

    nonisolated open func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let key = info["key"] as? String else { return }
        let data = info["data"] as? [String: String] ?? [:]
        await MainActor.run {
            _ = Self.push?.opened(["key": key, "data": data])
            Self.onOpen?(key, data)
        }
    }
}
#endif
