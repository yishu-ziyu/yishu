import Foundation

/// Keeps the latency story observable without retaining transcripts, labels,
/// screenshots, or other private content. The trace origin is created on PTT
/// press; this timing object is created when final ASR text arrives and starts
/// at the recorded release timestamp when that origin is valid.
@MainActor
final class VoiceTurnTiming {
    private let startedAt: UInt64
    private var previousAt: UInt64
    private let traceID: String
    private let hasValidReleaseOrigin: Bool

    init(origin: VoiceTurnOrigin?) {
        let now = DispatchTime.now().uptimeNanoseconds
        traceID = origin?.traceID ?? "unknown"
        if let releaseAt = origin?.releaseAt, releaseAt <= now {
            startedAt = releaseAt
            previousAt = releaseAt
            hasValidReleaseOrigin = true
        } else {
            startedAt = now
            previousAt = now
            hasValidReleaseOrigin = false
        }
    }

    func mark(
        _ phase: String,
        reason: String,
        sourceDimensions: String? = nil,
        receiptID: String? = nil
    ) {
        let now = DispatchTime.now().uptimeNanoseconds
        let deltaMS = Double(now - previousAt) / 1_000_000.0
        let totalMS = Double(now - startedAt) / 1_000_000.0
        let loggedReason = phase == "asr_complete" && !hasValidReleaseOrigin
            ? "unknown_origin"
            : reason
        if phase == "context_capture",
           let contextReason = ClickyContextResolutionReason(rawValue: reason) {
            ClickyAnalytics.trackContextResolution(
                reason: contextReason,
                sourceDimensionsAvailable: sourceDimensions != nil && sourceDimensions != "unavailable"
            )
        }
        CompanionManager.logVoicePhase(
            turnID: traceID,
            phase: phase,
            deltaMS: deltaMS,
            totalMS: totalMS,
            reason: loggedReason,
            sourceDimensions: sourceDimensions,
            receiptID: receiptID
        )
        previousAt = now
    }
}
