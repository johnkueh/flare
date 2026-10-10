// swift-tools-version: 6.2
//
// Sync for Swift apps. Two libraries:
//
//   SyncKit     the Rust store (crate sync-ffi) through UniFFI
//   SyncClient  the HTTP client, sync pass, file transfer and live socket
//
// The Rust store (`SyncFFI`) comes prebuilt from the URL below, so an app
// builds without cargo. scripts/publish-binaries.sh builds, uploads and
// rewrites these two lines after a Rust change. To try a Rust change before
// publishing, build it with scripts/build-xcframework.sh: a local
// `swift/SyncFFI.xcframework` wins over the URL. Delete it to go back.

import Foundation
import PackageDescription

let ffiURL = "https://pub-796846793f3e431ab3a92e0577c57dde.r2.dev/SyncFFI-6a0bbcb44ec8.xcframework.zip"
let ffiChecksum = "8d2b7ed772ee6ce4fae24d231d49ae32201b5b7ac10aa55205b13d023e2cf10a"

let localFFI = FileManager.default.fileExists(
    atPath: Context.packageDirectory + "/swift/SyncFFI.xcframework"
)

let package = Package(
    name: "SyncKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "SyncKit", targets: ["SyncKit"]),
        .library(name: "SyncClient", targets: ["SyncClient"]),
    ],
    targets: [
        // Static libraries (iOS device, iOS simulator arm64+x86_64, macOS
        // for `swift test`) plus the C header and module map the UniFFI
        // bindings import as `SyncFFI`.
        localFFI
            ? .binaryTarget(name: "SyncFFI", path: "swift/SyncFFI.xcframework")
            : .binaryTarget(name: "SyncFFI", url: ffiURL, checksum: ffiChecksum),
        // Generated UniFFI bindings.
        .target(
            name: "SyncKit",
            dependencies: ["SyncFFI"],
            path: "swift/Sources/SyncKit",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // Talks to the server; the app supplies tokens and storage.
        .target(
            name: "SyncClient",
            dependencies: ["SyncKit"],
            path: "swift/Sources/SyncClient",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "SyncKitTests",
            dependencies: ["SyncKit"],
            path: "swift/Tests/SyncKitTests",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
