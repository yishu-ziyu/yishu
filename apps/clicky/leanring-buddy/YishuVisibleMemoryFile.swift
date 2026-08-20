import Foundation

/// The one user-visible memory file. Agent writes it; the user edits it.
enum YishuVisibleMemoryFile {
    static let fileName = "记忆.md"

    static let header = """
    # 记忆

    奕枢会把值得记住的事写在这里。
    你可以直接改、删、加一行。每条用「- 」开头。改完下次说话就会用。

    """

    static let visibleMemoryFileEnvironmentKey = "YISHU_VISIBLE_MEMORY_FILE"

    static var fileURL: URL { resolvedFileURL() }

    static func resolvedFileURL(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> URL {
        if let raw = environment[visibleMemoryFileEnvironmentKey]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !raw.isEmpty {
            return URL(fileURLWithPath: (raw as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Documents", isDirectory: true)
            .appendingPathComponent("Yishu", isDirectory: true)
            .appendingPathComponent(fileName, isDirectory: false)
    }

    @discardableResult
    static func ensureFile(at url: URL = fileURL) -> URL {
        let folder = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: url.path) {
            try? header.write(to: url, atomically: true, encoding: .utf8)
        }
        return url
    }

    static func readText(at url: URL = fileURL) -> String {
        let ready = ensureFile(at: url)
        return (try? String(contentsOf: ready, encoding: .utf8)) ?? header
    }

    static func writeText(_ text: String, at url: URL = fileURL) throws {
        let folder = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }
}
