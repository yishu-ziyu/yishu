import Foundation

/// The product-owned receipt for one desktop action. The old `succeeded`,
/// `verified`, `message`, and `evidence` fields remain the compatibility
/// surface for older sidecars; the typed fields make delivery and verification
/// decisions explicit for the current shell.
enum YishuActionStatus: String, Codable, Equatable, Sendable {
    case verified
    case delivered
    case unverified
    case blocked
    case failed
}

enum YishuActionMethod: String, Codable, Equatable, Sendable {
    case axPress = "ax_press"
    case axSetValue = "ax_set_value"
    case quartz
    case nativeCommand = "native_command"
    case shortcut
    case unknown
}

enum YishuActionCode: String, Codable, Equatable, Sendable {
    case permissionDenied = "permission_denied"
    case screenUnavailable = "screen_unavailable"
    case targetOutOfBounds = "target_out_of_bounds"
    case axLookupFailed = "ax_lookup_failed"
    case axPressUnsupported = "ax_press_unsupported"
    case axPressUnknown = "ax_press_failed"
    case axPressUnverified = "ax_press_unverified"
    case focusedElementUnavailable = "focused_element_unavailable"
    case secureTextBlocked = "secure_text_blocked"
    case axSetValueUnsupported = "ax_set_value_unsupported"
    case axSetValueFailed = "ax_set_value_failed"
    case axSetValueUnverified = "ax_set_value_unverified"
    case frontmostMismatch = "frontmost_mismatch"
    case targetStale = "target_stale"
    case quartzEventCreationFailed = "quartz_event_creation_failed"
    case quartzUnverified = "quartz_unverified"
    case verifiedAccessibility = "verified_accessibility"
    case verifiedScreen = "verified_screen"
    case actionLimitReached = "action_limit_reached"
    case runtimeError = "runtime_error"
    case cancelled
    case timeout
    case notificationPermissionPending = "notification_permission_pending"
    case notificationPermissionDenied = "notification_permission_denied"
    case notificationScheduleFailed = "notification_schedule_failed"
    case verifiedSystemNotification = "verified_system_notification"
}

extension YishuActionCode {
    // Product-facing aliases retain the descriptive vocabulary used by the
    // macOS code while the raw values stay compatible with the runtime schema.
    static var notApplicable: Self { .runtimeError }
    static var unsupportedAction: Self { .runtimeError }
    static var accessibilityPermissionDenied: Self { .permissionDenied }
    static var pointOutOfBounds: Self { .targetOutOfBounds }
    static var axElementUnavailable: Self { .axLookupFailed }
    static var axPressFailed: Self { .axPressUnknown }
    static var frontmostChanged: Self { .frontmostMismatch }
    static var targetWindowNotOwned: Self { .targetStale }
    static var targetFrameStale: Self { .targetStale }
    static var quartzClickUnverified: Self { .quartzUnverified }
    static var verifiedAccessibilityChange: Self { .verifiedAccessibility }
    static var verifiedScreenChange: Self { .verifiedScreen }
}

/// The action channel is deliberately conservative: an action whose delivery
/// state is unknown must never be replayed automatically.
enum YishuActionPolicy {
    static func allowsQuartzFallback(after code: YishuActionCode) -> Bool {
        switch code {
        case .axLookupFailed, .axPressUnsupported:
            return true
        case .permissionDenied, .screenUnavailable, .targetOutOfBounds,
             .axPressUnknown, .axPressUnverified,
             .focusedElementUnavailable, .secureTextBlocked,
             .axSetValueUnsupported, .axSetValueFailed, .axSetValueUnverified,
             .frontmostMismatch, .targetStale, .quartzEventCreationFailed,
             .quartzUnverified, .verifiedAccessibility, .verifiedScreen,
             .actionLimitReached, .runtimeError, .cancelled, .timeout,
             .notificationPermissionPending, .notificationPermissionDenied,
             .notificationScheduleFailed, .verifiedSystemNotification:
            return false
        }
    }

    static func allowsAutomaticRetry(after status: YishuActionStatus) -> Bool {
        // A click can have reached the application even when the read-back is
        // inconclusive. Replaying it would turn an unknown outcome into a
        // possible double action, so retries require a new user turn.
        _ = status
        return false
    }
}

struct YishuComputerActionRequest: Equatable, Sendable {
    let requestId: UUID
    let traceId: UUID
    let actionId: UUID
    let action: String
    let x: Double
    let y: Double
    let screen: Int?
    let label: String?
    let text: String?
    let title: String?
    let content: String?
    let reminderId: String?
    let delaySeconds: Int?
    let reminderBody: String?
    let targetBundleId: String?
    let targetPid: pid_t?
    let intentId: String?
    let attemptId: String?
    let basisFrameId: String?
    let effectClass: String?

    init(
        requestId: UUID,
        traceId: UUID,
        actionId: UUID,
        action: String,
        x: Double,
        y: Double,
        screen: Int? = nil,
        label: String? = nil,
        text: String? = nil,
        title: String? = nil,
        content: String? = nil,
        reminderId: String? = nil,
        delaySeconds: Int? = nil,
        reminderBody: String? = nil,
        targetBundleId: String? = nil,
        targetPid: pid_t? = nil,
        intentId: String? = nil,
        attemptId: String? = nil,
        basisFrameId: String? = nil,
        effectClass: String? = nil
    ) {
        self.requestId = requestId
        self.traceId = traceId
        self.actionId = actionId
        self.action = action
        self.x = x
        self.y = y
        self.screen = screen
        self.label = label
        self.text = text
        self.title = title
        self.content = content
        self.reminderId = reminderId
        self.delaySeconds = delaySeconds
        self.reminderBody = reminderBody
        self.targetBundleId = targetBundleId
        self.targetPid = targetPid
        self.intentId = intentId
        self.attemptId = attemptId
        self.basisFrameId = basisFrameId
        self.effectClass = effectClass
    }
}

struct YishuComputerActionResult: Equatable, Sendable {
    let succeeded: Bool
    let verified: Bool
    let message: String
    let evidence: String?
    let status: YishuActionStatus
    let method: YishuActionMethod
    let code: YishuActionCode
    let receiptId: String
    let attemptId: String

    init(
        succeeded: Bool,
        verified: Bool,
        message: String,
        evidence: String?,
        status: YishuActionStatus? = nil,
        method: YishuActionMethod = .unknown,
        code: YishuActionCode? = nil,
        receiptId: String = UUID().uuidString,
        attemptId: String = UUID().uuidString
    ) {
        self.succeeded = succeeded
        self.verified = verified
        self.message = message
        self.evidence = evidence
        self.status = status ?? Self.defaultStatus(succeeded: succeeded, verified: verified)
        self.method = method
        self.code = code ?? Self.defaultCode(succeeded: succeeded, verified: verified)
        self.receiptId = receiptId
        self.attemptId = attemptId
    }

    private static func defaultStatus(succeeded: Bool, verified: Bool) -> YishuActionStatus {
        if verified { return .verified }
        return succeeded ? .delivered : .failed
    }

    private static func defaultCode(succeeded: Bool, verified: Bool) -> YishuActionCode {
        if verified { return .verifiedScreenChange }
        return succeeded ? .quartzClickUnverified : .notApplicable
    }
}
