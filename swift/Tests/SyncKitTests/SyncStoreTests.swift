import Foundation
import Testing
@testable import SyncKit

// Runs on the Mac (`swift test` at the repo root) against the macOS slice of
// SyncFFI.xcframework. Merging and convergence are pinned by the Rust
// tests; these check the Swift surface the app uses.

@Suite struct SyncStoreTests {
    private static let schema = #"{"groceries": {"name": "value", "done": "value", "position": "position"}}"#

    private func store() throws -> SyncStore {
        // A folder with a space in it, like Application Support.
        let folder = FileManager.default.temporaryDirectory.appending(path: "Sync Kit \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return try SyncStore.open(path: folder.appending(path: "sync.sqlite").path(percentEncoded: false), schemaJson: Self.schema)
    }

    private struct Row: Decodable {
        var id: String
        var name: String?
        var done: Bool?
    }

    private func rows(_ store: SyncStore) throws -> [Row] {
        try JSONDecoder().decode([Row].self, from: Data(try store.list(collection: "groceries", orderBy: "position").utf8))
    }

    @Test func listsInPositionOrder() throws {
        let store = try store()
        let first = positionBetween(before: nil, after: nil)
        let second = positionBetween(before: first, after: nil)
        try store.putDoc(collection: "groceries", doc: "b", fieldsJson: #"{"name":"Eggs","done":false,"position":"\#(second)"}"#)
        try store.putDoc(collection: "groceries", doc: "a", fieldsJson: #"{"name":"Milk","done":true,"position":"\#(first)"}"#)
        let rows = try rows(store)
        #expect(rows.map(\.name) == ["Milk", "Eggs"])
        #expect(rows.first?.done == true)
    }

    @Test func writesWaitToBePushed() throws {
        let store = try store()
        #expect(try store.pendingCount() == 0)
        try store.putDoc(collection: "groceries", doc: "a", fieldsJson: #"{"name":"Milk"}"#)
        #expect(try store.pendingCount() > 0)
        #expect(try store.takePush() != nil)
        store.failPush()
        #expect(try store.pendingCount() > 0)
    }

    @Test func deletedDocsLeaveTheList() throws {
        let store = try store()
        try store.putDoc(collection: "groceries", doc: "a", fieldsJson: #"{"name":"Milk"}"#)
        try store.deleteDoc(collection: "groceries", doc: "a")
        #expect(try rows(store).isEmpty)
    }

    @Test func readsInviteCodes() {
        #expect(parseInvite(text: "https://example.com/j/7kq2-m9xd") == "7KQ2M9XD")
        #expect(parseInvite(text: "milk") == nil)
        #expect(formatInvite(code: "7KQ2M9XD") == "7KQ2-M9XD")
    }
}
