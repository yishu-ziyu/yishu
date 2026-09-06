import Foundation

/// Local energy endpointing for continuous listening.
/// One utterance has one authoritative finalized boundary; this policy
/// decides onset and end-of-speech. It does not own Runtime or TTS.
enum YishuHandsFreeListeningPolicy {
    static let idleOnsetThreshold: CGFloat = 0.12
    static let playbackOnsetThreshold: CGFloat = 0.32
    static let speechHoldThreshold: CGFloat = 0.08
    static let echoResidualCeiling: CGFloat = 0.16
    static let endOfSpeechSilenceMs = 700
    static let minUtteranceMs = 280

    enum Phase: Equatable, Sendable {
        case armed
        case inUtterance
        case finalizing
    }

    enum Decision: Equatable, Sendable {
        case none
        case beginUtterance
        case endUtterance
    }

    static func isUserSpeech(
        power: CGFloat,
        assistantPlaybackActive: Bool
    ) -> Bool {
        if assistantPlaybackActive {
            return power > playbackOnsetThreshold
        }
        return power > idleOnsetThreshold
    }

    static func isHoldSpeech(power: CGFloat) -> Bool {
        power > speechHoldThreshold
    }

    static func isEchoResidual(
        power: CGFloat,
        assistantPlaybackActive: Bool
    ) -> Bool {
        assistantPlaybackActive && power <= echoResidualCeiling
    }

    static func decision(
        phase: Phase,
        power: CGFloat,
        assistantPlaybackActive: Bool,
        millisecondsSinceLoud: Int,
        utteranceDurationMs: Int
    ) -> Decision {
        switch phase {
        case .armed:
            if isEchoResidual(power: power, assistantPlaybackActive: assistantPlaybackActive) {
                return .none
            }
            return isUserSpeech(
                power: power,
                assistantPlaybackActive: assistantPlaybackActive
            ) ? .beginUtterance : .none
        case .inUtterance:
            if utteranceDurationMs < minUtteranceMs {
                return .none
            }
            if millisecondsSinceLoud >= endOfSpeechSilenceMs {
                return .endUtterance
            }
            return .none
        case .finalizing:
            return .none
        }
    }
}

/// Speech onset may take the audio floor. It must not cancel, settle,
/// or supersede the owned foreground Runtime execution.
enum YishuDuplexAudioFloor {
    static func shouldCancelRuntimeOnSpeechOnset() -> Bool {
        return false
    }

    static func shouldWaitForTranscriptBeforeStoppingTTS() -> Bool {
        return false
    }

    static func shouldWaitForRuntimeAcknowledgementBeforeStoppingTTS() -> Bool {
        return false
    }
}

protocol YishuMonotonicClock: Sendable {
    func milliseconds() -> Int
}

struct YishuSystemMonotonicClock: YishuMonotonicClock {
    func milliseconds() -> Int {
        Int(DispatchTime.now().uptimeNanoseconds / 1_000_000)
    }
}
