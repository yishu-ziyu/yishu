import Foundation

/// Privacy-safe ASR terminal category for one locally closed utterance.
/// Never carries transcript text or provider error bodies.
enum YishuAsrTerminalKind: String, Equatable, Sendable {
    case success
    case empty
    case httpFailure
    case sseError
    case timeout
    case transport
    case cancelled
    case disabled
    case fallback
    case missingTerminal

    var isExplicitFailure: Bool {
        switch self {
        case .success, .empty:
            return false
        case .httpFailure, .sseError, .timeout, .transport, .cancelled, .disabled, .fallback, .missingTerminal:
            return true
        }
    }

    var countsAsProductSuccess: Bool {
        self == .success || self == .fallback
    }
}

struct YishuAsrSessionError: Error, Equatable {
    let kind: YishuAsrTerminalKind

    var localizedDescription: String {
        "asr.\(kind.rawValue)"
    }
}

struct YishuStepPlanSSECounts: Equatable, Sendable {
    var delta = 0
    var done = 0
    var error = 0
    var other = 0
}

struct YishuStepPlanSSEAccumulator: Equatable, Sendable {
    var text = ""
    var sawDone = false
    var sawError = false
    var counts = YishuStepPlanSSECounts()

    mutating func consumeDataLine(_ line: String) {
        guard line.hasPrefix("data:") else { return }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespacesAndNewlines)
        if payload.isEmpty || payload == "[DONE]" { return }
        guard let data = payload.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            counts.other += 1
            return
        }
        apply(object)
    }

    mutating func apply(_ object: [String: Any]) {
        let type = object["type"] as? String
        switch type {
        case "transcript.text.done":
            counts.done += 1
            sawDone = true
            if let value = object["text"] as? String {
                text = value
            }
        case "transcript.text.delta":
            counts.delta += 1
            if let delta = object["delta"] as? String {
                text += delta
            }
        case "error":
            counts.error += 1
            sawError = true
        default:
            if let value = object["text"] as? String, !value.isEmpty {
                counts.done += 1
                sawDone = true
                text = value
            } else {
                counts.other += 1
            }
        }
    }

    func result() -> Result<String, YishuAsrSessionError> {
        if sawError {
            return .failure(YishuAsrSessionError(kind: .sseError))
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if sawDone {
            return .success(trimmed)
        }
        if !trimmed.isEmpty {
            return .success(trimmed)
        }
        return .failure(YishuAsrSessionError(kind: .missingTerminal))
    }
}

enum YishuAsrReleaseTelemetry {
    static func recordCaptureRelease(continuousArmed: Bool, traceID: String) {
        if continuousArmed {
            ClickyAnalytics.trackVoiceEvent(
                "duplex.end_of_speech",
                once: false,
                attributes: ["turnId": traceID]
            )
            ClickyAnalytics.markUtteranceReleased()
            return
        }
        ClickyAnalytics.trackPushToTalkReleased()
    }
}
