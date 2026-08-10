//
//  YishuSpeechSpeed.swift
//  leanring-buddy
//
//  User-facing speech rate for MiniMax TTS. Pure clamp/default helpers so
//  Swift UI, the TTS client, and tests share one range.
//
//  MiniMax t2a voice_setting.speed accepts approximately 0.5...2.0; values
//  outside that range are clamped so bad UserDefaults or network payloads
//  never fail a speak request.
//

import Foundation

enum YishuSpeechSpeed {
    /// Product default: same as historical MiniMax / env default.
    static let defaultValue: Double = 1.0
    /// Inclusive lower bound supported by MiniMax TTS speed.
    static let minimumValue: Double = 0.5
    /// Inclusive upper bound supported by MiniMax TTS speed.
    static let maximumValue: Double = 2.0
    /// UserDefaults key (not a secret; safe to store with other app prefs).
    static let userDefaultsKey = "yishu.speechSpeed.v1"
    /// Fixed, non-private sample for the settings preview button.
    static let previewUtterance = "你好，我是奕枢。这是语速试听。"

    /// Clamp any finite number into the provider-safe range; invalid → default.
    static func clamp(_ raw: Double) -> Double {
        guard raw.isFinite else { return defaultValue }
        return min(maximumValue, max(minimumValue, raw))
    }

    /// Decode a JSON / form value without throwing.
    static func clamp(any raw: Any?) -> Double {
        if let number = raw as? Double {
            return clamp(number)
        }
        if let number = raw as? Int {
            return clamp(Double(number))
        }
        if let number = raw as? NSNumber {
            return clamp(number.doubleValue)
        }
        if let text = raw as? String, let number = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)) {
            return clamp(number)
        }
        return defaultValue
    }

    static func load(from defaults: UserDefaults = .standard) -> Double {
        if defaults.object(forKey: userDefaultsKey) == nil {
            return defaultValue
        }
        return clamp(defaults.double(forKey: userDefaultsKey))
    }

    static func store(_ value: Double, in defaults: UserDefaults = .standard) {
        defaults.set(clamp(value), forKey: userDefaultsKey)
    }

    static func reset(in defaults: UserDefaults = .standard) {
        defaults.set(defaultValue, forKey: userDefaultsKey)
    }

    /// Display like "1.0×" without noisy floating junk.
    static func displayLabel(for value: Double) -> String {
        let clamped = clamp(value)
        return String(format: "%.1f×", clamped)
    }
}
