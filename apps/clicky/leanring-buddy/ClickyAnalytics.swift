//
//  ClickyAnalytics.swift
//  leanring-buddy
//
//  Personal 奕枢 fork: no remote analytics. Keep the same method surface so
//  call sites do not need a sweeping rename.
//

import CryptoKit
import Foundation

enum ClickyContextResolutionReason: String, CaseIterable {
    case reuse
    case recaptureActiveWindow
    case recaptureSceneChanged
    case recaptureStale
    case recaptureMissingBasis
}

enum ClickyAnalytics {
    private static var pushToTalkStartedAt: UInt64?

    static func configure() {
        QualityEventRecorder.record(name: "app.ready", sessionId: "app")
    }

    static func trackAppOpened() {
        QualityEventRecorder.record(name: "app.launched", sessionId: "app")
    }

    static func trackOnboardingStarted() {
        QualityEventRecorder.record(name: "onboarding.started", sessionId: "onboarding")
        YishuOnboardingStore.record(.introSeen)
    }

    static func trackOnboardingReplayed() {}

    static func trackOnboardingVideoCompleted() {}

    static func trackOnboardingDemoTriggered() {}

    static func trackAllPermissionsGranted() {
        QualityEventRecorder.record(name: "permission.granted", sessionId: "app", attributes: ["permission": "all"])
    }

    static func trackPermissionGranted(permission: String) {
        QualityEventRecorder.record(name: "permission.granted", sessionId: "app", attributes: ["permission": permission])
    }

    static func trackPushToTalkStarted() {
        pushToTalkStartedAt = DispatchTime.now().uptimeNanoseconds
        QualityEventRecorder.record(name: "ptt.key_down", sessionId: "voice")
    }

    static func trackPushToTalkReleased() {
        let durationMs = pushToTalkStartedAt.map {
            Int((DispatchTime.now().uptimeNanoseconds - $0) / 1_000_000)
        }
        pushToTalkStartedAt = nil
        QualityEventRecorder.record(
            name: "ptt.key_up",
            sessionId: "voice",
            durationMs: durationMs
        )
    }

    static func trackContextResolution(
        reason: ClickyContextResolutionReason,
        sourceDimensionsAvailable: Bool
    ) {
        QualityEventRecorder.record(
            name: "context.resolved",
            sessionId: "voice",
            attributes: [
                "reason": reason.rawValue,
                "sourceDimensionsAvailable": sourceDimensionsAvailable,
            ]
        )
    }

    static func trackContextResolution(
        reason: String,
        sourceDimensionsAvailable: Bool
    ) {
        guard let reason = ClickyContextResolutionReason(rawValue: reason) else { return }
        trackContextResolution(
            reason: reason,
            sourceDimensionsAvailable: sourceDimensionsAvailable
        )
    }

    static func trackComputerActionCompleted(
        result: YishuComputerActionResult,
        retryCount: Int = 0
    ) {
        QualityEventRecorder.record(
            name: "computer.action.completed",
            sessionId: "desktop",
            status: result.status.rawValue,
            attributes: [
                "method": result.method.rawValue,
                "code": result.code.rawValue,
                "verified": result.verified,
                "retryCount": max(0, retryCount),
                "receiptHash": opaqueHash(result.receiptId),
            ]
        )
    }

    static func trackUserMessageSent(transcript: String) {
        _ = transcript
        QualityEventRecorder.record(name: "asr.completed", sessionId: "voice")
    }

    static func trackAIResponseReceived(
        response: String,
        verified: Bool = false,
        verifiedActionResult: YishuComputerActionResult? = nil
    ) {
        _ = response
        var attributes: [String: Any] = [
            "verified": verified,
            "taskTerminal": verified ? "verified" : "unverified",
        ]
        if verified, verifiedActionResult?.verified == true,
           let receiptId = verifiedActionResult?.receiptId {
            attributes["receiptHash"] = opaqueHash(receiptId)
        }
        QualityEventRecorder.record(
            name: "model.completed",
            sessionId: "voice",
            attributes: attributes
        )
    }

    static func trackElementPointed(elementLabel: String?) {
        _ = elementLabel
        QualityEventRecorder.record(name: "context.capture_completed", sessionId: "voice", attributes: ["actionKind": "point"])
    }

    static func trackResponseError(error: String) {
        QualityEventRecorder.record(name: "model.completed", sessionId: "voice", status: "failed", attributes: ["errorCode": String(error.hashValue)])
    }

    static func trackTTSError(error: String) {
        QualityEventRecorder.record(name: "tts.requested", sessionId: "voice", status: "failed", attributes: ["errorCode": String(error.hashValue)])
    }

    private static func opaqueHash(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
