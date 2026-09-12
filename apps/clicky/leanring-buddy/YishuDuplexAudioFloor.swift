import Foundation

/// Speech onset takes the audio floor immediately.
///
/// Presentation (sentence speech pipeline + MiniMax playback) stops
/// synchronously. The current foreground Runtime execution may be observed.
/// Onset must not cancel, settle, or supersede that execution, and must not
/// wait for a transcript final or Runtime acknowledgement.
@MainActor
enum YishuDuplexAudioFloor {
    struct PresentationEffects {
        var stopSentenceSpeech: () -> Void
        var stopPlayback: () -> Void
    }

    /// Injectable view of the current foreground execution owner.
    /// Onset may read `isActive`. The three termination hooks exist so tests
    /// can prove they are not used; production must not invoke them.
    struct ForegroundRuntimeBoundary {
        var isActive: () -> Bool
        var cancel: (String) -> Void
        var settle: () -> Void
        var supersede: () -> Void
    }

    static func takeFloorOnSpeechOnset(
        presentation: PresentationEffects,
        foreground: ForegroundRuntimeBoundary,
        transcriptFinalized: Bool = false,
        runtimeAcknowledged: Bool = false
    ) {
        // Knowing ASR/Runtime have not finished is allowed. Waiting is not.
        _ = (transcriptFinalized, runtimeAcknowledged)
        // Observing the owner is allowed. Terminating it is not.
        _ = foreground.isActive()
        presentation.stopSentenceSpeech()
        presentation.stopPlayback()
    }
}
