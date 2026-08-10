//
//  HybridSpeechStepFunTranscriptionProvider.swift
//  leanring-buddy
//
//  Apple Speech supplies local shadow partials and a last-resort final. The
//  existing StepFun Token Plan provider remains authoritative for normal
//  finals. No open-platform ASR stream or credential is introduced here.
//

import AVFoundation
import Foundation

struct HybridSpeechStepFunTranscriptionProviderError: LocalizedError {
    let message: String

    var errorDescription: String? {
        message
    }
}

final class HybridSpeechStepFunTranscriptionProvider: BuddyHybridTranscriptionProvider {
    private let appleSpeechProvider: any BuddyTranscriptionProvider
    private let stepFunProvider: any BuddyTranscriptionProvider

    let displayName = "Apple Speech shadow + 阶跃 StepFun"
    let requiresSpeechRecognitionPermission = true

    var isConfigured: Bool {
        appleSpeechProvider.isConfigured && stepFunProvider.isConfigured
    }

    var unavailableExplanation: String? {
        if let explanation = appleSpeechProvider.unavailableExplanation {
            return explanation
        }
        return stepFunProvider.unavailableExplanation
    }

    init(
        appleSpeechProvider: any BuddyTranscriptionProvider = AppleSpeechTranscriptionProvider(),
        stepFunProvider: any BuddyTranscriptionProvider = StepFunTranscriptionProvider()
    ) {
        self.appleSpeechProvider = appleSpeechProvider
        self.stepFunProvider = stepFunProvider
    }

    func startStreamingSession(
        keyterms: [String],
        onTranscriptUpdate: @escaping (String) -> Void,
        onFinalTranscriptReady: @escaping (String) -> Void,
        onError: @escaping (Error) -> Void
    ) async throws -> any BuddyStreamingTranscriptionSession {
        try await startHybridStreamingSession(
            keyterms: keyterms,
            onApplePartial: onTranscriptUpdate,
            onStepFunFinal: onFinalTranscriptReady,
            onAppleFinal: { _ in },
            onSourceError: { _, error in onError(error) }
        )
    }

    func startHybridStreamingSession(
        keyterms: [String],
        onApplePartial: @escaping (String) -> Void,
        onStepFunFinal: @escaping (String) -> Void,
        onAppleFinal: @escaping (String) -> Void,
        onSourceError: @escaping (BuddyHybridTranscriptionSource, Error) -> Void
    ) async throws -> any BuddyStreamingTranscriptionSession {
        var appleSession: (any BuddyStreamingTranscriptionSession)?
        do {
            appleSession = try await appleSpeechProvider.startStreamingSession(
                keyterms: keyterms,
                onTranscriptUpdate: onApplePartial,
                onFinalTranscriptReady: onAppleFinal,
                onError: { error in
                    onSourceError(.appleSpeechShadow, error)
                }
            )
        } catch {
            onSourceError(.appleSpeechShadow, error)
        }

        var stepFunSession: (any BuddyStreamingTranscriptionSession)?
        do {
            stepFunSession = try await stepFunProvider.startStreamingSession(
                keyterms: keyterms,
                onTranscriptUpdate: { _ in },
                onFinalTranscriptReady: onStepFunFinal,
                onError: { error in
                    onSourceError(.stepFunAuthoritative, error)
                }
            )
        } catch {
            onSourceError(.stepFunAuthoritative, error)
        }

        guard appleSession != nil || stepFunSession != nil else {
            throw HybridSpeechStepFunTranscriptionProviderError(
                message: "Apple Speech and StepFun are both unavailable."
            )
        }

        return HybridSpeechStepFunTranscriptionSession(
            appleSession: appleSession,
            stepFunSession: stepFunSession
        )
    }
}

private final class HybridSpeechStepFunTranscriptionSession: BuddyHybridTranscriptionSession {
    private let appleSession: (any BuddyStreamingTranscriptionSession)?
    private let stepFunSession: (any BuddyStreamingTranscriptionSession)?
    private let audioFanoutQueue = DispatchQueue(
        label: "com.yishu.hybrid-transcription.audio-fanout",
        qos: .userInteractive
    )

    let finalTranscriptFallbackDelaySeconds: TimeInterval

    init(
        appleSession: (any BuddyStreamingTranscriptionSession)?,
        stepFunSession: (any BuddyStreamingTranscriptionSession)?
    ) {
        self.appleSession = appleSession
        self.stepFunSession = stepFunSession
        let appleDelay = appleSession?.finalTranscriptFallbackDelaySeconds ?? 0
        let stepFunDelay = stepFunSession?.finalTranscriptFallbackDelaySeconds ?? 0
        finalTranscriptFallbackDelaySeconds = max(appleDelay, stepFunDelay)
    }

    func appendAudioBuffer(_ audioBuffer: AVAudioPCMBuffer) {
        // The render callback only enqueues. Provider conversion/network work
        // never blocks or touches an actor on the audio thread.
        audioFanoutQueue.async { [weak self, audioBuffer] in
            self?.appleSession?.appendAudioBuffer(audioBuffer)
            self?.stepFunSession?.appendAudioBuffer(audioBuffer)
        }
    }

    func requestFinalTranscript() {
        // Serial fanout acts as a drain barrier for audio already queued by
        // the render callback before ending both recognizers.
        audioFanoutQueue.async { [weak self] in
            self?.appleSession?.requestFinalTranscript()
            self?.stepFunSession?.requestFinalTranscript()
        }
    }

    func cancel() {
        audioFanoutQueue.async { [weak self] in
            self?.appleSession?.cancel()
            self?.stepFunSession?.cancel()
        }
    }

    func cancelStepFun() {
        audioFanoutQueue.async { [weak self] in
            self?.stepFunSession?.cancel()
        }
    }

    func cancelAppleSpeech() {
        audioFanoutQueue.async { [weak self] in
            self?.appleSession?.cancel()
        }
    }
}
