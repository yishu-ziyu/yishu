import Foundation

enum QualityDiagnosticsStore {
    static func exportDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("YishuDiagnostics-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let versions: [String: String] = [
            "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown",
            "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        try JSONSerialization.data(withJSONObject: versions, options: [.prettyPrinted])
            .write(to: root.appendingPathComponent("versions.json"))
        return root
    }
}
