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
                do {
                    let text = try await self.transcribePCM(pcm, notifyPartials: true)
                    self.publishInterimIfCurrent(text, generation: generation)
                    return text
                } catch is CancellationError {
                    return ""
                } catch {
                    return ""
                }
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
        guard !Task.isCancelled else {
            deliverTerminal(.failure(YishuAsrSessionError(kind: .cancelled)))
            return
        }
        if pcm.isEmpty {
            deliverTerminal(.success(""))
            return
        }

        do {
            let text = try await transcribePCM(pcm, notifyPartials: true, useFinalSession: true)
            deliverTerminal(.success(text))
        } catch is CancellationError {
            deliverTerminal(.failure(YishuAsrSessionError(kind: .cancelled)))
        } catch let error as YishuAsrSessionError {
            deliverTerminal(.failure(error))
        } catch {
            deliverTerminal(.failure(YishuAsrSessionError(kind: .transport)))
        }
        _ = lastInterim
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
        request.setValue(ClickyAnalytics.currentVoiceTurnId(), forHTTPHeaderField: "x-yishu-utterance-id")
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
        let (bytes, response): (URLSession.AsyncBytes, URLResponse)
        do {
            (bytes, response) = try await session.bytes(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let urlError as URLError where urlError.code == .timedOut {
            throw YishuAsrSessionError(kind: .timeout)
        } catch {
            throw YishuAsrSessionError(kind: .transport)
        }
        guard let httpResponse = response as? HTTPURLResponse else {
            throw YishuAsrSessionError(kind: .transport)
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw YishuAsrSessionError(kind: .httpFailure)
        }

        let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type") ?? ""
        if contentType.contains("application/json") {
            var data = Data()
            for try await byte in bytes {
                data.append(byte)
            }
            if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               object["error"] != nil {
                throw YishuAsrSessionError(kind: .httpFailure)
            }
            let decoded = try JSONDecoder().decode(TranscriptionResponse.self, from: data)
            return decoded.text.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        var accumulator = YishuStepPlanSSEAccumulator()
        var sawFirstSSE = false
        do {
            for try await line in bytes.lines {
                if Task.isCancelled { throw CancellationError() }
                let before = accumulator.counts
                accumulator.consumeDataLine(line)
                let recognized = accumulator.counts.delta > before.delta
                    || accumulator.counts.done > before.done
                    || accumulator.counts.error > before.error
                if recognized, !sawFirstSSE {
                    sawFirstSSE = true
                    ClickyAnalytics.trackAsrFirstSSE()
                }
                if accumulator.sawError {
                    throw YishuAsrSessionError(kind: .sseError)
                }
                let trimmed = accumulator.text.trimmingCharacters(in: .whitespacesAndNewlines)
                if notifyPartials, !trimmed.isEmpty {
                    onTranscriptUpdate(trimmed)
                }
                if accumulator.sawDone {
                    break
                }
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as YishuAsrSessionError {
            throw error
        } catch {
            throw YishuAsrSessionError(kind: .transport)
        }
        switch accumulator.result() {
        case let .success(text):
            return text
        case let .failure(error):
            throw error
        }
    }

    private func deliverTerminal(_ result: Result<String, YishuAsrSessionError>) {
        let shouldDeliver = stateQueue.sync { () -> Bool in
            guard !hasDeliveredFinalTranscript, !isCancelled else { return false }
            hasDeliveredFinalTranscript = true
            return true
        }
        guard shouldDeliver else { return }
        switch result {
        case let .success(transcriptText):
            let trimmed = transcriptText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                onTranscriptUpdate(trimmed)
            }
            onFinalTranscriptReady(trimmed)
        case let .failure(error):
            onError(error)
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
                "turnId": ClickyAnalytics.currentVoiceTurnId(),
            ]
        )
    }
}
