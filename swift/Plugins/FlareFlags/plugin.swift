// Generates a typed property per flag from the target's flags.json, on
// every build. Add flags.json to the target (or anywhere up to four folders
// above it) and this plugin to the target's build tool plugins.

import Foundation
import PackagePlugin

/// flags.json among the target's files, else the nearest one above `dir`.
func findFlags(in files: [URL], above dir: URL) -> URL? {
    if let file = files.first(where: { $0.lastPathComponent == "flags.json" }) { return file }
    var current = dir
    for _ in 0..<5 {
        let candidate = current.appending(path: "flags.json")
        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        let parent = current.deletingLastPathComponent()
        if parent == current { break }
        current = parent
    }
    return nil
}

func command(flags: URL, tool: URL, workDirectory: URL) -> Command {
    let output = workDirectory.appending(path: "FlareFlags.swift")
    return .buildCommand(
        displayName: "Generating flags from \(flags.lastPathComponent)",
        executable: tool,
        arguments: [flags.path, output.path],
        inputFiles: [flags],
        outputFiles: [output]
    )
}

struct NoFlags: Error, CustomStringConvertible {
    var target: String
    var description: String {
        "FlareFlags: no flags.json in \(target) or the folders above it. Add one: {\"flags\": {\"new-checkout\": {\"default\": false}}}"
    }
}

@main
struct FlareFlags: BuildToolPlugin {
    func createBuildCommands(context: PluginContext, target: Target) async throws -> [Command] {
        guard let target = target as? SourceModuleTarget else { return [] }
        let files = target.sourceFiles.map(\.url)
        guard let flags = findFlags(in: files, above: target.directoryURL) else { throw NoFlags(target: target.name) }
        return [command(flags: flags, tool: try context.tool(named: "FlareFlagsGen").url, workDirectory: context.pluginWorkDirectoryURL)]
    }
}

#if canImport(XcodeProjectPlugin)
import XcodeProjectPlugin

extension FlareFlags: XcodeBuildToolPlugin {
    func createBuildCommands(context: XcodePluginContext, target: XcodeTarget) throws -> [Command] {
        let files = target.inputFiles.map(\.url)
        guard let flags = findFlags(in: files, above: context.xcodeProject.directoryURL) else {
            throw NoFlags(target: target.displayName)
        }
        return [command(flags: flags, tool: try context.tool(named: "FlareFlagsGen").url, workDirectory: context.pluginWorkDirectoryURL)]
    }
}
#endif
