import SwiftUI

/// A shared grocery list on Flare, the same one as the web page in
/// `example/public`. It signs in as an anonymous user on first launch
/// (`FlareAuth`), keeps each list in the Rust store (`SyncStore`), and syncs
/// with `SyncPass` whenever the list's `LiveSocket` says to.
@main
struct GroceriesApp: App {
    @State private var app = AppModel()

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environment(app)
                .tint(.orange)
        }
    }
}
