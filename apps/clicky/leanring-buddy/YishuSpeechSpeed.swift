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

/// User-facing speech emotion for MiniMax TTS (`voice_setting.emotion`).
/// "自动" stores the empty string and sends no emotion parameter, so the
/// provider renders emotion from the content itself (speech-2.8 renders mood
/// and interjections from text). Invalid stored values fail open to auto so
/// bad UserDefaults never break a speak request.
enum YishuSpeechEmotion {
    /// UserDefaults key (not a secret; safe to store with other app prefs).
    static let userDefaultsKey = "yishu.speechEmotion.v1"
    static let autoRawValue = ""

    /// MiniMax t2a_v2 supported emotion set.
    static let supportedRawValues: [String] = [
        "happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral",
    ]

    struct Option: Equatable, Identifiable {
        let rawValue: String
        let label: String
        var id: String { rawValue }
    }

    static let options: [Option] = [
        Option(rawValue: autoRawValue, label: "自动"),
        Option(rawValue: "happy", label: "开心"),
        Option(rawValue: "sad", label: "悲伤"),
        Option(rawValue: "angry", label: "愤怒"),
        Option(rawValue: "fearful", label: "恐惧"),
        Option(rawValue: "disgusted", label: "厌恶"),
        Option(rawValue: "surprised", label: "惊讶"),
        Option(rawValue: "neutral", label: "中性"),
    ]

    static func normalized(_ raw: String?) -> String {
        guard let raw else { return autoRawValue }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return autoRawValue }
        return supportedRawValues.contains(trimmed) ? trimmed : autoRawValue
    }

    static func load(from defaults: UserDefaults = .standard) -> String {
        normalized(defaults.string(forKey: userDefaultsKey))
    }

    static func store(_ raw: String, in defaults: UserDefaults = .standard) {
        defaults.set(normalized(raw), forKey: userDefaultsKey)
    }

    /// Value sent on the wire; nil means "no emotion parameter" (auto).
    static func wireValue(from defaults: UserDefaults = .standard) -> String? {
        let value = load(from: defaults)
        return value.isEmpty ? nil : value
    }

    static func displayLabel(for raw: String) -> String {
        let normalizedRaw = normalized(raw)
        return options.first { $0.rawValue == normalizedRaw }?.label ?? "自动"
    }
}
