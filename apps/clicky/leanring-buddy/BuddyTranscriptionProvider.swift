//
//  BuddyTranscriptionProvider.swift
//  leanring-buddy
//
//  Shared protocol surface for voice transcription backends.
//

import AVFoundation
import Foundation

protocol BuddyStreamingTranscriptionSession: AnyObject {
    var finalTranscriptFallbackDelaySeconds: TimeInterval { get }
    func appendAudioBuffer(_ audioBuffer: AVAudioPCMBuffer)
    func requestFinalTranscript()
    func cancel()
}

protocol BuddyTranscriptionProvider {
    var displayName: String { get }
    var isConfigured: Bool { get }
    var unavailableExplanation: String? { get }

    func startStreamingSession(
        keyterms: [String],
        onTranscriptUpdate: @escaping (String) -> Void,
        onFinalTranscriptReady: @escaping (String) -> Void,
        onError: @escaping (Error) -> Void
    ) async throws -> any BuddyStreamingTranscriptionSession
}

enum BuddyTranscriptionProviderFactory {
    /// Info.plist `stepfun`, missing, and unknown values all select Step Plan.
    /// Rollback: `VoiceTranscriptionProvider=stepfun-legacy`.
    static func resolveProvider(
        preferredRawValue: String? = AppBundleConfiguration
            .stringValue(forKey: "VoiceTranscriptionProvider")
    ) -> any BuddyTranscriptionProvider {
        let raw = preferredRawValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        switch raw {
        case "stepfun-legacy":
            return StepFunTranscriptionProvider()
        case "assemblyai":
            let assemblyAIProvider = AssemblyAIStreamingTranscriptionProvider()
            if assemblyAIProvider.isConfigured {
                return assemblyAIProvider
            }
            return StepPlanTranscriptionProvider()
        case "openai":
            let openAIProvider = OpenAIAudioTranscriptionProvider()
            if openAIProvider.isConfigured {
                return openAIProvider
            }
            return StepPlanTranscriptionProvider()
        default:
            return StepPlanTranscriptionProvider()
        }
    }

    static func providerId(for provider: any BuddyTranscriptionProvider) -> String {
        switch provider {
        case is StepPlanTranscriptionProvider:
            return "stepplan"
        case is StepFunTranscriptionProvider:
            return "stepfun-legacy"
        case is AssemblyAIStreamingTranscriptionProvider:
            return "assemblyai"
        case is OpenAIAudioTranscriptionProvider:
            return "openai"
        default:
            return "stepplan"
        }
    }

    static func makeDefaultProvider() -> any BuddyTranscriptionProvider {
        let provider = resolveProvider()
        print("🎙️ Transcription: using \(provider.displayName)")
        return provider
    }
}
