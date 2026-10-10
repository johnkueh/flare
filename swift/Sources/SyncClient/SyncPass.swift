import Foundation
import SyncKit

/// One round with the server: push every local write, then pull pages
/// until caught up. The app decides when to run one (launch, foreground,
/// after a local write, when the live socket reports a newer version) and
/// what the changes mean for its screens.
///
/// `changes` holds what reached the store even when `run` throws part way,
/// so the app can still show those.
@MainActor
public final class SyncPass {
    /// Every change applied to the store, pushed or pulled.
    public private(set) var changes: [Change] = []
    /// The server asked for a reset: re-read everything.
    public private(set) var reset = false

    public init() {}

    /// A push that fails is put back (`failPush`) for the next pass, and the
    /// error is rethrown. `pushed` runs after each accepted push, `pulled`
    /// after each page.
    public func run(
        store: SyncStore, client: SpaceClient, spaceID: String, pushed: () -> Void = {}, pulled: () -> Void = {}
    ) async throws {
        while let body = try store.takePush() {
            do {
                let answer = try await client.push(spaceID: spaceID, body: body)
                changes += try store.ackPush(responseJson: answer)
            } catch {
                store.failPush()
                throw error
            }
            pushed()
        }
        var more = true
        while more {
            let page = try await client.changes(spaceID: spaceID, since: try store.cursor())
            let outcome = try store.applyPull(responseJson: page)
            more = outcome.more
            reset = reset || outcome.reset
            changes += outcome.changes
            pulled()
        }
    }
}
