import Foundation
import SyncClient
import Testing

@MainActor
struct FlareLinksTests {
    let config = FlareLinksConfig(
        domain: "example.com",
        name: "Groceries",
        scheme: "groceries",
        links: [
            "invite": .init(path: "/j/:code", deferred: true),
            "item": .init(path: "/lists/:list/items/:item", deferred: nil),
        ]
    )

    func fresh() -> (FlareLinks, [String]) {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        return (FlareLinks(config: config, defaults: defaults), [])
    }

    @Test func readsHttpsWwwAndSchemeLinks() {
        let (links, _) = fresh()
        #expect(links.link(for: URL(string: "https://example.com/j/7KQ2-M9XD")!)?["code"] == "7KQ2-M9XD")
        #expect(links.link(for: URL(string: "https://www.example.com/j/AB/")!)?.url.absoluteString == "https://example.com/j/AB")
        #expect(links.link(for: URL(string: "https://example.com/lists/a%20b/items/2")!)?.params == ["list": "a b", "item": "2"])
        #expect(links.link(for: URL(string: "groceries://link?url=https%3A%2F%2Fexample.com%2Fj%2FXY")!)?["code"] == "XY")
        #expect(links.link(for: URL(string: "https://other.com/j/AB")!) == nil)
        #expect(links.link(for: URL(string: "https://example.com/j")!) == nil)
        #expect(links.link(for: URL(string: "groceries://recipe/1")!) == nil)
    }

    @Test func findsTheLinkInSharedText() {
        let (links, _) = fresh()
        let link = links.link(in: "Join Flat with code 7KQ2-M9XD https://example.com/j/7KQ2-M9XD.")
        #expect(link?.kind == "invite")
        #expect(link?["code"] == "7KQ2-M9XD")
        #expect(links.link(in: "nothing here") == nil)
    }

    @Test func makesLinks() {
        let (links, _) = fresh()
        #expect(links.url("invite", ["code": "7KQ2M9XD"]).absoluteString == "https://example.com/j/7KQ2M9XD")
        #expect(links.url("item", ["list": "a b", "item": "1"]).absoluteString == "https://example.com/lists/a%20b/items/1")
    }

    @Test func claimingSettlesThePendingLink() {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        var events: [String] = []
        let links = FlareLinks(config: config, defaults: defaults) { name, _ in events.append(name) }
        #expect(links.mayHavePendingLink)
        #expect(links.claim(["hello"]) == nil)
        #expect(links.mayHavePendingLink)
        #expect(links.claim(["https://example.com/j/AB"])?["code"] == "AB")
        #expect(!links.mayHavePendingLink)
        #expect(events == ["link_deferred_claimed"])
        // Remembered across launches.
        #expect(!FlareLinks(config: config, defaults: defaults).mayHavePendingLink)
    }

    @Test func noDeferredKindsMeansNothingPending() {
        let plain = FlareLinksConfig(domain: "example.com", name: "X", links: ["item": .init(path: "/i/:id", deferred: nil)])
        #expect(!FlareLinks(config: plain, defaults: UserDefaults(suiteName: UUID().uuidString)!).mayHavePendingLink)
    }

    @Test func decodesLinksJson() throws {
        let json = #"{"domain":"example.com","name":"X","scheme":"x","ios":{"appIds":["ABCDE12345.a.b"]},"links":{"invite":{"path":"/j/:code","deferred":true}}}"#
        let decoded = try FlareLinksConfig(json: Data(json.utf8))
        #expect(decoded.links["invite"]?.deferred == true)
    }
}
