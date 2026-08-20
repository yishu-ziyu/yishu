import Foundation

enum YishuHeldSceneDecision: String, Equatable {
    case reuse
    case recaptureActiveWindow
    case recaptureSceneChanged
    case recaptureStale
    case recaptureMissingBasis
}

enum YishuHeldScenePolicy {
    /// Matches ContextFrame evidence lifetime. App/display change still wins.
    static let maxAgeNanoseconds: UInt64 = 30_000_000_000

    static func decide(
        requiresActiveWindowOnly: Bool,
        heldTraceID: String?,
        turnTraceID: String?,
        heldFrontmost: pid_t?,
        currentFrontmost: pid_t?,
        heldDisplay: String,
        currentDisplay: String,
        capturedAt: UInt64?,
        now: UInt64
    ) -> YishuHeldSceneDecision {
        if requiresActiveWindowOnly {
            return .recaptureActiveWindow
        }
        guard let heldTraceID,
              let turnTraceID,
              heldTraceID == turnTraceID,
              let capturedAt,
              let heldFrontmost,
              let currentFrontmost else {
            return .recaptureMissingBasis
        }
        guard now >= capturedAt, now - capturedAt <= maxAgeNanoseconds else {
            return .recaptureStale
        }
        guard heldFrontmost == currentFrontmost,
              !heldDisplay.isEmpty,
              heldDisplay == currentDisplay else {
            return .recaptureSceneChanged
        }
        return .reuse
    }
}
