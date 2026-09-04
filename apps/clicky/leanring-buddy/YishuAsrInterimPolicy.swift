import Foundation

/// Variant E: growing-window ASR while Control+Option is held.
/// Interims run only for the first 10 s (0.8 s, then 1.5 s after 5 s).
enum YishuAsrInterimPolicy {
    static let holdLimitSeconds: TimeInterval = 10
    static let fastIntervalSeconds: TimeInterval = 0.8
    static let slowIntervalSeconds: TimeInterval = 1.5
    static let slowAfterSeconds: TimeInterval = 5
    static let preferFinalWithinSeconds: TimeInterval = 0.15
    /// Skip the first fire until there is at least ~300 ms of PCM.
    static let minimumPcmBytes = 16_000 * 2 / 3

    static func nextInterval(elapsed: TimeInterval) -> TimeInterval? {
        if elapsed >= holdLimitSeconds { return nil }
        return elapsed < slowAfterSeconds ? fastIntervalSeconds : slowIntervalSeconds
    }
}

struct YishuAsrKeyUpRaceResult: Equatable, Sendable {
    let source: YishuAsrKeyUpRace.Source
    let text: String
}

enum YishuAsrKeyUpRace {
    enum Source: Equatable, Sendable {
        case interim
        case final
    }

    /// First non-empty result wins, except a final that lands within 150 ms of
    /// an earlier interim replaces it.
    static func winner(
        first: YishuAsrKeyUpRaceResult,
        second: YishuAsrKeyUpRaceResult?,
        secondDelaySeconds: TimeInterval
    ) -> String {
        let firstText = first.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let secondText = second?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if firstText.isEmpty { return secondText }
        if secondText.isEmpty { return firstText }
        if first.source == .interim,
           second?.source == .final,
           secondDelaySeconds <= YishuAsrInterimPolicy.preferFinalWithinSeconds {
            return secondText
        }
        return firstText
    }
}
