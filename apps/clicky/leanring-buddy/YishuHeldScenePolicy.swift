import Foundation

enum YishuHeldSceneDecision: String, Equatable {
    case reuse
    case recaptureActiveWindow
    case recaptureSceneChanged
    case recaptureStale
    case recaptureMissingBasis
}

struct YishuHeldSceneIdentity: Equatable {
    var frontmostProcessIdentifier: pid_t?
    var activeWindowNumber: Int?
    var displayFingerprint: String
}

enum YishuHeldScenePolicy {
    /// Metadata/scene evidence lifetime. App/display/window change still wins.
    static let maxAgeNanoseconds: UInt64 = 30_000_000_000
    /// A held scene may reuse its JPEG only while the image itself is recent.
    static let maxScreenshotAgeNanoseconds: UInt64 = 5_000_000_000

    /// Same frontmost app, display arrangement, and focused window.
    /// Missing window numbers on both sides still match (window list can be empty);
    /// one side missing and the other present is a scene change.
    static func isSameLiveScene(
        _ held: YishuHeldSceneIdentity,
        _ current: YishuHeldSceneIdentity
    ) -> Bool {
        guard let heldFrontmost = held.frontmostProcessIdentifier,
              let currentFrontmost = current.frontmostProcessIdentifier,
              heldFrontmost == currentFrontmost,
              !held.displayFingerprint.isEmpty,
              held.displayFingerprint == current.displayFingerprint else {
            return false
        }
        switch (held.activeWindowNumber, current.activeWindowNumber) {
        case let (heldWindow?, currentWindow?):
            return heldWindow == currentWindow
        case (nil, nil):
            return true
        default:
            return false
        }
    }

    static func decide(
        requiresActiveWindowOnly: Bool,
        heldTraceID: String?,
        turnTraceID: String?,
        heldFrontmost: pid_t?,
        currentFrontmost: pid_t?,
        heldDisplay: String,
        currentDisplay: String,
        heldWindowNumber: Int?,
        currentWindowNumber: Int?,
        capturedAt: UInt64?,
        screenshotCapturedAt: UInt64?,
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
        guard let screenshotCapturedAt else {
            return .recaptureMissingBasis
        }
        guard now >= screenshotCapturedAt,
              now - screenshotCapturedAt <= maxScreenshotAgeNanoseconds else {
            return .recaptureStale
        }
        let held = YishuHeldSceneIdentity(
            frontmostProcessIdentifier: heldFrontmost,
            activeWindowNumber: heldWindowNumber,
            displayFingerprint: heldDisplay
        )
        let current = YishuHeldSceneIdentity(
            frontmostProcessIdentifier: currentFrontmost,
            activeWindowNumber: currentWindowNumber,
            displayFingerprint: currentDisplay
        )
        guard isSameLiveScene(held, current) else {
            return .recaptureSceneChanged
        }
        return .reuse
    }
}
