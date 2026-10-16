// Writes a typed Swift property per flag in flags.json. Run by the
// FlareFlags build plugin on every build, so a new flag needs no step of
// its own: edit flags.json and build.
//
//   FlareFlagsGen <flags.json> <out.swift>
//
// The rules match crates/flags (the Rust core) and flags/src/schema.ts.

import CoreFoundation
import Foundation

struct Failure: Error, CustomStringConvertible {
    var description: String
}

enum Kind {
    case bool, int, double, string, json

    var swiftType: String {
        switch self {
        case .bool: "Bool"
        case .int: "Int"
        case .double: "Double"
        case .string: "String"
        case .json: "FlagJSON"
        }
    }

    var getter: String {
        switch self {
        case .bool: "bool"
        case .int: "int"
        case .double: "double"
        case .string: "string"
        case .json: "json"
        }
    }
}

func kind(of value: Any, type: String?, key: String) throws -> Kind {
    let inferred: Kind
    if let n = value as? NSNumber {
        if CFGetTypeID(n) == CFBooleanGetTypeID() {
            inferred = .bool
        } else {
            inferred = CFNumberIsFloatType(n) ? .double : .int
        }
    } else if value is String {
        inferred = .string
    } else if value is [String: Any] || value is [Any] {
        inferred = .json
    } else {
        throw Failure(description: "\(key): the default can't be null")
    }
    guard let type else { return inferred }
    let explicit: Kind
    switch type {
    case "boolean": explicit = .bool
    case "integer": explicit = .int
    case "number": explicit = .double
    case "string": explicit = .string
    case "object": explicit = .json
    default: throw Failure(description: "\(key): unknown type \"\(type)\"")
    }
    let fits = explicit == inferred || (explicit == .double && inferred == .int)
        || (explicit == .int && inferred == .double && (value as! NSNumber).doubleValue.rounded() == (value as! NSNumber).doubleValue)
    guard fits else { throw Failure(description: "\(key): the default doesn't match its type") }
    return explicit
}

let swiftKeywords: Set<String> = [
    "associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import", "init", "inout",
    "internal", "let", "open", "operator", "private", "protocol", "public", "rethrows", "static", "struct",
    "subscript", "typealias", "var", "break", "case", "continue", "default", "defer", "do", "else", "fallthrough",
    "for", "guard", "if", "in", "repeat", "return", "switch", "where", "while", "as", "catch", "false", "is", "nil",
    "self", "Self", "super", "throw", "throws", "true", "try", "Any", "Type",
]
/// Flags' own members, which a flag can't shadow.
let taken: Set<String> = [
    "bool", "int", "double", "string", "json", "snapshot", "identity", "changes", "refresh", "activate", "setUser",
    "fetchedAt", "lastError", "start", "schemaJSON",
]

/// `new-checkout` → `newCheckout`.
func propertyName(_ key: String) -> String {
    let parts = key.split(whereSeparator: { $0 == "-" || $0 == "_" }).map(String.init)
    var name = parts.enumerated().map { i, p in
        i == 0 ? p.prefix(1).lowercased() + p.dropFirst() : p.prefix(1).uppercased() + p.dropFirst()
    }.joined()
    if taken.contains(name) || swiftKeywords.contains(name) { name += "Flag" }
    return name
}

func comment(_ text: String) -> String {
    text.split(separator: "\n", omittingEmptySubsequences: false).map { "    /// \($0)" }.joined(separator: "\n")
}

func swiftLiteral(_ text: String) -> String {
    var hashes = "#"
    while text.contains("\"\(hashes)") { hashes += "#" }
    return "\(hashes)\"\"\"\n\(text)\n\"\"\"\(hashes)"
}

func generate(input: URL) throws -> String {
    let text = try String(contentsOf: input, encoding: .utf8)
    guard let root = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
          let flags = root["flags"] as? [String: Any]
    else { throw Failure(description: "expected {\"flags\": {...}}") }

    let keyPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
    var properties: [String] = []
    var names: [String: String] = [:]
    for key in flags.keys.sorted() {
        guard key.wholeMatch(of: keyPattern) != nil else {
            throw Failure(description: "\"\(key)\": keys start with a letter and use letters, digits, - and _ (64 at most)")
        }
        guard let def = flags[key] as? [String: Any], let value = def["default"] else {
            throw Failure(description: "\(key): needs a \"default\"")
        }
        let k = try kind(of: value, type: def["type"] as? String, key: key)
        let name = propertyName(key)
        if let other = names[name] { throw Failure(description: "\"\(key)\" and \"\(other)\" both become `\(name)`") }
        names[name] = key
        var doc = (def["description"] as? String).map { comment($0) + "\n" } ?? ""
        let live = (def["live"] as? Bool) == true ? " Live: changes at once." : ""
        doc += "    /// `\(key)`. Default: `\(String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys, .withoutEscapingSlashes]), as: UTF8.self))`.\(live)\n"
        properties.append("\(doc)    public var \(name): \(k.swiftType) { \(k.getter)(\"\(key)\") }")
    }

    return """
    // Generated by Flare's FlareFlags build plugin from \(input.lastPathComponent).
    // Edit flags.json, not this file: it's written again on every build.

    import Foundation
    import SyncClient

    extension Flags {
    \(properties.joined(separator: "\n\n"))

        /// flags.json, as this app was built with it.
        public static let schemaJSON = \(swiftLiteral(text.trimmingCharacters(in: .whitespacesAndNewlines)))

        /// This app's flags: values from the last run straight away, fresh
        /// ones from `server` (the Worker answering `/ofrep/v1/evaluate/flags`).
        public static func start(server: URL, user: String? = nil, options: Options = Options()) -> Flags {
            // flags.json was checked when this file was generated.
            try! Flags(server: server, schema: schemaJSON, user: user, options: options)
        }
    }

    """
}

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write(Data("usage: FlareFlagsGen <flags.json> <out.swift>\n".utf8))
    exit(2)
}
let input = URL(fileURLWithPath: args[1])
do {
    let out = try generate(input: input)
    let dest = URL(fileURLWithPath: args[2])
    // Leave the file alone when nothing changed, so nothing recompiles.
    if (try? String(contentsOf: dest, encoding: .utf8)) != out {
        try out.write(to: dest, atomically: true, encoding: .utf8)
    }
} catch {
    // Xcode shows "path: error: message" against the file.
    FileHandle.standardError.write(Data("\(input.path): error: \(error)\n".utf8))
    exit(1)
}
