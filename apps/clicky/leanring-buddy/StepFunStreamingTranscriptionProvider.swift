//
//  StepFunStreamingTranscriptionProvider.swift
//  leanring-buddy
//
//  Transport seam for the future StepFun websocket protocol. This lane does
//  not create a URL, open a socket, or read a credential by default. When a
//  stream capability and injected transport factory are unavailable, it
//  delegates transparently to the existing buffered StepFun provider.
//

import AVFoundation
import Foundation

enum StepFunStreamingTransportEvent: Equatable, Sendable {
    case connected(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64
    )
    case partial(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        text: String
    )
    case final(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        text: String
    )
    case failure(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        reason: BuddyTranscriptionFailure
    )
}

/// `sendAudio` and `finish` must be non-blocking. Implementations enqueue
/// network writes on their own queue; the audio render callback never calls an
/// actor, waits on a lock, or performs URLSession work.
protocol StepFunStreamingTransport: AnyObject {
    var events: AsyncStream<StepFunStreamingTransportEvent> { get }

    func connect() async throws
    func sendAudio(_ pcm16Data: Data)
    func finish()
    func cancel()
}

typealias StepFunStreamingTransportFactory = (
    _ apiKey: String,
    _ token: BuddyTranscriptionSessionToken,
    _ keyterms: [String]
) -> any StepFunStreamingTransport

struct StepFunStreamingConfiguration {
    let apiKey: String?
    let streamCapabilityAvailable: Bool
    let transportFactory: StepFunStreamingTransportFactory?
    let connectTimeoutSeconds: TimeInterval
    let finalTimeoutSeconds: TimeInterval

    init(
        // Deliberately nil by default. A future production adapter may inject
        // its credential through the app's existing provider configuration;
        // this seam never reads or persists a raw secret on its own.
        apiKey: String? = nil,
        streamCapabilityAvailable: Bool = false,
        transportFactory: StepFunStreamingTransportFactory? = nil,
        connectTimeoutSeconds: TimeInterval = 3.0,
        finalTimeoutSeconds: TimeInterval = 1.5
    ) {
        self.apiKey = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true
            ? nil
            : apiKey
        self.streamCapabilityAvailable = streamCapabilityAvailable
        self.transportFactory = transportFactory
        self.connectTimeoutSeconds = max(0.05, connectTimeoutSeconds)
        self.finalTimeoutSeconds = max(0.05, finalTimeoutSeconds)
    }

    var isAvailable: Bool {
        apiKey != nil && streamCapabilityAvailable && transportFactory != nil
    }
}

struct StepFunStreamingTimeoutError: LocalizedError, Equatable {
    let phase: BuddyTranscriptionTimeoutPhase

    var errorDescription: String? {
        switch phase {
        case .connect:
            return "StepFun streaming connection timed out."
        case .final:
            return "StepFun streaming final transcript timed out."
        }
    }
}

final class StepFunStreamingTranscriptionProvider: BuddyTranscriptionProvider {
    private let fallbackProvider: any BuddyTranscriptionProvider
    private let configuration: StepFunStreamingConfiguration
    private let tokenLock = NSLock()
    private var nextTokenValue: UInt64 = 0

    init(
        fallbackProvider: any BuddyTranscriptionProvider = StepFunTranscriptionProvider(),
        configuration: StepFunStreamingConfiguration = StepFunStreamingConfiguration()
    ) {
        self.fallbackProvider = fallbackProvider
        self.configuration = configuration
    }

    var displayName: String {
        configuration.isAvailable ? "阶跃 StepFun Streaming" : fallbackProvider.displayName
    }

    let requiresSpeechRecognitionPermission = false

    /// The provider is always usable because the buffered provider is the
    /// transparent fallback. This flag therefore describes the provider as a
    /// whole, not whether the optional stream transport is enabled.
    var isConfigured: Bool {
        fallbackProvider.isConfigured
    }

    var unavailableExplanation: String? {
        fallbackProvider.unavailableExplanation
    }

    var streamingCapabilityAvailable: Bool {
        configuration.isAvailable
    }

    func startStreamingSession(
        keyterms: [String],
        onTranscriptUpdate: @escaping (String) -> Void,
        onFinalTranscriptReady: @escaping (String) -> Void,
        onError: @escaping (Error) -> Void
    ) async throws -> any BuddyStreamingTranscriptionSession {
        guard configuration.isAvailable,
              let apiKey = configuration.apiKey,
              let transportFactory = configuration.transportFactory else {
            return try await fallbackProvider.startStreamingSession(
                keyterms: keyterms,
                onTranscriptUpdate: onTranscriptUpdate,
                onFinalTranscriptReady: onFinalTranscriptReady,
                onError: onError
            )
        }

        let token = nextToken()
        let transport = transportFactory(apiKey, token, keyterms)
        do {
            try await connectWithTimeout(
                transport,
                timeoutSeconds: configuration.connectTimeoutSeconds
            )
        } catch {
            transport.cancel()
            return try await fallbackProvider.startStreamingSession(
                keyterms: keyterms,
                onTranscriptUpdate: onTranscriptUpdate,
                onFinalTranscriptReady: onFinalTranscriptReady,
                onError: onError
            )
        }

        return StepFunStreamingTranscriptionSession(
            transport: transport,
            fallbackProvider: fallbackProvider,
            keyterms: keyterms,
            token: token,
            finalTimeoutSeconds: configuration.finalTimeoutSeconds,
            onTranscriptUpdate: onTranscriptUpdate,
            onFinalTranscriptReady: onFinalTranscriptReady,
            onError: onError
        )
    }

    private func nextToken() -> BuddyTranscriptionSessionToken {
        tokenLock.lock()
        defer { tokenLock.unlock() }
        nextTokenValue &+= 1
        let value = nextTokenValue == 0 ? 1 : nextTokenValue
        return BuddyTranscriptionSessionToken(token: value, generation: value)
    }

    private func connectWithTimeout(
        _ transport: any StepFunStreamingTransport,
        timeoutSeconds: TimeInterval
    ) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                try await transport.connect()
            }
            group.addTask {
                let nanoseconds = UInt64(timeoutSeconds * 1_000_000_000)
                try await Task.sleep(nanoseconds: nanoseconds)
                throw StepFunStreamingTimeoutError(phase: .connect)
            }
            defer { group.cancelAll() }
            try await group.next()
        }
    }
}

struct BuddyPCM16RetentionBuffer: Sendable {
    let maximumBytes: Int
    private(set) var chunks: [Data] = []
    private(set) var byteCount = 0
    private(set) var didDropOldestAudio = false

    init(maximumBytes: Int = 4_000_000) {
        self.maximumBytes = max(2, maximumBytes)
    }

    mutating func append(_ chunk: Data) {
        guard !chunk.isEmpty else { return }

        if chunk.count >= maximumBytes {
            chunks = [Data(chunk.suffix(maximumBytes))]
            byteCount = maximumBytes
            didDropOldestAudio = true
            return
        }

        while byteCount + chunk.count > maximumBytes, !chunks.isEmpty {
            byteCount -= chunks.removeFirst().count
            didDropOldestAudio = true
        }
        chunks.append(chunk)
        byteCount += chunk.count
    }

    var data: Data {
        chunks.reduce(into: Data()) { result, chunk in
            result.append(chunk)
        }
    }

    mutating func removeAll() {
        chunks.removeAll(keepingCapacity: false)
        byteCount = 0
        didDropOldestAudio = false
    }
}

private enum StepFunPCM16BufferBuilder {
    static let sampleRate = 16_000.0

    static func makeBuffer(from data: Data) -> AVAudioPCMBuffer? {
        guard !data.isEmpty,
              data.count.isMultiple(of: MemoryLayout<Int16>.size),
              let format = AVAudioFormat(
                  commonFormat: .pcmFormatInt16,
                  sampleRate: sampleRate,
                  channels: 1,
                  interleaved: true
              ) else {
            return nil
        }

        let frameCount = data.count / MemoryLayout<Int16>.size
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(frameCount)
        ),
        let destination = buffer.mutableAudioBufferList.pointee.mBuffers.mData else {
            return nil
        }

        data.withUnsafeBytes { rawBuffer in
            guard let source = rawBuffer.baseAddress else { return }
            destination.copyMemory(from: source, byteCount: data.count)
        }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        return buffer
    }
}

private final class StepFunStreamingTranscriptionSession: BuddyStreamingTranscriptionSession {
    /// The outer dictation manager must leave enough time for a stream final
    /// timeout plus the existing buffered StepFun request to complete.
    let finalTranscriptFallbackDelaySeconds: TimeInterval = 15.0

    private static let maxRetainedAudioBytes = 4_000_000

    private let transport: any StepFunStreamingTransport
    private let fallbackProvider: any BuddyTranscriptionProvider
    private let keyterms: [String]
    private let token: BuddyTranscriptionSessionToken
    private let finalTimeoutSeconds: TimeInterval
    private let onTranscriptUpdate: (String) -> Void
    private let onFinalTranscriptReady: (String) -> Void
    private let onError: (Error) -> Void

    private let stateQueue = DispatchQueue(label: "com.yishu.stepfun.streaming.state")
    private let transportQueue = DispatchQueue(label: "com.yishu.stepfun.streaming.transport")
    private let audioConversionQueue = DispatchQueue(
        label: "com.yishu.stepfun.streaming.audio-conversion",
        qos: .userInteractive
    )
    private let audioPCM16Converter = BuddyPCM16AudioConverter(targetSampleRate: 16_000)

    private var stateMachine = BuddyTranscriptionStateMachine()
    private var retainedPCM16 = BuddyPCM16RetentionBuffer(
        maximumBytes: StepFunStreamingTranscriptionSession.maxRetainedAudioBytes
    )
    private var nextSequenceValue: UInt64 = 0
    private var isCancelled = false
    private var fallbackStarted = false
    private var fallbackSession: (any BuddyStreamingTranscriptionSession)?
    private var finalTimeoutWorkItem: DispatchWorkItem?
    private var eventTask: Task<Void, Never>?

    init(
        transport: any StepFunStreamingTransport,
        fallbackProvider: any BuddyTranscriptionProvider,
        keyterms: [String],
        token: BuddyTranscriptionSessionToken,
        finalTimeoutSeconds: TimeInterval,
        onTranscriptUpdate: @escaping (String) -> Void,
        onFinalTranscriptReady: @escaping (String) -> Void,
        onError: @escaping (Error) -> Void
    ) {
        self.transport = transport
        self.fallbackProvider = fallbackProvider
        self.keyterms = keyterms
        self.token = token
        self.finalTimeoutSeconds = max(0.05, finalTimeoutSeconds)
        self.onTranscriptUpdate = onTranscriptUpdate
        self.onFinalTranscriptReady = onFinalTranscriptReady
        self.onError = onError

        _ = stateMachine.start(token: token)
        eventTask = Task { [weak self, transport] in
            for await event in transport.events {
                guard !Task.isCancelled else { return }
                self?.enqueueTransportEvent(event)
            }
        }
    }

    func appendAudioBuffer(_ audioBuffer: AVAudioPCMBuffer) {
        // The render callback only enqueues a buffer. Conversion, bounded
        // retention, and transport writes happen off the audio thread.
        audioConversionQueue.async { [weak self, audioBuffer] in
            guard let self,
                  let pcm16Data = self.audioPCM16Converter.convertToPCM16Data(from: audioBuffer),
                  !pcm16Data.isEmpty else {
                return
            }

            self.stateQueue.async {
                guard !self.isCancelled else { return }
                self.retainedPCM16.append(pcm16Data)
                // Continue sending the live stream, but a later buffered
                // fallback will report retention overflow instead of silently
                // submitting a truncated recording.
                self.enqueueAudio(pcm16Data)
            }
        }
    }

    func requestFinalTranscript() {
        // A serial conversion barrier lets already-enqueued render buffers
        // publish to `stateQueue` before release/finish, without blocking the
        // caller or touching the transport from the audio path.
        audioConversionQueue.async { [weak self] in
            self?.stateQueue.async { [weak self] in
                guard let self, !self.isCancelled else { return }
                let sequence = self.nextSequence()
                let effects = self.stateMachine.reduce(
                    .release(token: self.token, sequence: sequence)
                )
                self.apply(effects)
                guard !self.fallbackStarted else { return }
                self.transportQueue.async { [weak self] in
                    self?.transport.finish()
                }
            }
        }
    }

    func cancel() {
        stateQueue.async { [weak self] in
            guard let self, !self.isCancelled else { return }
            self.isCancelled = true
            self.finalTimeoutWorkItem?.cancel()
            self.finalTimeoutWorkItem = nil
            let sequence = self.nextSequence()
            let effects = self.stateMachine.reduce(
                .cancel(
                    token: self.token,
                    sequence: sequence,
                    reason: .providerStopped
                )
            )
            self.apply(effects)
            self.retainedPCM16.removeAll()
            self.fallbackSession?.cancel()
            self.fallbackSession = nil
            self.eventTask?.cancel()
            self.eventTask = nil
            self.transportQueue.async { [weak self] in
                self?.transport.cancel()
            }
        }
    }

    private func enqueueTransportEvent(_ event: StepFunStreamingTransportEvent) {
        stateQueue.async { [weak self] in
            self?.handleTransportEvent(event)
        }
    }

    private func handleTransportEvent(_ event: StepFunStreamingTransportEvent) {
        guard !isCancelled else { return }

        switch event {
        case .connected:
            return
        case let .partial(eventToken, _, text):
            apply(stateMachine.reduce(.partial(
                token: eventToken,
                sequence: nextSequence(),
                text: text
            )))
        case let .final(eventToken, _, text):
            apply(stateMachine.reduce(.final(
                token: eventToken,
                sequence: nextSequence(),
                text: text
            )))
        case let .failure(eventToken, _, reason):
            apply(stateMachine.reduce(.failure(
                token: eventToken,
                sequence: nextSequence(),
                reason: reason
            )))
        }
    }

    private func enqueueAudio(_ pcm16Data: Data) {
        transportQueue.async { [weak self] in
            guard let self else { return }
            self.transport.sendAudio(pcm16Data)
        }
    }

    private func apply(_ effects: [BuddyTranscriptionEffect]) {
        for effect in effects {
            switch effect {
            case let .updatePartial(_, _, text):
                onTranscriptUpdate(text)
            case let .submitFinal(_, _, text):
                finalTimeoutWorkItem?.cancel()
                finalTimeoutWorkItem = nil
                onFinalTranscriptReady(text)
            case .armFinalTimeout:
                scheduleFinalTimeout()
            case .startBufferedFallback:
                startBufferedFallback()
            case .cancelTransport:
                eventTask?.cancel()
                eventTask = nil
                transportQueue.async { [weak self] in
                    self?.transport.cancel()
                }
            case .drop:
                break
            }
        }
    }

    private func scheduleFinalTimeout() {
        finalTimeoutWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let sequence = self.nextSequence()
            let effects = self.stateMachine.reduce(
                .timeout(
                    token: self.token,
                    sequence: sequence,
                    phase: .final
                )
            )
            self.apply(effects)
        }
        finalTimeoutWorkItem = workItem
        stateQueue.asyncAfter(
            deadline: .now() + finalTimeoutSeconds,
            execute: workItem
        )
    }

    private func startBufferedFallback() {
        guard !fallbackStarted else { return }
        fallbackStarted = true
        finalTimeoutWorkItem?.cancel()
        finalTimeoutWorkItem = nil
        eventTask?.cancel()
        eventTask = nil

        let retainedAudio = retainedPCM16
        guard !retainedAudio.didDropOldestAudio else {
            onError(
                StepFunTranscriptionProviderError(
                    message: "streaming audio retention exceeded its safety bound"
                )
            )
            return
        }

        let pcmData = retainedAudio.data
        Task { [weak self] in
            guard let self else { return }
            do {
                let session = try await self.fallbackProvider.startStreamingSession(
                    keyterms: self.keyterms,
                    onTranscriptUpdate: { _ in },
                    onFinalTranscriptReady: { [weak self] text in
                        guard let self else { return }
                        self.stateQueue.async {
                            guard !self.isCancelled else { return }
                            let sequence = self.nextSequence()
                            self.apply(
                                self.stateMachine.reduce(
                                    .fallbackFinal(
                                        token: self.token,
                                        sequence: sequence,
                                        text: text
                                    )
                                )
                            )
                        }
                    },
                    onError: { [weak self] error in
                        self?.onError(error)
                    }
                )

                let shouldCancel = self.stateQueue.sync { self.isCancelled }
                guard !shouldCancel else {
                    session.cancel()
                    return
                }
                self.stateQueue.async { [weak self] in
                    self?.fallbackSession = session
                }

                if !pcmData.isEmpty,
                   let pcmBuffer = StepFunPCM16BufferBuilder.makeBuffer(from: pcmData) {
                    session.appendAudioBuffer(pcmBuffer)
                }
                session.requestFinalTranscript()
            } catch {
                self.onError(error)
            }
        }
    }

    private func nextSequence() -> UInt64 {
        nextSequenceValue &+= 1
        if nextSequenceValue == 0 {
            nextSequenceValue = 1
        }
        return nextSequenceValue
    }
}
