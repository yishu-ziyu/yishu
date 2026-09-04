//
//  ElevenLabsTTSClient.swift
//  leanring-buddy
//
//  Requests MiniMax text-to-speech audio through the local 奕枢 proxy and
//  plays it through the system output. The type name remains for source and
//  project-file compatibility with the original overlay implementation.
//

import Foundation

@MainActor
final class ElevenLabsTTSClient {
    private let proxyURL: URL
    private let session: URLSession
    private let clipPlayer = YishuSpeechClipPlayer()
    private var prefetch: (text: String, task: Task<Data, Error>)?
    private let streamPipe: YishuHTTPBytePipe
    private let streamSession: URLSession

    init(proxyURL: String) {
        self.proxyURL = URL(string: proxyURL)!

        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        configuration.httpMaximumConnectionsPerHost = 6
        configuration.httpShouldUsePipelining = true
        configuration.waitsForConnectivity = true
        let pipe = YishuHTTPBytePipe()
        self.streamPipe = pipe
        self.session = YishuLoopbackSession.make(from: configuration)
        self.streamSession = YishuLoopbackSession.make(
            from: configuration,
            delegate: pipe,
            delegateQueue: nil
        )
        clipPlayer.hooks.onFirstAudio = {
            ClickyAnalytics.trackVoiceEvent("tts.first_audio")
        }
        clipPlayer.hooks.onClipGap = { gapMs in
            ClickyAnalytics.trackVoiceEvent(
                "tts.clip_gap",
                once: false,
                attributes: ["gapMs": gapMs]
            )
        }
        clipPlayer.hooks.onClipDone = { stats in
            ClickyAnalytics.trackVoiceEvent(
                "tts.clip_done",
                once: false,
                attributes: [
                    "durationMs": stats.trimmedDurationMs,
                    "playedMs": stats.scheduleToPlayedBackMs,
                ]
            )
        }
    }

    func prefetch(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if prefetch?.text == trimmed { return }
        prefetch = (trimmed, Task { try await self.downloadCompleteAudio(trimmed) })
    }

    /// Sends `text` to MiniMax TTS and plays the resulting audio.
    /// `speed` is clamped to the provider-safe range before the request.
    /// Throws on network or decoding errors. Cancellation-safe.
    func speakText(
        _ text: String,
        speed: Double = YishuSpeechSpeed.defaultValue
    ) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try Task.checkCancellation()

        if let prefetch, prefetch.text == trimmed {
            let data = try await prefetch.task.value
            self.prefetch = nil
            try await playCompleteMPEG(data)
            return
        }

        do {
            try await streamAndPlay(trimmed, speed: speed)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            let data = try await downloadCompleteAudio(trimmed, speed: speed)
            try await playCompleteMPEG(data)
        }
    }

    /// Whether TTS audio is currently playing back.
    var isPlaying: Bool {
        clipPlayer.isPlaying
    }

    /// Stops any in-progress playback immediately.
    func stopPlayback(emitStoppedEvent: Bool = true) {
        prefetch?.task.cancel()
        prefetch = nil
        let wasPlaying = clipPlayer.isPlaying
        clipPlayer.stop()
        if emitStoppedEvent, wasPlaying {
            ClickyAnalytics.trackTTSStopped()
        }
    }

    private func makeRequest(
        text: String,
        speed: Double = YishuSpeechSpeed.defaultValue
    ) throws -> URLRequest {
        var request = URLRequest(url: proxyURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        request.setValue("keep-alive", forHTTPHeaderField: "Connection")
        YishuVoiceProxySupervisor.authorize(&request)

        let clampedSpeed = YishuSpeechSpeed.clamp(speed)
        var body: [String: Any] = [
            "text": text,
            "speed": clampedSpeed,
        ]
        if let emotion = YishuSpeechEmotion.wireValue() {
            body["emotion"] = emotion
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 30
        return request
    }

    private func downloadCompleteAudio(
        _ text: String,
        speed: Double = YishuSpeechSpeed.defaultValue
    ) async throws -> Data {
        let request = try makeRequest(text: text, speed: speed)
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw NSError(
                domain: "YishuTTS",
                code: status,
                userInfo: [NSLocalizedDescriptionKey: "TTS 失败 (\(status)，\(data.count) bytes)"]
            )
        }
        return data
    }

    private func streamAndPlay(_ text: String, speed: Double) async throws {
        let request = try makeRequest(text: text, speed: speed)
        let task = streamSession.dataTask(with: request)
        let (chunks, httpResponse) = try await streamPipe.start(task)
        guard (200...299).contains(httpResponse.statusCode) else {
            task.cancel()
            throw NSError(
                domain: "YishuTTS",
                code: httpResponse.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "TTS 失败 (\(httpResponse.statusCode))"]
            )
        }

        try Task.checkCancellation()
        try await withTaskCancellationHandler {
            try await self.clipPlayer.play(chunks: chunks)
        } onCancel: { [weak self] in
            task.cancel()
            Task { @MainActor in
                self?.clipPlayer.stop()
            }
        }
    }

    private func playCompleteMPEG(_ data: Data) async throws {
        try Task.checkCancellation()
        try await clipPlayer.play(data: data)
    }
}

/// URLSession data-task pipe that yields HTTP body chunks as they arrive.
private final class YishuHTTPBytePipe: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var chunkContinuation: AsyncStream<Data>.Continuation?
    private var responseContinuation: CheckedContinuation<(AsyncStream<Data>, HTTPURLResponse), Error>?
    private var httpResponse: HTTPURLResponse?

    func start(_ task: URLSessionDataTask) async throws -> (AsyncStream<Data>, HTTPURLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            responseContinuation = continuation
            chunkContinuation = nil
            httpResponse = nil
            lock.unlock()
            task.resume()
        }
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            fail(NSError(domain: "YishuTTS", code: -1, userInfo: [
                NSLocalizedDescriptionKey: "无效的 TTS 响应",
            ]))
            return
        }
        let (stream, continuation) = AsyncStream<Data>.makeStream()
        lock.lock()
        httpResponse = http
        chunkContinuation = continuation
        let waiter = responseContinuation
        responseContinuation = nil
        lock.unlock()
        waiter?.resume(returning: (stream, http))
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        let continuation = chunkContinuation
        lock.unlock()
        continuation?.yield(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let continuation = chunkContinuation
        chunkContinuation = nil
        let waiter = responseContinuation
        responseContinuation = nil
        lock.unlock()
        continuation?.finish()
        if let waiter {
            waiter.resume(throwing: error ?? NSError(
                domain: "YishuTTS",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "TTS 流未返回响应"]
            ))
        }
    }

    private func fail(_ error: Error) {
        lock.lock()
        let waiter = responseContinuation
        responseContinuation = nil
        let continuation = chunkContinuation
        chunkContinuation = nil
        lock.unlock()
        continuation?.finish()
        waiter?.resume(throwing: error)
    }
}
