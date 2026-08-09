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
final class ElevenLabsTTSClient {
    private let proxyURL: URL
    private let session: URLSession

    /// The audio player for the current TTS playback. Kept alive so the
    /// audio finishes playing even if the caller doesn't hold a reference.
    private var audioPlayer: AVAudioPlayer?

    init(proxyURL: String) {
        self.proxyURL = URL(string: proxyURL)!

        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: configuration)
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
        self.audioPlayer = player
        player.play()
        print("🔊 奕枢 TTS: playing \(data.count / 1024)KB audio speed=\(clampedSpeed)")
    }

    /// Whether TTS audio is currently playing back.
    var isPlaying: Bool {
        audioPlayer?.isPlaying ?? false
    }

    /// Stops any in-progress playback immediately.
    func stopPlayback() {
        audioPlayer?.stop()
        audioPlayer = nil
    }
}
