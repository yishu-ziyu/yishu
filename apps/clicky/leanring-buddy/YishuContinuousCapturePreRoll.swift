import AVFoundation
import Darwin
import Foundation

/// Copies an input-tap buffer because the audio thread reuses the original.
enum YishuPCMBufferCopy {
    static func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(
            pcmFormat: buffer.format,
            frameCapacity: max(buffer.frameLength, 1)
        ) else {
            return nil
        }
        copy.frameLength = buffer.frameLength
        guard buffer.frameLength > 0 else { return copy }
        if let src = buffer.floatChannelData, let dst = copy.floatChannelData {
            let count = Int(buffer.frameLength)
            for channel in 0..<Int(buffer.format.channelCount) {
                dst[channel].update(from: src[channel], count: count)
            }
            return copy
        }
        let byteCount = Self.byteCount(of: buffer)
        if let src = buffer.audioBufferList.pointee.mBuffers.mData,
           let dst = copy.mutableAudioBufferList.pointee.mBuffers.mData {
            memcpy(dst, src, byteCount)
        }
        return copy
    }

    static func byteCount(of buffer: AVAudioPCMBuffer) -> Int {
        Int(buffer.frameLength) * Int(buffer.format.streamDescription.pointee.mBytesPerFrame)
    }

    static func durationSeconds(of buffer: AVAudioPCMBuffer) -> Double {
        guard buffer.format.sampleRate > 0 else { return 0 }
        return Double(buffer.frameLength) / buffer.format.sampleRate
    }
}

/// Bounded PCM pre-roll for continuous capture.
///
/// While no ASR session is attached, frames are stored up to
/// `maxDurationSeconds` / `maxStoredBytes`. The oldest frames drop first.
/// Attaching a session replays the stored prefix exactly once, then live
/// frames go only to that session. Detach/clear drops pending audio so a
/// later utterance cannot see the previous one.
final class YishuContinuousCapturePreRoll: @unchecked Sendable {
    static let maxDurationSeconds: Double = 2.5
    static let maxStoredBytes = 1_000_000

    private let queue = DispatchQueue(label: "yishu.voice.preroll")
    private var frames: [AVAudioPCMBuffer] = []
    private var storedBytes = 0
    private var storedSeconds: Double = 0
    private var liveSession: (any BuddyStreamingTranscriptionSession)?
    private var replayedIntoCurrentSession = false
    private var liveAppendsAfterReplay = 0

    struct Snapshot: Equatable {
        var frameCount: Int
        var bytes: Int
        var seconds: Double
        var hasLiveSession: Bool
        var replayedIntoCurrentSession: Bool
        var liveAppendsAfterReplay: Int
    }

    func snapshot() -> Snapshot {
        queue.sync {
            Snapshot(
                frameCount: frames.count,
                bytes: storedBytes,
                seconds: storedSeconds,
                hasLiveSession: liveSession != nil,
                replayedIntoCurrentSession: replayedIntoCurrentSession,
                liveAppendsAfterReplay: liveAppendsAfterReplay
            )
        }
    }

    func noteCaptured(_ buffer: AVAudioPCMBuffer) {
        guard let copy = YishuPCMBufferCopy.copy(buffer) else { return }
        queue.sync {
            if let session = liveSession {
                session.appendAudioBuffer(copy)
                if replayedIntoCurrentSession {
                    liveAppendsAfterReplay += 1
                }
                return
            }
            appendToRing(copy)
        }
    }

    func attachAndReplay(_ session: any BuddyStreamingTranscriptionSession) {
        queue.sync {
            let prefix = frames
            frames = []
            storedBytes = 0
            storedSeconds = 0
            for frame in prefix {
                session.appendAudioBuffer(frame)
            }
            liveSession = session
            replayedIntoCurrentSession = true
            liveAppendsAfterReplay = 0
        }
    }

    func detach() {
        queue.sync {
            liveSession = nil
            replayedIntoCurrentSession = false
            liveAppendsAfterReplay = 0
            frames = []
            storedBytes = 0
            storedSeconds = 0
        }
    }

    func clear() {
        detach()
    }

    private func appendToRing(_ buffer: AVAudioPCMBuffer) {
        let bytes = YishuPCMBufferCopy.byteCount(of: buffer)
        let seconds = YishuPCMBufferCopy.durationSeconds(of: buffer)
        frames.append(buffer)
        storedBytes += bytes
        storedSeconds += seconds
        while storedBytes > Self.maxStoredBytes || storedSeconds > Self.maxDurationSeconds {
            guard !frames.isEmpty else { break }
            let dropped = frames.removeFirst()
            storedBytes = max(0, storedBytes - YishuPCMBufferCopy.byteCount(of: dropped))
            storedSeconds = max(0, storedSeconds - YishuPCMBufferCopy.durationSeconds(of: dropped))
        }
    }
}
