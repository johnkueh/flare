import Foundation
import Observation
import SyncClient
import SyncKit

/// One grocery list: its store on this phone, and the sync that keeps it
/// level with everyone else's.
@MainActor
@Observable
final class ListModel {
    struct Item: Decodable, Identifiable, Hashable {
        var id: String
        var name: String?
        var done: Bool?
        var position: String?
    }

    /// The same collection and fields the web page writes.
    private static let schema = #"{"groceries": {"name": "value", "done": "value", "position": "position"}}"#

    let spaceID: String
    private(set) var items: [Item] = []
    private(set) var info: SpaceInfo?
    private(set) var isLive = false
    private(set) var error: String?

    private let store: SyncStore
    private let client: SpaceClient
    private let socket = LiveSocket()
    private var syncing = false
    private var syncAgain = false

    init(spaceID: String, client: SpaceClient) throws {
        self.spaceID = spaceID
        self.client = client
        store = try SyncStore.open(path: Self.path(spaceID), schemaJson: Self.schema)
        reload()
    }

    private static func path(_ spaceID: String) -> String {
        let folder = URL.applicationSupportDirectory
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appending(path: "\(spaceID).sqlite").path(percentEncoded: false)
    }

    /// Drops a list's local copy (after signing out).
    static func forget(_ spaceID: String) {
        for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: path(spaceID) + suffix) }
    }

    /// Opens the live socket, which syncs on every connect and whenever
    /// someone else pushes.
    func start() {
        socket.onChange = { [weak self] live in self?.isLive = live }
        socket.start(client: client, spaceID: spaceID, handlers: .init(
            shouldRun: { true },
            cursor: { [store] in (try? store.cursor()) ?? 0 },
            sync: { [weak self] in self?.sync() },
            retry: { [weak self] in self?.sync() }
        ))
    }

    func stop() {
        socket.stop()
    }

    func add(_ name: String) {
        let id = UUID().uuidString.replacing("-", with: "").lowercased()
        // Ordered by when it was added, as the web page does.
        let position = String(format: "%015lld", Int64(Date().timeIntervalSince1970 * 1000))
        write { try store.putDoc(collection: "groceries", doc: id, fieldsJson: Self.json(["name": name, "done": false, "position": position])) }
    }

    func toggle(_ item: Item) {
        write { try store.put(collection: "groceries", doc: item.id, field: "done", valueJson: item.done == true ? "false" : "true") }
    }

    /// Writes land in the store first, so they show at once and survive
    /// being offline; the sync pass pushes them.
    private func write(_ change: () throws -> Void) {
        do {
            try change()
            reload()
            sync()
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// One pass at a time; a request during a pass runs another after it.
    func sync() {
        guard !syncing else {
            syncAgain = true
            return
        }
        syncing = true
        Task {
            repeat {
                syncAgain = false
                do {
                    try await SyncPass().run(store: store, client: client, spaceID: spaceID)
                    error = nil
                } catch let error as SpaceServerError where error.isGone {
                    self.error = "You're no longer in this list."
                } catch {
                    self.error = "Offline. Changes will sync when you're back."
                }
                reload()
            } while syncAgain
            syncing = false
            // Someone may have joined since.
            await loadInfo()
        }
    }

    /// The invite code and who's here.
    func loadInfo() async {
        if let info = try? await client.info(spaceID: spaceID) { self.info = info }
    }

    private func reload() {
        guard let json = try? store.list(collection: "groceries", orderBy: "position") else { return }
        items = (try? JSONDecoder().decode([Item].self, from: Data(json.utf8))) ?? []
    }

    private static func json(_ fields: [String: Any]) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: fields), as: UTF8.self)
    }
}
