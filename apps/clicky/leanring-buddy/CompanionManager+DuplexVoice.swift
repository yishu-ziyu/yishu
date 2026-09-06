import Foundation

extension CompanionManager {
    static let continuousListeningDefaultsKey = "yishu.continuousListening.enabled"

    func setContinuousListeningEnabled(_ enabled: Bool) {
        if enabled {
            isContinuousListeningEnabled = true
            ClickyAnalytics.trackVoiceEvent("handsfree.enabled", once: false)
            ensureOverlayVisibleForVoiceFeedback()
            voiceSession.setContinuousListeningEnabled(true)
            return
        }
        persistContinuousListeningPreference(false)
        isContinuousListeningEnabled = false
        ClickyAnalytics.trackVoiceEvent("handsfree.disabled", once: false)
        voiceSession.setContinuousListeningEnabled(false)
        voiceSession.setAssistantPlaybackActive(false)
        if voiceState == .listening {
            voiceState = .idle
        }
    }

    func handleContinuousListeningArmed() {
        persistContinuousListeningPreference(true)
        isContinuousListeningEnabled = true
    }

    func handleContinuousListeningFailed(message: String) {
        persistContinuousListeningPreference(false)
        isContinuousListeningEnabled = false
        if voiceState == .listening {
            voiceState = .idle
        }
        _ = message
    }

    func persistContinuousListeningPreference(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: Self.continuousListeningDefaultsKey)
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
        guard voiceSession.continuousListeningState.isArmed else { return }
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
