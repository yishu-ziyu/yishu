//
//  ElevenLabsTTSClient.swift
//  leanring-buddy
//
//  Requests MiniMax text-to-speech audio through the local 奕枢 proxy and
//  plays it through the system output. The type name remains for source and
//  project-file compatibility with the original Clicky implementation.
//

import AVFoundation
import Foundation

@MainActor
final class ElevenLabsTTSClient: NSObject, AVAudioPlayerDelegate {
    private let proxyURL: URL
    private let session: URLSession

    /// The audio player for the current TTS playback. Kept alive so the
    /// audio finishes playing even if the caller doesn't hold a reference.
    private var audioPlayer: AVAudioPlayer?
    private var playbackID: UUID?
    private var playbackContinuation: CheckedContinuation<Void, any Error>?
    private var playbackWatchdogTask: Task<Void, Never>?

    init(proxyURL: String) {
        self.proxyURL = URL(string: proxyURL)!

        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: configuration)
        super.init()
    }

    /// Sends `text` to MiniMax TTS and plays the resulting audio.
    /// `speed` is clamped to the provider-safe range before the request.
    /// Throws on network or decoding errors. Cancellation-safe.
    func speakText(
        _ text: String,
        speed: Double = YishuSpeechSpeed.defaultValue
    ) async throws {
        var request = URLRequest(url: proxyURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        YishuVoiceProxySupervisor.authorize(&request)

        // Proxy accepts { text, speed } and returns raw audio/mpeg (MiniMax t2a_v2).
        let clampedSpeed = YishuSpeechSpeed.clamp(speed)
        let body: [String: Any] = [
            "text": text,
            "speed": clampedSpeed,
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw NSError(domain: "YishuTTS", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "无效的 TTS 响应"])
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            // Do not surface raw upstream bodies (may echo request fragments).
            throw NSError(
                domain: "YishuTTS",
                code: httpResponse.statusCode,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "TTS 失败 (\(httpResponse.statusCode)，\(data.count) bytes)"
                ]
            )
        }

        try Task.checkCancellation()

        let player = try AVAudioPlayer(data: data)
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                    return
                }

                // There is one physical output channel. Superseding playback
                // must wake the previous awaiter before this sentence starts.
                stopPlayback()
                audioPlayer = player
                playbackID = id
                playbackContinuation = continuation
                player.delegate = self
                player.prepareToPlay()
                guard player.play() else {
                    finishPlayback(
                        id: id,
                        error: NSError(
                            domain: "YishuTTS",
                            code: -2,
                            userInfo: [NSLocalizedDescriptionKey: "TTS 音频无法播放"]
                        )
                    )
                    return
                }
                let duration = player.duration
                let timeout = min(max((duration.isFinite ? duration : 0) + 5, 10), 90)
                playbackWatchdogTask = Task { @MainActor [weak self] in
                    do {
                        try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                    } catch {
                        return
                    }
                    guard let self, self.playbackID == id else { return }
                    self.audioPlayer?.stop()
                    self.finishPlayback(
                        id: id,
                        error: NSError(
                            domain: "YishuTTS",
                            code: -5,
                            userInfo: [NSLocalizedDescriptionKey: "TTS 音频播放超时"]
                        )
                    )
                }
                print("🔊 奕枢 TTS: playing \(data.count / 1024)KB audio speed=\(clampedSpeed)")
            }
        } onCancel: { [weak self] in
            Task { @MainActor in
                self?.cancelPlayback(id: id)
            }
        }
    }

    /// Whether TTS audio is currently playing back.
    var isPlaying: Bool {
        audioPlayer?.isPlaying ?? false
    }

    /// Stops any in-progress playback immediately.
    func stopPlayback() {
        guard let id = playbackID else {
            audioPlayer?.stop()
            audioPlayer = nil
            return
        }
        cancelPlayback(id: id)
    }

    nonisolated func audioPlayerDidFinishPlaying(
        _ player: AVAudioPlayer,
        successfully flag: Bool
    ) {
        let playerIdentifier = ObjectIdentifier(player)
        Task { @MainActor [weak self] in
            self?.finishDelegatePlayback(
                playerIdentifier: playerIdentifier,
                succeeded: flag,
                decodeFailed: false
            )
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        let playerIdentifier = ObjectIdentifier(player)
        Task { @MainActor [weak self] in
            self?.finishDelegatePlayback(
                playerIdentifier: playerIdentifier,
                succeeded: false,
                decodeFailed: true
            )
        }
    }

    private func finishDelegatePlayback(
        playerIdentifier: ObjectIdentifier,
        succeeded: Bool,
        decodeFailed: Bool
    ) {
        guard let player = audioPlayer,
              ObjectIdentifier(player) == playerIdentifier,
              let id = playbackID else { return }
        let error: Error? = succeeded ? nil : NSError(
            domain: "YishuTTS",
            code: decodeFailed ? -4 : -3,
            userInfo: [
                NSLocalizedDescriptionKey: decodeFailed
                    ? "TTS 音频解码失败"
                    : "TTS 音频播放未完成"
            ]
        )
        finishPlayback(id: id, error: error)
    }

    private func cancelPlayback(id: UUID) {
        guard playbackID == id else { return }
        audioPlayer?.stop()
        finishPlayback(id: id, error: CancellationError())
    }

    private func finishPlayback(id: UUID, error: Error?) {
        guard playbackID == id else { return }
        let continuation = playbackContinuation
        playbackWatchdogTask?.cancel()
        playbackWatchdogTask = nil
        playbackContinuation = nil
        playbackID = nil
        audioPlayer?.delegate = nil
        audioPlayer = nil
        if let error {
            continuation?.resume(throwing: error)
        } else {
            continuation?.resume()
        }
    }
}
