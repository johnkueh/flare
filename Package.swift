// swift-tools-version: 6.2
//
// Flare for Swift apps. Two libraries and a build plugin:
//
//   SyncKit     the Rust store and flags (crate sync-ffi) through UniFFI
//   SyncClient  the HTTP client, sync pass, file transfer, live socket,
//               accounts and feature flags
//   FlareFlags  generates a typed property per flag from the app's
//               flags.json, on every build (FLAGS.md)
//
// The Rust store (`SyncFFI`) comes prebuilt from the URL below, so an app
// builds without cargo. scripts/publish-binaries.sh builds, uploads and
// rewrites these two lines after a Rust change. To try a Rust change before
// publishing, build it with scripts/build-xcframework.sh: a local
// `swift/SyncFFI.xcframework` wins over the URL. Delete it to go back.

import Foundation
import PackageDescription

let ffiURL = "https://pub-796846793f3e431ab3a92e0577c57dde.r2.dev/SyncFFI-6995efe202e9.xcframework.zip"
let ffiChecksum = "ff9e37604e4b6514b9722f4bbe69cd47ef78c9c9d700f2e45d3ef2d3df79e38e"

let localFFI = FileManager.default.fileExists(
    atPath: Context.packageDirectory + "/swift/SyncFFI.xcframework"
)

let package = Package(
    name: "SyncKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "SyncKit", targets: ["SyncKit"]),
        .library(name: "SyncClient", targets: ["SyncClient"]),
        .plugin(name: "FlareFlags", targets: ["FlareFlags"]),
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
        // flags.json → Swift, run by the plugin on the build machine.
        .executableTarget(
            name: "FlareFlagsGen",
            path: "swift/Sources/FlareFlagsGen",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .plugin(
            name: "FlareFlags",
            capability: .buildTool(),
            dependencies: ["FlareFlagsGen"],
            path: "swift/Plugins/FlareFlags"
        ),
        .testTarget(
            name: "SyncKitTests",
            dependencies: ["SyncKit"],
            path: "swift/Tests/SyncKitTests",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        // Flags end to end: the plugin's generated properties over a stub Worker.
        .testTarget(
            name: "FlareFlagsTests",
            dependencies: ["SyncClient"],
            path: "swift/Tests/FlareFlagsTests",
            exclude: ["flags.json"],
            swiftSettings: [.swiftLanguageMode(.v6)],
            plugins: ["FlareFlags"]
        ),
    ]
)
