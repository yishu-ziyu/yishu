//
//  StepPlanTranscriptionProvider.swift
//  leanring-buddy
//
//  Step Plan ASR (variant E): growing-window interims during hold, SSE deltas
//  from the local proxy, full-audio final raced with the last interim on key-up.
//  Rollback: VoiceTranscriptionProvider=stepfun-legacy (buffered StepFun provider).
//

import AVFoundation
import Foundation

final class StepPlanTranscriptionProvider: BuddyTranscriptionProvider {
    private static let defaultTranscribeProxyURL = "http://127.0.0.1:8787/audio/asr/sse"

    private let proxyURL: URL
    let displayName = "阶跃 Step Plan"

    var isConfigured: Bool {
        YishuVoiceProxySupervisor.isReadySnapshot
    }

    var unavailableExplanation: String? {
        if isConfigured { return nil }
        return YishuVoiceProxySupervisor.recoverySnapshot
    }

    init(proxyURLString: String = StepPlanTranscriptionProvider.defaultTranscribeProxyURL) {
        self.proxyURL = URL(string: proxyURLString)!
    }

    func startStreamingSession(
        keyterms: [String],
        onTranscriptUpdate: @escaping (String) -> Void,
        onFinalTranscriptReady: @escaping (String) -> Void,
        onError: @escaping (Error) -> Void
    ) async throws -> any BuddyStreamingTranscriptionSession {
        StepPlanAudioTranscriptionSession(
            proxyURL: proxyURL,
            keyterms: keyterms,
            onTranscriptUpdate: onTranscriptUpdate,
            onFinalTranscriptReady: onFinalTranscriptReady,
            onError: onError
        )
    }
}

final class StepPlanAudioTranscriptionSession: BuddyStreamingTranscriptionSession {
    let finalTranscriptFallbackDelaySeconds: TimeInterval = 4.0

    private struct TranscriptionResponse: Decodable {
        let text: String
    }

    private struct StreamBody: Encodable {
        let audioBase64: String
        let format: String
        let sampleRate: Int
        let language: String
        let hotwords: [String]?
        let stream: Bool

        enum CodingKeys: String, CodingKey {
            case audioBase64 = "audio_base64"
            case format
            case sampleRate = "sample_rate"
            case language
            case hotwords
            case stream
        }
    }

    private static let targetSampleRate = 16_000

    private let proxyURL: URL
    private let keyterms: [String]
    private let onTranscriptUpdate: (String) -> Void
    private let onFinalTranscriptReady: (String) -> Void
    private let onError: (Error) -> Void

    private let stateQueue = DispatchQueue(label: "com.yishu.stepplan.transcription")
    private let audioPCM16Converter = BuddyPCM16AudioConverter(
        targetSampleRate: Double(targetSampleRate)
    )
    private let interimSession: URLSession
    private let finalSession: URLSession

    private var bufferedPCM16AudioData = Data()
    private var hasRequestedFinalTranscript = false
    private var hasDeliveredFinalTranscript = false
    private var isCancelled = false
    private var holdStartedAt: Date?
    private var nextInterimWorkItem: DispatchWorkItem?
    private var interimGeneration: UInt64 = 0
    private var appliedInterimGeneration: UInt64 = 0
    private var lastInterimTask: Task<String, Error>?
    private var interimTasks: [Task<String, Error>] = []
    private var transcriptionUploadTask: Task<Void, Never>?
    private var keyUpToFinalDispatchMs: Int?

    func finalDispatchDelayMsForTests() -> Int? {
        stateQueue.sync { keyUpToFinalDispatchMs }
    }

    func disablesSystemProxyForTests() -> Bool {
        let interim = interimSession.configuration.connectionProxyDictionary
        let final = finalSession.configuration.connectionProxyDictionary
        return (interim?.isEmpty ?? false) && (final?.isEmpty ?? false)
    }

    init(
        proxyURL: URL,
        keyterms: [String],
        urlSessionConfiguration: URLSessionConfiguration = .default,
        onTranscriptUpdate: @escaping (String) -> Void,
        onFinalTranscriptReady: @escaping (String) -> Void,
        onError: @escaping (Error) -> Void
    ) {
        self.proxyURL = proxyURL
        self.keyterms = keyterms
        self.onTranscriptUpdate = onTranscriptUpdate
        self.onFinalTranscriptReady = onFinalTranscriptReady
        self.onError = onError

        let metricsDelegate = YishuLoopbackSessionDelegate()
        let interimConfiguration = YishuLoopbackSession.configuration(from: urlSessionConfiguration)
        interimConfiguration.timeoutIntervalForRequest = 60
        interimConfiguration.timeoutIntervalForResource = 90
        interimConfiguration.waitsForConnectivity = false
        interimConfiguration.httpMaximumConnectionsPerHost = 8
        interimConfiguration.httpShouldUsePipelining = false
        let finalConfiguration = YishuLoopbackSession.configuration(from: urlSessionConfiguration)
        finalConfiguration.timeoutIntervalForRequest = 60
        finalConfiguration.timeoutIntervalForResource = 90
        finalConfiguration.waitsForConnectivity = false
        finalConfiguration.httpMaximumConnectionsPerHost = 4
        finalConfiguration.httpShouldUsePipelining = false
        self.interimSession = YishuLoopbackSession.make(
            from: interimConfiguration,
            delegate: metricsDelegate,
            delegateQueue: nil
        )
        self.finalSession = YishuLoopbackSession.make(
            from: finalConfiguration,
            delegate: metricsDelegate,
            delegateQueue: nil
        )

        holdStartedAt = Date()
        scheduleNextInterim(elapsed: 0)
    }

    func appendAudioBuffer(_ audioBuffer: AVAudioPCMBuffer) {
        guard let audioPCM16Data = audioPCM16Converter.convertToPCM16Data(from: audioBuffer),
              !audioPCM16Data.isEmpty else {
            return
        }
        appendPCM16(audioPCM16Data)
    }

    func appendPCM16(_ audioPCM16Data: Data) {
        stateQueue.async {
            guard !self.hasRequestedFinalTranscript, !self.isCancelled else { return }
            self.bufferedPCM16AudioData.append(audioPCM16Data)
        }
    }

    func requestFinalTranscript() {
        let keyUpNs = DispatchTime.now().uptimeNanoseconds
        stateQueue.async {
            guard !self.hasRequestedFinalTranscript, !self.isCancelled else { return }
            self.hasRequestedFinalTranscript = true
            self.nextInterimWorkItem?.cancel()
            self.nextInterimWorkItem = nil

            let pcm = self.bufferedPCM16AudioData
            self.abortInFlightInterims()
            self.interimSession.getAllTasks { tasks in
                tasks.forEach { $0.cancel() }
                self.stateQueue.async {
                    self.keyUpToFinalDispatchMs = Int(
                        (DispatchTime.now().uptimeNanoseconds - keyUpNs) / 1_000_000
                    )
                    self.transcriptionUploadTask = Task { [weak self] in
                        await self?.raceFinal(pcm: pcm, lastInterim: nil)
                    }
                }
            }
        }
    }

    func cancel() {
        stateQueue.async {
            self.isCancelled = true
            self.nextInterimWorkItem?.cancel()
            self.nextInterimWorkItem = nil
            self.bufferedPCM16AudioData.removeAll(keepingCapacity: false)
        }
        transcriptionUploadTask?.cancel()
        lastInterimTask?.cancel()
        interimTasks.forEach { $0.cancel() }
        interimSession.getAllTasks { $0.forEach { $0.cancel() } }
        finalSession.getAllTasks { $0.forEach { $0.cancel() } }
    }

    // Sessions are invalidated only here, never in cancel(): a Swift Task that is
    // already past its cancellation check may still call `session.bytes(for:)`,
    // and URLSession raises an uncatchable NSGenericException ("Task created in a
    // session that has been invalidated") for that. Those Tasks retain self, so
    // deinit runs strictly after the last possible task creation.
    deinit {
        interimSession.invalidateAndCancel()
        finalSession.invalidateAndCancel()
    }

    private func scheduleNextInterim(elapsed: TimeInterval) {
        guard let interval = YishuAsrInterimPolicy.nextInterval(elapsed: elapsed) else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.fireInterim()
        }
        nextInterimWorkItem = work
        stateQueue.asyncAfter(deadline: .now() + interval, execute: work)
    }

    private func fireInterim() {
        guard !hasRequestedFinalTranscript, !isCancelled, let holdStartedAt else { return }
        let elapsed = Date().timeIntervalSince(holdStartedAt)
        guard elapsed < YishuAsrInterimPolicy.holdLimitSeconds else { return }
        let pcm = bufferedPCM16AudioData
        if pcm.count >= YishuAsrInterimPolicy.minimumPcmBytes {
            abortInFlightInterims()
            interimSession.getAllTasks { tasks in
                tasks.forEach { $0.cancel() }
            }
            interimGeneration += 1
            let generation = interimGeneration
            lastInterimTask = Task { [weak self] in
                guard let self else { return "" }
                let text = (try? await self.transcribePCM(pcm, notifyPartials: true)) ?? ""
                self.publishInterimIfCurrent(text, generation: generation)
                return text
            }
            if let lastInterimTask {
                interimTasks = [lastInterimTask]
            }
        }
        scheduleNextInterim(elapsed: elapsed)
    }

    private func abortInFlightInterims() {
        lastInterimTask?.cancel()
        lastInterimTask = nil
        interimTasks.forEach { $0.cancel() }
        interimTasks.removeAll(keepingCapacity: false)
    }

    private func publishInterimIfCurrent(_ text: String, generation: UInt64) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let shouldPublish = stateQueue.sync { () -> Bool in
            guard !isCancelled, !hasDeliveredFinalTranscript else { return false }
            guard generation >= appliedInterimGeneration else { return false }
            appliedInterimGeneration = generation
            return true
        }
        guard shouldPublish else { return }
        onTranscriptUpdate(trimmed)
    }

    private func raceFinal(pcm: Data, lastInterim: Task<String, Error>?) async {
        guard !Task.isCancelled else { return }
        if pcm.isEmpty {
            deliverFinalTranscript("")
            return
        }

        let finalTask = Task { try await transcribePCM(pcm, notifyPartials: true, useFinalSession: true) }
        let interimTask = lastInterim ?? Task { "" }

        let first = await firstNonEmpty(final: finalTask, interim: interimTask)
        if first.source == .final {
            deliverFinalTranscript(first.text)
            return
        }

        let finalWithinWindow = await valueWithin(
            finalTask,
            seconds: YishuAsrInterimPolicy.preferFinalWithinSeconds
        )
        let chosen = YishuAsrKeyUpRace.winner(
            first: first,
            second: finalWithinWindow.map { YishuAsrKeyUpRaceResult(source: .final, text: $0) },
            secondDelaySeconds: YishuAsrInterimPolicy.preferFinalWithinSeconds
        )
        deliverFinalTranscript(chosen)
    }

    private func firstNonEmpty(
        final: Task<String, Error>,
        interim: Task<String, Error>
    ) async -> YishuAsrKeyUpRaceResult {
        // Do not cancel the loser: key-up may still prefer a final that lands
        // within 150 ms of an earlier interim.
        await withCheckedContinuation { continuation in
            let state = FirstNonEmptyGate(continuation: continuation)
            Task {
                let text = ((try? await final.value) ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                state.complete(.final, text)
            }
            Task {
                let text = ((try? await interim.value) ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                state.complete(.interim, text)
            }
        }
    }

    private func valueWithin(_ task: Task<String, Error>, seconds: TimeInterval) async -> String? {
        await withTaskGroup(of: String?.self) { group in
            group.addTask {
                ((try? await task.value) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            }
            group.addTask {
                let nanos = UInt64(max(0, seconds) * 1_000_000_000)
                try? await Task.sleep(nanoseconds: nanos)
                return nil
            }
            var result: String?
            for await item in group {
                if let item, !item.isEmpty {
                    result = item
                    group.cancelAll()
                    break
                }
                if item == nil {
                    group.cancelAll()
                    break
                }
            }
            return result
        }
    }

    private func transcribePCM(
        _ pcm: Data,
        notifyPartials: Bool,
        useFinalSession: Bool = false
    ) async throws -> String {
        var request = URLRequest(url: proxyURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("keep-alive", forHTTPHeaderField: "Connection")
        request.setValue(
            useFinalSession ? "final" : "interim",
            forHTTPHeaderField: "x-yishu-asr-kind"
        )
        YishuVoiceProxySupervisor.authorize(&request)
        request.timeoutInterval = 60

        let normalizedHotwords = StepFunTranscriptionRequest.normalizedHotwords(from: keyterms)
        let body = StreamBody(
            audioBase64: pcm.base64EncodedString(),
            format: "pcm",
            sampleRate: Self.targetSampleRate,
            language: "zh",
            hotwords: normalizedHotwords.isEmpty ? nil : normalizedHotwords,
            stream: true
        )
        request.httpBody = try JSONEncoder().encode(body)

        let audioMs = Int((Double(pcm.count) / Double(Self.targetSampleRate * 2)) * 1000)
        ClickyAnalytics.trackAsrRequestSent(
            kind: useFinalSession ? "final" : "interim",
            audioMs: audioMs
        )

        let session = useFinalSession ? finalSession : interimSession
        let (bytes, response) = try await session.bytes(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw StepFunTranscriptionProviderError(message: "无效的转写响应")
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw StepFunTranscriptionProviderError(
                message: StepFunTranscriptionProviderError.redactedUpstreamMessage(
                    statusCode: httpResponse.statusCode,
                    bodyByteCount: 0
                )
            )
        }

        let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type") ?? ""
        if contentType.contains("application/json") {
            var data = Data()
            for try await byte in bytes {
                data.append(byte)
            }
            let decoded = try JSONDecoder().decode(TranscriptionResponse.self, from: data)
            return decoded.text.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        var text = ""
        var sawFirstSSE = false
        for try await line in bytes.lines {
            if Task.isCancelled { throw CancellationError() }
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespacesAndNewlines)
            if payload.isEmpty || payload == "[DONE]" { continue }
            guard let parsed = Self.parseSSEPayload(payload) else { continue }
            if !sawFirstSSE {
                sawFirstSSE = true
                ClickyAnalytics.trackAsrFirstSSE()
            }
            if let done = parsed.done, !done.isEmpty {
                text = done
                if notifyPartials {
                    onTranscriptUpdate(text)
                }
                break
            } else if let delta = parsed.delta, !delta.isEmpty {
                text += delta
            }
            if notifyPartials, !text.isEmpty {
                onTranscriptUpdate(text)
            }
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private struct SSEPiece {
        var delta: String?
        var done: String?
    }

    private static func parseSSEPayload(_ payload: String) -> SSEPiece? {
        guard let data = payload.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        let type = object["type"] as? String
        if type == "transcript.text.done" {
            return SSEPiece(done: object["text"] as? String)
        }
        if type == "transcript.text.delta" {
            return SSEPiece(delta: object["delta"] as? String)
        }
        if let text = object["text"] as? String, !text.isEmpty {
            return SSEPiece(done: text)
        }
        return nil
    }

    private func deliverFinalTranscript(_ transcriptText: String) {
        let shouldDeliver = stateQueue.sync { () -> Bool in
            guard !hasDeliveredFinalTranscript, !isCancelled else { return false }
            hasDeliveredFinalTranscript = true
            return true
        }
        guard shouldDeliver else { return }
        let trimmed = transcriptText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            onTranscriptUpdate(trimmed)
        }
        onFinalTranscriptReady(trimmed)
    }
}

private final class FirstNonEmptyGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<YishuAsrKeyUpRaceResult, Never>?
    private var emptyCount = 0

    init(continuation: CheckedContinuation<YishuAsrKeyUpRaceResult, Never>) {
        self.continuation = continuation
    }

    func complete(_ source: YishuAsrKeyUpRace.Source, _ text: String) {
        lock.lock()
        defer { lock.unlock() }
        guard let continuation else { return }
        if !text.isEmpty {
            self.continuation = nil
            continuation.resume(returning: YishuAsrKeyUpRaceResult(source: source, text: text))
            return
        }
        emptyCount += 1
        if emptyCount == 2 {
            self.continuation = nil
            continuation.resume(returning: YishuAsrKeyUpRaceResult(source: .final, text: ""))
        }
    }
}

private final class YishuLoopbackSessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didFinishCollecting metrics: URLSessionTaskMetrics
    ) {
        guard let transaction = metrics.transactionMetrics.last else { return }
        let connectMs: Int
        if let start = transaction.connectStartDate, let end = transaction.connectEndDate {
            connectMs = max(0, Int(end.timeIntervalSince(start) * 1000))
        } else {
            connectMs = 0
        }
        QualityEventRecorder.record(
            name: "asr.session",
            sessionId: "voice",
            durationMs: max(0, Int(metrics.taskInterval.duration * 1000)),
            attributes: [
                "reused": transaction.isReusedConnection,
                "proxyUsed": transaction.isProxyConnection,
                "connectMs": connectMs,
            ]
        )
    }
}
