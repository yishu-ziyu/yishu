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
    private enum PreferredProvider: String {
        case stepfun = "stepfun"
        case assemblyAI = "assemblyai"
        case openAI = "openai"
    }

    static func makeDefaultProvider() -> any BuddyTranscriptionProvider {
        let provider = resolveProvider()
        print("🎙️ Transcription: using \(provider.displayName)")
        return provider
    }

    private static func resolveProvider() -> any BuddyTranscriptionProvider {
        let preferredProviderRawValue = AppBundleConfiguration
            .stringValue(forKey: "VoiceTranscriptionProvider")?
            .lowercased()
        let preferredProvider = preferredProviderRawValue.flatMap(PreferredProvider.init(rawValue:))
            ?? .stepfun

        let stepFunProvider = StepFunTranscriptionProvider()
        let assemblyAIProvider = AssemblyAIStreamingTranscriptionProvider()
        let openAIProvider = OpenAIAudioTranscriptionProvider()

        switch preferredProvider {
        case .stepfun:
            return stepFunProvider
        case .assemblyAI:
            if assemblyAIProvider.isConfigured {
                return assemblyAIProvider
            }
            print("⚠️ Transcription: AssemblyAI preferred but not configured, falling back to StepFun")
            return stepFunProvider
        case .openAI:
            if openAIProvider.isConfigured {
                return openAIProvider
            }
            print("⚠️ Transcription: OpenAI preferred but not configured, falling back to StepFun")
            return stepFunProvider
        }
    }
}
