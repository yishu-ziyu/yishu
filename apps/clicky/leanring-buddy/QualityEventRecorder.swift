import Foundation

enum QualityEventRecorder {
    static var paused = false
    static var testStoreURL: URL?

    private static let allowlist: Set<String> = [
        "appCategory", "actionKind", "providerId", "modelId", "errorCode",
        "stepCount", "verified", "permission", "milestone", "scenarioId",
        "receiptStatus", "toolName", "capabilityProfile", "taskTerminal",
        "committed", "durationMs", "retryCount", "spanKind",
    ]

    private static let forbidden = try! NSRegularExpression(
        pattern: "transcript|prompt|screenshot|windowtitle|filepath|url|cookie|authorization|apikey|token|password|email|username|label",
        options: [.caseInsensitive]
    )

    static func record(
        name: String,
        sessionId: String,
        status: String? = nil,
        durationMs: Int? = nil,
        attributes: [String: Any] = [:]
    ) {
        guard !paused else { return }
        do {
            for key in attributes.keys {
                let folded = key.replacingOccurrences(of: "[\\s_-]", with: "", options: .regularExpression)
                if forbidden.firstMatch(in: folded, range: NSRange(location: 0, length: folded.utf16.count)) != nil {
                    return
                }
                if !allowlist.contains(key) { return }
            }
            var payload: [String: Any] = [
                "schemaVersion": 1,
                "eventId": UUID().uuidString,
                "occurredAt": ISO8601DateFormatter().string(from: Date()),
                "sessionId": sessionId,
                "name": name,
                "attributes": attributes.filter { allowlist.contains($0.key) },
            ]
            if let status { payload["status"] = status }
            if let durationMs { payload["durationMs"] = durationMs }
            try append(payload)
        } catch {
            return
        }
    }

    static func clear() {
        try? FileManager.default.removeItem(at: storeURL())
    }

    private static func storeURL() -> URL {
        if let testStoreURL { return testStoreURL }
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Yishu", isDirectory: true)
            .appendingPathComponent("Diagnostics", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root.appendingPathComponent("quality.jsonl")
    }

    private static func append(_ payload: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: payload)
        var line = data
        line.append(contentsOf: [0x0A])
        let url = storeURL()
        if FileManager.default.fileExists(atPath: url.path) {
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
        } else {
            try line.write(to: url)
        }
    }
}
