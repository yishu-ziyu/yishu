//
//  YishuSpeechEmotionTests.swift
//  leanring-buddyTests
//

import Foundation
import Testing
@testable import Clicky

struct YishuSpeechEmotionTests {
    @Test func normalizedFailsOpenToAuto() {
        #expect(YishuSpeechEmotion.normalized(nil) == "")
        #expect(YishuSpeechEmotion.normalized("") == "")
        #expect(YishuSpeechEmotion.normalized("  ") == "")
        #expect(YishuSpeechEmotion.normalized("happy") == "happy")
        #expect(YishuSpeechEmotion.normalized(" happy ") == "happy")
        #expect(YishuSpeechEmotion.normalized("HAPPY") == "")
        #expect(YishuSpeechEmotion.normalized("ecstatic") == "")
    }

    @Test func supportedSetMatchesMiniMaxAllowlist() {
        #expect(YishuSpeechEmotion.supportedRawValues == [
            "happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral",
        ])
        #expect(YishuSpeechEmotion.options.count == YishuSpeechEmotion.supportedRawValues.count + 1)
        #expect(YishuSpeechEmotion.options.first?.rawValue == "")
    }

    @Test func userDefaultsRoundTrip() {
        let suiteName = "yishu.speechEmotion.tests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            Issue.record("failed to create suite")
            return
        }
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(YishuSpeechEmotion.load(from: defaults) == "")
        YishuSpeechEmotion.store("happy", in: defaults)
        #expect(YishuSpeechEmotion.load(from: defaults) == "happy")
        YishuSpeechEmotion.store("ecstatic", in: defaults)
        #expect(YishuSpeechEmotion.load(from: defaults) == "")
        YishuSpeechEmotion.store("sad", in: defaults)
        #expect(YishuSpeechEmotion.load(from: defaults) == "sad")
    }

    @Test func wireValueOmitsAuto() {
        let suiteName = "yishu.speechEmotion.wire.tests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            Issue.record("failed to create suite")
            return
        }
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(YishuSpeechEmotion.wireValue(from: defaults) == nil)
        YishuSpeechEmotion.store("neutral", in: defaults)
        #expect(YishuSpeechEmotion.wireValue(from: defaults) == "neutral")
    }

    @Test func displayLabelFallsBackToAuto() {
        #expect(YishuSpeechEmotion.displayLabel(for: "") == "自动")
        #expect(YishuSpeechEmotion.displayLabel(for: "happy") == "开心")
        #expect(YishuSpeechEmotion.displayLabel(for: "bogus") == "自动")
    }
}
