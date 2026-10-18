import Foundation
import Observation
import SwiftUI

/// A link the app understands (`LINKS.md`): its kind from links.json, the
/// parts of its path, and the canonical https URL.
public struct FlareLink: Sendable, Hashable {
    public let kind: String
    public let params: [String: String]
    public let url: URL

    public subscript(_ param: String) -> String? { params[param] }
}

/// links.json, as the app bundles it. The same file the Worker serves from.
public struct FlareLinksConfig: Sendable, Decodable {
    public struct Kind: Sendable, Decodable {
        public var path: String
        public var deferred: Bool?

        public init(path: String, deferred: Bool? = nil) {
            self.path = path
            self.deferred = deferred
        }
    }

    public var domain: String
    public var name: String
    public var scheme: String?
    public var links: [String: Kind]

    public init(domain: String, name: String, scheme: String? = nil, links: [String: Kind]) {
        self.domain = domain
        self.name = name
        self.scheme = scheme
        self.links = links
    }

    public init(json: Data) throws {
        self = try JSONDecoder().decode(Self.self, from: json)
    }

    /// `links.json` (or another name) from the app bundle.
    public static func bundled(_ name: String = "links", in bundle: Bundle = .main) throws -> Self {
        guard let url = bundle.url(forResource: name, withExtension: "json") else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: "\(name).json"])
        }
        return try Self(json: Data(contentsOf: url))
    }
}

/// Links that open the app (`@flare/links`): reads the ones it's opened
/// with, makes new ones to share, and picks up the one someone tapped before
/// installing the app.
///
/// iPhone has no install referrer, so the landing page's Get button copies
/// the link, and the app's first screen offers `PasteLinkButton`. Apple's
/// paste button reads the clipboard on one tap, with no "Allow Paste" alert.
///
/// ```swift
/// let links = FlareLinks(config: try .bundled())
/// WindowGroup { RootView() }
///     .onOpenURL { url in if let link = links.opened(url) { router.open(link) } }
///
/// // Onboarding's first screen:
/// if links.mayHavePendingLink { PasteLinkButton(links) { router.open($0) } }
/// ```
@MainActor
@Observable
public final class FlareLinks {
    public nonisolated let config: FlareLinksConfig

    /// True until a link is claimed or `settle()` is called: whether a first
    /// screen should offer to paste a link from before the install. Only
    /// when links.json has a `deferred` kind.
    public private(set) var mayHavePendingLink: Bool

    private let defaults: UserDefaults
    private let name: String
    private let onEvent: (@MainActor (String, [String: String]) -> Void)?

    /// `onEvent` gets `link_opened` and `link_deferred_claimed`, each with
    /// `kind`; hand them to your telemetry client.
    public init(
        config: FlareLinksConfig,
        defaults: UserDefaults = .standard,
        name: String = "flare.links",
        onEvent: (@MainActor (String, [String: String]) -> Void)? = nil
    ) {
        self.config = config
        self.defaults = defaults
        self.name = name
        self.onEvent = onEvent
        let hasDeferred = config.links.values.contains { $0.deferred == true }
        mayHavePendingLink = hasDeferred && !defaults.bool(forKey: "\(name).settled")
    }

    // MARK: Reading

    /// The link a URL points at: https on the links domain (or www.), or
    /// `<scheme>://link?url=…` from the landing page's Open button.
    public nonisolated func link(for url: URL) -> FlareLink? {
        Self.parse(config, url)
    }

    /// The link in some text ("Join Flat on Cooked: https://…"), or nil.
    public nonisolated func link(in text: String) -> FlareLink? {
        for word in text.split(whereSeparator: \.isWhitespace) where word.contains("://") {
            let trimmed = word.trimmingCharacters(in: CharacterSet(charactersIn: ").,;!?\"'<>"))
            if let url = URL(string: trimmed), let link = link(for: url) { return link }
        }
        return nil
    }

    /// For `.onOpenURL`: the link, also reported as `link_opened`. A link
    /// opening the app settles any pending one too.
    public func opened(_ url: URL) -> FlareLink? {
        guard let link = link(for: url) else { return nil }
        onEvent?("link_opened", ["kind": link.kind])
        settle()
        return link
    }

    // MARK: Making

    /// The https link for a kind and its parts.
    public nonisolated func url(_ kind: String, _ params: [String: String]) -> URL {
        guard let pattern = config.links[kind] else { preconditionFailure("no link kind \"\(kind)\" in links.json") }
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        let path = Self.segments(pattern.path).map { part -> String in
            guard part.hasPrefix(":") else { return part }
            let value = params[String(part.dropFirst())] ?? ""
            precondition(!value.isEmpty, "link \"\(kind)\" needs \(part)")
            return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
        }
        return URL(string: "https://\(config.domain)/\(path.joined(separator: "/"))")!
    }

    // MARK: After install

    /// The link in what was pasted, if any. A link settles the pending one
    /// and is reported as `link_deferred_claimed`.
    @discardableResult
    public func claim(_ pasted: [String]) -> FlareLink? {
        guard let link = pasted.lazy.compactMap({ self.link(in: $0) }).first else { return nil }
        onEvent?("link_deferred_claimed", ["kind": link.kind, "via": "paste"])
        settle()
        return link
    }

    /// The person went on without a link: stop offering to paste one.
    public func settle() {
        guard mayHavePendingLink else { return }
        mayHavePendingLink = false
        defaults.set(true, forKey: "\(name).settled")
    }

    // MARK: Parsing (the same rules as @flare/links)

    nonisolated static func parse(_ config: FlareLinksConfig, _ url: URL) -> FlareLink? {
        guard let scheme = url.scheme?.lowercased() else { return nil }
        if let own = config.scheme, scheme == own.lowercased() {
            guard url.host() == "link",
                  let inner = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                  .queryItems?.first(where: { $0.name == "url" })?.value,
                  let innerURL = URL(string: inner)
            else { return nil }
            return parse(config, innerURL)
        }
        guard scheme == "https" || scheme == "http", let host = url.host()?.lowercased(),
              host == config.domain || host == "www.\(config.domain)"
        else { return nil }
        let got = segments(url.path(percentEncoded: true))
        for (kind, pattern) in config.links.sorted(by: { $0.key < $1.key }) {
            let want = segments(pattern.path)
            guard want.count == got.count else { continue }
            var params: [String: String] = [:]
            var matches = true
            for (part, raw) in zip(want, got) {
                guard let value = raw.removingPercentEncoding, !value.isEmpty else { matches = false; break }
                if part.hasPrefix(":") {
                    params[String(part.dropFirst())] = value
                } else if part != value {
                    matches = false
                    break
                }
            }
            if matches {
                let canonical = FlareLinks.canonical(config, kind: kind, params: params)
                return FlareLink(kind: kind, params: params, url: canonical)
            }
        }
        return nil
    }

    private nonisolated static func canonical(_ config: FlareLinksConfig, kind: String, params: [String: String]) -> URL {
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        let path = segments(config.links[kind]!.path).map { part in
            part.hasPrefix(":") ? (params[String(part.dropFirst())] ?? "").addingPercentEncoding(withAllowedCharacters: allowed) ?? "" : part
        }
        return URL(string: "https://\(config.domain)/\(path.joined(separator: "/"))")!
    }

    private nonisolated static func segments(_ path: String) -> [String] {
        path.split(separator: "/").map(String.init)
    }
}

/// Apple's paste button, reading a Flare link from the clipboard: one tap
/// and no "Allow Paste" alert. Calls `onLink` with the link, or `onNoLink`
/// when what was copied isn't one.
public struct PasteLinkButton: View {
    private let links: FlareLinks
    private let onLink: @MainActor (FlareLink) -> Void
    private let onNoLink: (@MainActor () -> Void)?

    public init(
        _ links: FlareLinks,
        onNoLink: (@MainActor () -> Void)? = nil,
        onLink: @escaping @MainActor (FlareLink) -> Void
    ) {
        self.links = links
        self.onLink = onLink
        self.onNoLink = onNoLink
    }

    public var body: some View {
        PasteButton(payloadType: String.self) { strings in
            Task { @MainActor in
                if let link = links.claim(strings) { onLink(link) } else { onNoLink?() }
            }
        }
    }
}
