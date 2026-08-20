//
//  YishuPermissionGuidanceTests.swift
//  leanring-buddyTests
//
//  Pure walk-through rules for the panel permission buttons.
//  macOS cannot grant mic + Accessibility + Screen Recording in one dialog.
//

import Testing
@testable import Clicky

struct YishuPermissionGuidanceTests {
    @Test func walksPermissionsInOrderAndCannotSkipToASingleSystemGrant() {
        #expect(
            YishuPermissionGuidance.nextStep(
                microphone: .notDetermined,
                accessibilityGranted: false,
                screenRecordingGranted: false,
                screenContentGranted: false
            ) == .microphone
        )
        #expect(
            YishuPermissionGuidance.nextStep(
                microphone: .denied,
                accessibilityGranted: true,
                screenRecordingGranted: true,
                screenContentGranted: true
            ) == .microphone
        )
        #expect(
            YishuPermissionGuidance.nextStep(
                microphone: .authorized,
                accessibilityGranted: false,
                screenRecordingGranted: false,
                screenContentGranted: false
            ) == .accessibility
        )
        #expect(
            YishuPermissionGuidance.nextStep(
                microphone: .authorized,
                accessibilityGranted: true,
                screenRecordingGranted: false,
                screenContentGranted: false
            ) == .screenRecording
        )
        #expect(
            YishuPermissionGuidance.nextStep(
                microphone: .authorized,
                accessibilityGranted: true,
                screenRecordingGranted: true,
                screenContentGranted: false
            ) == .screenContent
        )
        #expect(
            YishuPermissionGuidance.nextStep(
                microphone: .authorized,
                accessibilityGranted: true,
                screenRecordingGranted: true,
                screenContentGranted: true
            ) == .done
        )
    }

    @Test func microphoneCopyExplainsSettingsPathWhenDenied() {
        #expect(
            YishuPermissionGuidance.microphoneInstruction(for: .notDetermined)
                .contains("弹出询问")
        )
        let denied = YishuPermissionGuidance.microphoneInstruction(for: .denied)
        #expect(denied.contains("系统设置"))
        #expect(denied.contains("麦克风"))
        #expect(denied.contains("奕枢"))
        #expect(YishuPermissionGuidance.unifiedGrantCaption.contains("不能一次给齐"))
        #expect(YishuPermissionGuidance.staleGrantHint.contains("/Applications/奕枢.app"))
    }
}
