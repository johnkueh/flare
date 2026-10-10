import Foundation

/// Where an app keeps a space's files (photos) on the phone, by the hex
/// SHA-256 of their bytes, and which ones the server still needs.
@MainActor
public protocol SpaceFileStore: AnyObject {
    /// Files written here that the server doesn't have yet.
    var pending: [String] { get }
    func data(for hash: String) -> Data?
    func uploaded(_ hash: String)
    func has(_ hash: String) -> Bool
    /// Keeps a downloaded file; throws if its bytes don't match its hash.
    func save(_ data: Data, as hash: String) throws
}

/// Moves files between the phone and the space. Files sync separately from
/// documents: a document naming a file that hasn't arrived yet is fine,
/// and the next pass tries again.
public enum SpaceFiles {
    /// Sends pending files in order and stops at the first failure. Each
    /// upload is checked against its hash, and sending one twice is
    /// harmless. Failures go to `failed` (for logging); `sent` runs after
    /// each file that went.
    @MainActor
    public static func upload(
        _ files: some SpaceFileStore, client: SpaceClient, spaceID: String, contentType: String = "image/jpeg",
        failed: (String, Error) -> Void = { _, _ in }, sent: (String) -> Void = { _ in }
    ) async {
        for hash in files.pending {
            guard !Task.isCancelled else { break }
            guard let data = files.data(for: hash) else {
                files.uploaded(hash)
                continue
            }
            do {
                try await client.putBlob(spaceID: spaceID, hash: hash, data: data, contentType: contentType)
                files.uploaded(hash)
                sent(hash)
            } catch {
                failed(hash, error)
                break
            }
        }
    }

    /// Fetches the files in `wanted` this phone hasn't got. One that isn't
    /// on the server yet (its phone hasn't uploaded it) is skipped. True
    /// when any arrived. `tried` runs after each fetch, whether or not it
    /// worked.
    @MainActor
    public static func download(
        _ wanted: some Sequence<String>, into files: some SpaceFileStore, client: SpaceClient, spaceID: String,
        failed: (String, Error) -> Void = { _, _ in }, tried: (String) -> Void = { _ in }
    ) async -> Bool {
        var arrived = false
        for hash in wanted where !files.has(hash) {
            guard !Task.isCancelled else { break }
            do {
                try files.save(try await client.blob(spaceID: spaceID, hash: hash), as: hash)
                arrived = true
            } catch {
                failed(hash, error)
            }
            tried(hash)
        }
        return arrived
    }
}
