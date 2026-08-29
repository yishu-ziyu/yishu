import CryptoKit
import Foundation

/// Stable, content-free identity surfaces for the memory panel and quality log.
/// The UUID never crosses the accessibility or diagnostics boundary.
enum YishuMemoryQualityEvents {
    static func memoryIDHash(_ memoryID: UUID) -> String {
        opaqueHash(memoryID.uuidString.lowercased())
    }

    /// Returns a stable opaque identity for a canonical durable scope.
    /// Free-form project labels are rejected before they reach diagnostics.
    static func scopeHash(_ rawScope: String) -> String? {
        guard let canonicalScope = canonicalScope(rawScope) else { return nil }
        return opaqueHash(canonicalScope)
    }

    static func cardAccessibilityIdentifier(for memoryID: UUID) -> String {
        "yishu-memory-card-\(memoryIDHash(memoryID))"
    }

    static func forgetAccessibilityIdentifier(for memoryID: UUID) -> String {
        "yishu-memory-forget-\(memoryIDHash(memoryID))"
    }

    static func recordRemembered(memoryID: UUID, scope: String) {
        record(name: "memory.remembered", memoryID: memoryID, scope: scope)
    }

    static func recordRememberedIfValid(payload: [String: Any], scope: YishuSessionScope) {
        guard payload["actionName"] as? String == "remember",
              let status = payload["status"] as? String,
              status == "ok" || status == "verified",
              let memoryIDString = payload["memoryId"] as? String,
              let memoryID = UUID(uuidString: memoryIDString),
              let canonicalScope = canonicalScope(scope) else {
            return
        }
        recordRemembered(memoryID: memoryID, scope: canonicalScope)
    }

    static func recordUsed(memoryID: UUID, scope: String) {
        record(name: "memory.used", memoryID: memoryID, scope: scope)
    }

    static func recordForgotten(memoryID: UUID, scope: String, status: String = "ok") {
        record(name: "memory.forgotten", memoryID: memoryID, scope: scope, status: status)
    }

    private static func record(name: String, memoryID: UUID, scope: String, status: String = "ok") {
        guard let safeScopeHash = scopeHash(scope), let safeStatus = normalizedStatus(status) else {
            return
        }
        QualityEventRecorder.record(
            name: name,
            sessionId: "memory",
            status: safeStatus,
            attributes: [
                "memoryIdHash": memoryIDHash(memoryID),
                "scopeHash": safeScopeHash,
            ]
        )
    }

    /// Project labels may contain arbitrary user content. Only canonical
    /// scope keys are allowed to cross the diagnostics boundary.
    private static func canonicalScope(_ rawScope: String) -> String? {
        let scope = rawScope.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if scope == "personal" { return scope }
        guard scope.hasPrefix("project:") else { return nil }
        let projectID = String(scope.dropFirst("project:".count))
        guard let uuid = UUID(uuidString: projectID) else { return nil }
        return "project:\(uuid.uuidString.lowercased())"
    }

    private static func canonicalScope(_ scope: YishuSessionScope) -> String? {
        switch scope.kind {
        case .personal:
            return "personal"
        case .project:
            guard let projectID = scope.projectId else { return nil }
            return "project:\(projectID.uuidString.lowercased())"
        case .privateSession:
            return nil
        }
    }

    private static func opaqueHash(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private static func normalizedStatus(_ rawStatus: String) -> String? {
        let status = rawStatus.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch status {
        case "ok", "failed":
            return status
        default:
            return nil
        }
    }
}
