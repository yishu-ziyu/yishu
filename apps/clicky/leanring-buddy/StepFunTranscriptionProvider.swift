//
//  StepFunTranscriptionProvider.swift
//  leanring-buddy
//
//  Push-to-talk transcription via local 奕枢 proxy → StepFun Token Plan ASR.
//  Buffers PCM16 until key-up, then POSTs WAV base64 to /transcribe.
//

import AVFoundation
import Foundation

struct StepFunTranscriptionProviderError: LocalizedError {
    let message: String

    /// Keep upstream response text out of logs and user-facing errors. Bodies
    /// can contain request echoes, provider diagnostics, or sensitive tokens.
    static func redactedUpstreamMessage(statusCode: Int, bodyByteCount: Int) -> String {
        "转写失败（code=upstream_error，status=\(statusCode)，body_bytes=\(bodyByteCount)）"
    }

    var errorDescription: String? {
        message
    }
}

struct StepFunTranscriptionRequest: Encodable {
    private static let maximumHotwordCount = 50
    private static let maximumHotwordLength = 64

    let audioBase64: String
    let format: String
    let sampleRate: Int
    let language: String
    let hotwords: [String]?

    init(
        audioBase64: String,
        format: String,
        sampleRate: Int,
        language: String,
        keyterms: [String]
    ) {
        self.audioBase64 = audioBase64
        self.format = format
        self.sampleRate = sampleRate
        self.language = language

        let normalizedKeyterms = Self.normalizedHotwords(from: keyterms)
        self.hotwords = normalizedKeyterms.isEmpty ? nil : normalizedKeyterms
    }

    static func normalizedHotwords(from keyterms: [String]) -> [String] {
        var seen = Set<String>()
        var normalized: [String] = []

        for keyterm in keyterms {
            guard normalized.count < Self.maximumHotwordCount else { break }

            let trimmedKeyterm = keyterm.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedKeyterm.isEmpty else { continue }
            guard trimmedKeyterm.unicodeScalars.count <= Self.maximumHotwordLength else {
                continue
            }

            let duplicateKey = trimmedKeyterm.lowercased()
            guard seen.insert(duplicateKey).inserted else { continue }
            normalized.append(trimmedKeyterm)
        }

        return normalized
    }

    private enum CodingKeys: String, CodingKey {
        case audioBase64 = "audio_base64"
        case format
        case sampleRate = "sample_rate"
        case language
        case hotwords
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(audioBase64, forKey: .audioBase64)
        try container.encode(format, forKey: .format)
        try container.encode(sampleRate, forKey: .sampleRate)
        try container.encode(language, forKey: .language)
        // Keep the legacy request shape when no keyterms are available.
        try container.encodeIfPresent(hotwords, forKey: .hotwords)
    }
}

final class StepFunTranscriptionProvider: BuddyTranscriptionProvider {
    /// Same proxy host as chat/TTS. Override only when developing against a remote Worker.
    private static let defaultTranscribeProxyURL =
        "http://127.0.0.1:8787/transcribe"

    private let proxyURL: URL

    let displayName = "阶跃 StepFun"

    var isConfigured: Bool {
        // Reflect real local proxy readiness. Never pretend configured when
        // 127.0.0.1:8787 is down (panel "在线" and dictation both depend on this).
        YishuVoiceProxySupervisor.isReadySnapshot
    }

    var unavailableExplanation: String? {
        if isConfigured { return nil }
        return YishuVoiceProxySupervisor.recoverySnapshot
    }

    init(proxyURLString: String = StepFunTranscriptionProvider.defaultTranscribeProxyURL) {
        self.proxyURL = URL(string: proxyURLString)!
    }

    func startStreamingSession(
        keyterms: [String],
        onTranscriptUpdate: @escaping (String) -> Void,
        onFinalTranscriptReady: @escaping (String) -> Void,
        onError: @escaping (Error) -> Void
    ) async throws -> any BuddyStreamingTranscriptionSession {
        return StepFunAudioTranscriptionSession(
            proxyURL: proxyURL,
            keyterms: keyterms,
            onTranscriptUpdate: onTranscriptUpdate,
            onFinalTranscriptReady: onFinalTranscriptReady,
            onError: onError
        )
    }
}

private final class StepFunAudioTranscriptionSession: BuddyStreamingTranscriptionSession {
    let finalTranscriptFallbackDelaySeconds: TimeInterval = 12.0

    private struct TranscriptionResponse: Decodable {
        let text: String
    }

    private static let targetSampleRate = 16_000

    private let proxyURL: URL
    private let keyterms: [String]
    private let onTranscriptUpdate: (String) -> Void
    private let onFinalTranscriptReady: (String) -> Void
    private let onError: (Error) -> Void

    private let stateQueue = DispatchQueue(label: "com.yishu.stepfun.transcription")
    private let audioPCM16Converter = BuddyPCM16AudioConverter(
        targetSampleRate: Double(targetSampleRate)
    )
    private let urlSession: URLSession

    private var bufferedPCM16AudioData = Data()
    private var hasRequestedFinalTranscript = false
    private var hasDeliveredFinalTranscript = false
    private var isCancelled = false
    private var transcriptionUploadTask: Task<Void, Never>?

    init(
        proxyURL: URL,
        keyterms: [String],
        onTranscriptUpdate: @escaping (String) -> Void,
        onFinalTranscriptReady: @escaping (String) -> Void,
        onError: @escaping (Error) -> Void
    ) {
        self.proxyURL = proxyURL
        self.keyterms = keyterms
        self.onTranscriptUpdate = onTranscriptUpdate
        self.onFinalTranscriptReady = onFinalTranscriptReady
        self.onError = onError

        let urlSessionConfiguration = URLSessionConfiguration.default
        urlSessionConfiguration.timeoutIntervalForRequest = 60
        urlSessionConfiguration.timeoutIntervalForResource = 90
        urlSessionConfiguration.waitsForConnectivity = true
        self.urlSession = URLSession(configuration: urlSessionConfiguration)
    }

    func appendAudioBuffer(_ audioBuffer: AVAudioPCMBuffer) {
        guard let audioPCM16Data = audioPCM16Converter.convertToPCM16Data(from: audioBuffer),
              !audioPCM16Data.isEmpty else {
            return
        }

        stateQueue.async {
            guard !self.hasRequestedFinalTranscript, !self.isCancelled else { return }
            self.bufferedPCM16AudioData.append(audioPCM16Data)
        }
    }

    func requestFinalTranscript() {
        stateQueue.async {
            guard !self.hasRequestedFinalTranscript, !self.isCancelled else { return }
            self.hasRequestedFinalTranscript = true

            let bufferedPCM16AudioData = self.bufferedPCM16AudioData
            self.transcriptionUploadTask = Task { [weak self] in
                await self?.transcribeBufferedAudio(bufferedPCM16AudioData)
            }
        }
    }

    func cancel() {
        stateQueue.async {
            self.isCancelled = true
            self.bufferedPCM16AudioData.removeAll(keepingCapacity: false)
        }

        transcriptionUploadTask?.cancel()
        urlSession.invalidateAndCancel()
    }

    private func transcribeBufferedAudio(_ bufferedPCM16AudioData: Data) async {
        guard !Task.isCancelled else { return }

        let trimmedAudioDataIsEmpty = stateQueue.sync {
            isCancelled || bufferedPCM16AudioData.isEmpty
        }

        if trimmedAudioDataIsEmpty {
            deliverFinalTranscript("")
            return
        }

        let wavAudioData = BuddyWAVFileBuilder.buildWAVData(
            fromPCM16MonoAudio: bufferedPCM16AudioData,
            sampleRate: Self.targetSampleRate
        )

        do {
            let transcriptText = try await requestTranscription(for: wavAudioData)
            guard !stateQueue.sync(execute: { isCancelled }) else { return }

            if !transcriptText.isEmpty {
                onTranscriptUpdate(transcriptText)
            }

            deliverFinalTranscript(transcriptText)
        } catch {
            guard !stateQueue.sync(execute: { isCancelled }) else { return }
            print("[StepFun Transcription] ❌ failed (audio size: \(wavAudioData.count) bytes): \(error.localizedDescription)")
            onError(error)
        }
    }

    private func requestTranscription(for wavAudioData: Data) async throws -> String {
        var request = URLRequest(url: proxyURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        YishuVoiceProxySupervisor.authorize(&request)
        request.timeoutInterval = 60

        let body = StepFunTranscriptionRequest(
            audioBase64: wavAudioData.base64EncodedString(),
            format: "wav",
            sampleRate: Self.targetSampleRate,
            language: "zh",
            keyterms: keyterms
        )
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await urlSession.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw StepFunTranscriptionProviderError(message: "无效的转写响应")
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            throw StepFunTranscriptionProviderError(
                message: StepFunTranscriptionProviderError.redactedUpstreamMessage(
                    statusCode: httpResponse.statusCode,
                    bodyByteCount: data.count
                )
            )
        }

        let decoded = try JSONDecoder().decode(TranscriptionResponse.self, from: data)
        return decoded.text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func deliverFinalTranscript(_ transcriptText: String) {
        let shouldDeliver = stateQueue.sync { () -> Bool in
            guard !hasDeliveredFinalTranscript, !isCancelled else { return false }
            hasDeliveredFinalTranscript = true
            return true
        }

        guard shouldDeliver else { return }
        onFinalTranscriptReady(transcriptText)
    }
}
