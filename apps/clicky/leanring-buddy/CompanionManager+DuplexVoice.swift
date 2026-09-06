import Foundation

extension CompanionManager {
    static let continuousListeningDefaultsKey = "yishu.continuousListening.enabled"

    func setContinuousListeningEnabled(_ enabled: Bool) {
        isContinuousListeningEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: Self.continuousListeningDefaultsKey)
        voiceSession.setContinuousListeningEnabled(enabled)
        if enabled {
            ClickyAnalytics.trackVoiceEvent("handsfree.enabled", once: false)
            ensureOverlayVisibleForVoiceFeedback()
            voiceState = .listening
        } else {
            ClickyAnalytics.trackVoiceEvent("handsfree.disabled", once: false)
            voiceSession.setAssistantPlaybackActive(false)
            if voiceState == .listening {
                voiceState = .idle
            }
        }
    }

    func handleDuplexSpeechOnset(traceID: String) {
        ClickyAnalytics.trackVoiceEvent(
            "duplex.speech_onset",
            once: false,
            attributes: ["turnId": traceID]
        )
        // User speech onset owns the audio floor immediately. Do not wait
        // for ASR finalization or Runtime acknowledgement.
        cancelActiveSentenceSpeechPipeline()
        elevenLabsTTSClient.stopPlayback()
        livePartialTranscript = ""
        voiceState = .listening
        ensureOverlayVisibleForVoiceFeedback()
        startHeldSceneCapture(traceID: traceID)
        // Intentionally no cancel/settle/supersede of foreground Runtime.
        _ = YishuDuplexAudioFloor.shouldCancelRuntimeOnSpeechOnset()
    }

    func handleDuplexCaptureFailedWhileContinuous() {
        livePartialTranscript = ""
        restoreListeningIfContinuous()
    }

    func restoreListeningIfContinuous() {
        guard isContinuousListeningEnabled else { return }
        if voiceState == .idle || voiceState == .processing {
            voiceState = .listening
        }
    }

    func bindAssistantPlaybackToVoiceSession() {
        elevenLabsTTSClient.onPlaybackActiveChange = { [weak self] active in
            self?.voiceSession.setAssistantPlaybackActive(active)
        }
    }
}
