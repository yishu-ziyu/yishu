//
//  ClickyAnalytics.swift
//  leanring-buddy
//
//  Personal 奕枢 fork: no remote analytics. Keep the same method surface so
//  call sites do not need a sweeping rename.
//

import Foundation

enum ClickyAnalytics {

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
        QualityEventRecorder.record(name: "ptt.key_down", sessionId: "voice")
    }

    static func trackPushToTalkReleased() {
        QualityEventRecorder.record(name: "ptt.key_up", sessionId: "voice")
    }

    static func trackUserMessageSent(transcript: String) {
        _ = transcript
        QualityEventRecorder.record(name: "asr.completed", sessionId: "voice")
    }

    static func trackAIResponseReceived(response: String) {
        _ = response
        QualityEventRecorder.record(name: "model.completed", sessionId: "voice")
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
}
