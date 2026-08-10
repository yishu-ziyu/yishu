//
//  YishuSpeechSpeedTests.swift
//  leanring-buddyTests
//

import Foundation
import Testing
@testable import Clicky

struct YishuSpeechSpeedTests {
    @Test func clampKeepsDefaultRangeAndRejectsNonFinite() {
        #expect(YishuSpeechSpeed.clamp(1.0) == 1.0)
        #expect(YishuSpeechSpeed.clamp(0.5) == 0.5)
        #expect(YishuSpeechSpeed.clamp(2.0) == 2.0)
        #expect(YishuSpeechSpeed.clamp(0.1) == 0.5)
        #expect(YishuSpeechSpeed.clamp(9.0) == 2.0)
        #expect(YishuSpeechSpeed.clamp(.nan) == 1.0)
        #expect(YishuSpeechSpeed.clamp(.infinity) == 1.0)
        #expect(YishuSpeechSpeed.clamp(-.infinity) == 1.0)
    }

    @Test func clampAnyAcceptsCommonWireTypes() {
        #expect(YishuSpeechSpeed.clamp(any: 1.5) == 1.5)
        #expect(YishuSpeechSpeed.clamp(any: 2 as Int) == 2.0)
        #expect(YishuSpeechSpeed.clamp(any: "0.7") == 0.7)
        #expect(YishuSpeechSpeed.clamp(any: "nope") == 1.0)
        #expect(YishuSpeechSpeed.clamp(any: nil) == 1.0)
        #expect(YishuSpeechSpeed.clamp(any: 99) == 2.0)
    }

    @Test func userDefaultsRoundTripAndReset() {
        let suiteName = "yishu.speechSpeed.tests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            Issue.record("failed to create suite")
            return
        }
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(YishuSpeechSpeed.load(from: defaults) == 1.0)
        YishuSpeechSpeed.store(0.2, in: defaults)
        #expect(YishuSpeechSpeed.load(from: defaults) == 0.5)
        YishuSpeechSpeed.store(1.7, in: defaults)
        #expect(YishuSpeechSpeed.load(from: defaults) == 1.7)
        YishuSpeechSpeed.reset(in: defaults)
        #expect(YishuSpeechSpeed.load(from: defaults) == 1.0)
    }

    @Test func previewUtteranceIsFixedAndNonEmpty() {
        #expect(!YishuSpeechSpeed.previewUtterance.isEmpty)
        #expect(YishuSpeechSpeed.previewUtterance.contains("奕枢"))
    }

    @Test func displayLabelFormatsOneDecimal() {
        #expect(YishuSpeechSpeed.displayLabel(for: 1) == "1.0×")
        #expect(YishuSpeechSpeed.displayLabel(for: 0.5) == "0.5×")
        #expect(YishuSpeechSpeed.displayLabel(for: 1.75) == "1.8×" || YishuSpeechSpeed.displayLabel(for: 1.75) == "1.8×")
    }
}
