// Crashes and hangs for iOS apps on Flare telemetry, from MetricKit: no
// signal handlers and no extra dependency. Copy this file next to
// `telemetry_sdk.swift` (same module), then at launch:
//
//     let telemetry = try TelemetryClient(config: …)
//     FlareCrashes.start(telemetry)
//
// MetricKit delivers a crash or hang on the launch after it happens, for
// users who share analytics with app developers (the same people App Store
// Connect counts). Each one becomes a `crash` / `hang` event with the
// crashed thread's frames (binary + offset, symbolicate with the dSYM) and
// the previous run's breadcrumbs. Handled errors: `telemetry.reportError(e)`.

import Foundation
import MachO

#if canImport(MetricKit) && os(iOS)
import MetricKit

public final class FlareCrashes: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var current: FlareCrashes?

    private let client: TelemetryClient

    private init(client: TelemetryClient) {
        self.client = client
    }

    /// Subscribe to MetricKit and report Rust panics. Safe to call twice.
    @discardableResult
    public static func start(_ client: TelemetryClient) -> FlareCrashes {
        lock.lock()
        defer { lock.unlock() }
        if let current { return current }
        let crashes = FlareCrashes(client: client)
        current = crashes
        client.installPanicHook()
        MXMetricManager.shared.add(crashes)
        return crashes
    }

    public func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            let occurredAt = Int64(payload.timeStampEnd.timeIntervalSince1970 * 1000)
            for crash in payload.crashDiagnostics ?? [] {
                client.report(report: Self.report(crash, occurredAt: occurredAt))
            }
            for hang in payload.hangDiagnostics ?? [] {
                let seconds = hang.hangDuration.converted(to: .seconds).value
                client.report(report: ProblemReport(
                    kind: .hang,
                    typeName: "hang",
                    message: String(format: "main thread blocked for %.1f s", seconds),
                    frames: Self.frames(hang.callStackTree),
                    fromPreviousRun: true,
                    occurredAtMs: occurredAt,
                    appVersion: hang.applicationVersion,
                    appBuild: hang.metaData.applicationBuildVersion
                ))
            }
        }
        client.flush()
    }

    private static func report(_ crash: MXCrashDiagnostic, occurredAt: Int64) -> ProblemReport {
        var typeName = [
            crash.exceptionType.map { exceptionName($0.int32Value) },
            crash.signal.map { signalName($0.int32Value) },
        ].compactMap { $0 }.joined(separator: " ")
        var message = crash.terminationReason ?? ""
        if #available(iOS 17.0, *), let reason = crash.exceptionReason {
            // An uncaught Objective-C exception (NSInvalidArgumentException, …).
            typeName = reason.exceptionName
            message = reason.composedMessage
        }
        return ProblemReport(
            kind: .crash,
            typeName: typeName.isEmpty ? "crash" : typeName,
            message: message,
            frames: frames(crash.callStackTree),
            fromPreviousRun: true,
            occurredAtMs: occurredAt,
            appVersion: crash.applicationVersion,
            appBuild: crash.metaData.applicationBuildVersion
        )
    }

    /// The crashed (attributed) thread, innermost frame first. MetricKit nests
    /// each caller under `subFrames` of the frame it called.
    private static func frames(_ tree: MXCallStackTree) -> [StackFrame] {
        guard
            let json = try? JSONSerialization.jsonObject(with: tree.jsonRepresentation()) as? [String: Any],
            let stacks = json["callStacks"] as? [[String: Any]],
            let stack = stacks.first(where: { $0["threadAttributed"] as? Bool == true }) ?? stacks.first,
            var frame = (stack["callStackRootFrames"] as? [[String: Any]])?.first
        else { return [] }
        var out: [StackFrame] = []
        while out.count < 50 {
            let module = frame["binaryName"] as? String ?? "?"
            out.append(StackFrame(
                module: module,
                offset: (frame["offsetIntoBinaryTextSegment"] as? NSNumber)?.uint64Value,
                imageId: frame["binaryUUID"] as? String,
                inApp: FlareAppImages.names.contains(module)
            ))
            guard let next = (frame["subFrames"] as? [[String: Any]])?.first else { break }
            frame = next
        }
        return out
    }

    private static func exceptionName(_ code: Int32) -> String {
        switch code {
        case 1: "EXC_BAD_ACCESS"
        case 2: "EXC_BAD_INSTRUCTION"
        case 3: "EXC_ARITHMETIC"
        case 5: "EXC_SOFTWARE"
        case 6: "EXC_BREAKPOINT"
        case 10: "EXC_CRASH"
        case 11: "EXC_RESOURCE"
        case 12: "EXC_GUARD"
        default: "EXC_\(code)"
        }
    }

    private static func signalName(_ signal: Int32) -> String {
        switch signal {
        case SIGABRT: "SIGABRT"
        case SIGBUS: "SIGBUS"
        case SIGSEGV: "SIGSEGV"
        case SIGTRAP: "SIGTRAP"
        case SIGILL: "SIGILL"
        case SIGFPE: "SIGFPE"
        case SIGKILL: "SIGKILL"
        default: "SIG\(signal)"
        }
    }
}

#endif

/// The app's own binaries: the executable and its embedded frameworks.
enum FlareAppImages {
    static let names: Set<String> = {
        var names: Set<String> = []
        if let exe = Bundle.main.executableURL?.lastPathComponent { names.insert(exe) }
        if let dir = Bundle.main.privateFrameworksURL,
           let items = try? FileManager.default.contentsOfDirectory(atPath: dir.path)
        {
            for item in items where item.hasSuffix(".framework") {
                names.insert(String(item.dropLast(".framework".count)))
            }
        }
        return names
    }()

    /// The UUID in a loaded binary's Mach-O header (LC_UUID): the key its
    /// dSYM is found by, in the same shape MetricKit's `binaryUUID` uses.
    static func uuid(_ header: UnsafeMutableRawPointer) -> String? {
        let mh = header.load(as: mach_header_64.self)
        guard mh.magic == MH_MAGIC_64 else { return nil }
        var command = UnsafeRawPointer(header) + MemoryLayout<mach_header_64>.size
        for _ in 0..<mh.ncmds {
            let lc = command.load(as: load_command.self)
            if lc.cmd == UInt32(LC_UUID) {
                return UUID(uuid: command.load(as: uuid_command.self).uuid).uuidString
            }
            command += Int(lc.cmdsize)
        }
        return nil
    }
}

extension TelemetryClient {
    /// Count a caught error as an `error` event, with the caller's stack
    /// (binary + offset + UUID, plus a symbol when one is exported).
    public func reportError(_ error: Error) {
        let addresses = Thread.callStackReturnAddresses.dropFirst()
        let frames = addresses.prefix(50).map { value -> StackFrame in
            var info = Dl_info()
            let address = UInt(truncating: value)
            guard dladdr(UnsafeRawPointer(bitPattern: address), &info) != 0, let base = info.dli_fbase else {
                return StackFrame(module: "?", inApp: false)
            }
            let module = info.dli_fname.map { URL(fileURLWithPath: String(cString: $0)).lastPathComponent } ?? "?"
            return StackFrame(
                module: module,
                function: info.dli_sname.map { String(cString: $0) },
                offset: UInt64(address - UInt(bitPattern: base)),
                imageId: FlareAppImages.uuid(base),
                inApp: FlareAppImages.names.contains(module)
            )
        }
        report(report: ProblemReport(
            kind: .error,
            typeName: String(reflecting: type(of: error)),
            message: String(describing: error),
            frames: Array(frames)
        ))
    }
}
