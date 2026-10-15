import Foundation
import SyncClient
import Testing

// The FlareFlags plugin generated `newCheckout`, `uploadLimit`… from the
// flags.json next to this file. A stub URLProtocol plays the Worker.

final class StubWorker: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var values: [String: Any] = [:]
    nonisolated(unsafe) static var requests: [URLRequest] = []
    nonisolated(unsafe) static var offline = false

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var request = request
        if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            request.httpBody = data
        }
        Self.requests.append(request)
        if Self.offline {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let flags = Self.values.map { ["key": $0.key, "value": $0.value] }
        let body = try! JSONSerialization.data(withJSONObject: ["flags": flags], options: .sortedKeys)
        let etag = "\"\(body.hashValue)\""
        let status = request.value(forHTTPHeaderField: "If-None-Match") == etag ? 304 : 200
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["ETag": etag])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if status == 200 { client?.urlProtocol(self, didLoad: body) }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
@Suite(.serialized) struct FlagsTests {
    let directory = FileManager.default.temporaryDirectory.appending(path: "Flare Flags \(UUID().uuidString)")

    func options() -> Flags.Options {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubWorker.self]
        return Flags.Options(refreshInterval: nil, context: ["build": "test"], directory: directory, session: URLSession(configuration: config))
    }

    /// The bodies of requests for `key`; flags from an earlier test may
    /// still be finishing their launch refresh.
    func bodies(for key: String) -> [[String: [String: String]]] {
        StubWorker.requests.compactMap { $0.httpBody }
            .map { try! JSONSerialization.jsonObject(with: $0) as! [String: [String: String]] }
            .filter { $0["context"]?["targetingKey"] == key }
    }

    init() {
        StubWorker.values = [:]
        StubWorker.requests = []
        StubWorker.offline = false
    }

    @Test func typedDefaultsBeforeTheServerAnswers() {
        StubWorker.offline = true
        let flags = Flags.start(server: URL(string: "https://api.test")!, options: options())
        let checkout: Bool = flags.newCheckout
        let limit: Int = flags.uploadLimit
        let rate: Double = flags.sampleRate
        #expect(checkout == false)
        #expect(limit == 10)
        #expect(rate == 0.5)
        #expect(flags.checkoutCopy == "Buy now")
        #expect(flags.defaultFlag == true, "a key that's a Swift keyword or a member still gets a property")
        struct Paywall: Decodable { var price: String; var trialDays: Int }
        #expect(flags.paywall.decode(Paywall.self)?.trialDays == 7)
    }

    @Test func serverValuesReadFlagsWaitLiveOnesDont() async {
        StubWorker.values = ["new-checkout": true, "upload-limit": 25, "kill-import": true]
        let flags = Flags.start(server: URL(string: "https://api.test")!, options: options())
        #expect(flags.newCheckout == false)  // on screen now
        let changed = await flags.refresh()
        #expect(Set(changed) == ["upload-limit", "kill-import"])
        #expect(flags.newCheckout == false, "read, so it waits for the foreground")
        #expect(flags.uploadLimit == 25)
        #expect(flags.killImport == true)
        #expect(flags.activate() == ["new-checkout"])
        #expect(flags.newCheckout == true)

        #expect(StubWorker.requests.last?.url?.path == "/ofrep/v1/evaluate/flags")
        let body = bodies(for: flags.identity).last ?? [:]
        #expect(body["context"]?["build"] == "test")
        #expect(body["context"]?["platform"] != nil)
    }

    @Test func notModifiedAndOfflineKeepValuesAcrossLaunches() async {
        StubWorker.values = ["upload-limit": 25]
        let first = Flags.start(server: URL(string: "https://api.test")!, options: options())
        _ = await first.refresh()
        #expect(first.uploadLimit == 25)
        #expect(await first.refresh() == [])
        #expect(StubWorker.requests.last?.value(forHTTPHeaderField: "If-None-Match") != nil)

        StubWorker.offline = true
        let relaunched = Flags.start(server: URL(string: "https://api.test")!, options: options())
        #expect(relaunched.uploadLimit == 25, "last known value, offline")
        _ = await relaunched.refresh()
        #expect(relaunched.lastError != nil)
        #expect(relaunched.identity == first.identity)
    }

    @Test func changesStreamAndUsers() async {
        StubWorker.values = ["upload-limit": 25]
        let flags = Flags.start(server: URL(string: "https://api.test")!, options: options())
        let stream = flags.changes()
        _ = await flags.refresh()
        var it = stream.makeAsyncIterator()
        #expect(await it.next() == ["upload-limit"])
        await flags.setUser("u1")
        #expect(flags.identity == "u1")
        #expect(!bodies(for: "u1").isEmpty)
    }
}
