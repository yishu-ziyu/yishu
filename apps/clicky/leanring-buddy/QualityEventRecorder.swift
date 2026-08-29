import Foundation

enum QualityEventRecorder {
    static var paused = false
    static var testStoreURL: URL?

    private static let fixedReasons: Set<String> = [
        "reuse", "recaptureActiveWindow", "recaptureSceneChanged",
        "recaptureStale", "recaptureMissingBasis",
    ]
    private static let fixedMethods: Set<String> = [
        "ax_press", "ax_set_value", "quartz", "native_command", "shortcut", "unknown",
    ]
    private static let fixedCodes: Set<String> = [
        "permission_denied", "screen_unavailable", "target_out_of_bounds", "ax_lookup_failed",
        "ax_press_unsupported", "ax_press_failed", "ax_press_unverified",
        "focused_element_unavailable", "secure_text_blocked", "ax_set_value_unsupported",
        "ax_set_value_failed", "ax_set_value_unverified", "frontmost_mismatch", "target_stale",
        "quartz_event_creation_failed", "quartz_unverified", "verified_accessibility",
        "verified_screen", "action_limit_reached", "runtime_error", "cancelled", "timeout",
        "notification_permission_pending", "notification_permission_denied",
        "notification_schedule_failed", "verified_system_notification",
    ]
    private static let fixedTaskTerminals: Set<String> = ["verified", "unverified"]

    private static let allowlist: Set<String> = [
        "appCategory", "actionKind", "providerId", "modelId", "errorCode",
        "stepCount", "verified", "permission", "milestone", "scenarioId",
        "receiptStatus", "toolName", "capabilityProfile", "taskTerminal",
        "committed", "durationMs", "retryCount", "spanKind", "memoryIdHash",
        "reason", "sourceDimensionsAvailable", "method", "code", "receiptHash", "scopeHash",
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
        if let durationMs, durationMs < 0 { return }
        do {
            for (key, value) in attributes {
                let folded = key.replacingOccurrences(of: "[\\s_-]", with: "", options: .regularExpression)
                if forbidden.firstMatch(in: folded, range: NSRange(location: 0, length: folded.utf16.count)) != nil {
                    return
                }
                if !allowlist.contains(key) { return }
                if !acceptsDeviceAttribute(key: key, value: value) { return }
            }
            var payload: [String: Any] = [
                "schemaVersion": 1,
                "eventId": UUID().uuidString,
                "occurredAt": ISO8601DateFormatter().string(from: Date()),
                "appPid": Int(ProcessInfo.processInfo.processIdentifier),
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
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: url.path
            )
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
        } else {
            guard FileManager.default.createFile(
                atPath: url.path,
                contents: line,
                attributes: [.posixPermissions: 0o600]
            ) else {
                throw NSError(domain: NSCocoaErrorDomain, code: CocoaError.Code.fileWriteUnknown.rawValue)
            }
        }
    }

    private static func acceptsDeviceAttribute(key: String, value: Any) -> Bool {
        switch key {
        case "memoryIdHash", "scopeHash", "receiptHash":
            return isLowercaseHash(value)
        case "reason":
            return isFixedString(value, allowed: fixedReasons)
        case "method":
            return isFixedString(value, allowed: fixedMethods)
        case "code":
            return isFixedString(value, allowed: fixedCodes)
        case "taskTerminal":
            return isFixedString(value, allowed: fixedTaskTerminals)
        case "sourceDimensionsAvailable", "verified":
            return type(of: value) == Bool.self
        case "durationMs", "retryCount":
            guard type(of: value) == Int.self, let number = value as? Int else { return false }
            return number >= 0
        default:
            return true
        }
    }

    private static func isFixedString(_ value: Any, allowed: Set<String>) -> Bool {
        guard let value = value as? String else { return false }
        return allowed.contains(value)
    }

    private static func isLowercaseHash(_ value: Any) -> Bool {
        guard let value = value as? String, value.utf8.count == 64 else { return false }
        return value.utf8.allSatisfy {
            ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
        }
    }
}
