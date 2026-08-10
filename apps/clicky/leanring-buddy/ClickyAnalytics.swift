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
        // no-op: do not send events to PostHog
    }

    static func trackAppOpened() {}

    static func trackOnboardingStarted() {}

    static func trackOnboardingReplayed() {}

    static func trackOnboardingVideoCompleted() {}

    static func trackOnboardingDemoTriggered() {}

    static func trackAllPermissionsGranted() {}

    static func trackPermissionGranted(permission: String) {}

    static func trackPushToTalkStarted() {}

    static func trackPushToTalkReleased() {}

    static func trackUserMessageSent(transcript: String) {}

    static func trackAIResponseReceived(response: String) {}

    static func trackElementPointed(elementLabel: String?) {}

    static func trackResponseError(error: String) {}

    static func trackTTSError(error: String) {}
}
