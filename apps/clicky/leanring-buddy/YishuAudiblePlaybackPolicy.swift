import Foundation

/// Assistant audio is active only after the first real scheduled playback.
/// Request, network, and decode pending must not raise the echo gate.
enum YishuAudiblePlaybackPolicy {
    enum Event: Equatable, Sendable {
        case requestStarted
        case networkPending
        case decodePending
        case firstScheduledPlayback
        case completed
        case stopped
        case failed
    }

    static func isAssistantAudioActive(after event: Event) -> Bool {
        switch event {
        case .requestStarted, .networkPending, .decodePending:
            return false
        case .firstScheduledPlayback:
            return true
        case .completed, .stopped, .failed:
            return false
        }
    }
}
