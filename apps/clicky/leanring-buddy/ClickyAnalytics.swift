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
    private static var voiceTurnId = "voice"
    private static var keyUpAt: UInt64?
    private static var emittedVoiceEvents: Set<String> = []

    static func configure() {
        QualityEventRecorder.record(name: "app.ready", sessionId: "app")
        let provider = BuddyTranscriptionProviderFactory.resolveProvider()
        QualityEventRecorder.record(
            name: "asr.provider",
            sessionId: "voice",
            attributes: [
                "providerId": BuddyTranscriptionProviderFactory.providerId(for: provider),
            ]
        )
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

    static func trackPushToTalkStarted(turnId: String = "voice") {
        pushToTalkStartedAt = DispatchTime.now().uptimeNanoseconds
        voiceTurnId = turnId
        keyUpAt = nil
        emittedVoiceEvents = []
        recordVoiceEvent("ptt.key_down", once: false)
    }

    static func trackPushToTalkReleased() {
        let now = DispatchTime.now().uptimeNanoseconds
        let durationMs = pushToTalkStartedAt.map {
            Int((now - $0) / 1_000_000)
        }
        pushToTalkStartedAt = nil
        keyUpAt = now
        QualityEventRecorder.record(
            name: "ptt.key_up",
            sessionId: "voice",
            durationMs: durationMs,
            attributes: voiceAttributes(sinceKeyUpMs: 0)
        )
    }

    static func trackVoiceEvent(
        _ name: String,
        once: Bool = true,
        attributes: [String: Any] = [:]
    ) {
        recordVoiceEvent(name, once: once, extraAttributes: attributes)
    }

    static func trackTTSStopped() {
        recordVoiceEvent("tts.stopped", once: true)
    }

    private static func recordVoiceEvent(
        _ name: String,
        once: Bool,
        extraAttributes: [String: Any] = [:]
    ) {
        if once, emittedVoiceEvents.contains(name) { return }
        var attributes = voiceAttributes(sinceKeyUpMs: sinceKeyUpMs())
        for (key, value) in extraAttributes {
            attributes[key] = value
        }
        QualityEventRecorder.record(
            name: name,
            sessionId: "voice",
            durationMs: sinceKeyUpMs(),
            attributes: attributes
        )
        if once { emittedVoiceEvents.insert(name) }
    }

    private static func voiceAttributes(sinceKeyUpMs: Int) -> [String: Any] {
        [
            "turnId": voiceTurnId,
            "sinceKeyUpMs": max(0, sinceKeyUpMs),
        ]
    }

    private static func sinceKeyUpMs() -> Int {
        guard let keyUpAt else { return 0 }
        let now = DispatchTime.now().uptimeNanoseconds
        if now < keyUpAt { return 0 }
        return Int((now - keyUpAt) / 1_000_000)
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

    static func trackAsrRequestSent(kind: String, audioMs: Int) {
        QualityEventRecorder.record(
            name: "asr.request_sent",
            sessionId: "voice",
            durationMs: sinceKeyUpMs(),
            attributes: [
                "turnId": voiceTurnId,
                "sinceKeyUpMs": max(0, sinceKeyUpMs()),
                "actionKind": kind,
                "audioMs": max(0, audioMs),
            ]
        )
    }

    static func trackAsrFirstSSE() {
        recordVoiceEvent("asr.first_sse", once: true)
    }

    static func trackUserMessageSent(transcript: String) {
        _ = transcript
        recordVoiceEvent("asr.final", once: true)
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
