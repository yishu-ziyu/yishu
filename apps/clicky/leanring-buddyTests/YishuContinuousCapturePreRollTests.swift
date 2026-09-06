import AVFoundation
import Foundation
import Testing
@testable import Clicky

final class RecordingTranscriptionSession: BuddyStreamingTranscriptionSession, @unchecked Sendable {
    let finalTranscriptFallbackDelaySeconds: TimeInterval = 0.2
    private(set) var tags: [Float] = []
    private(set) var appendCount = 0

    func appendAudioBuffer(_ audioBuffer: AVAudioPCMBuffer) {
        appendCount += 1
        if let first = audioBuffer.floatChannelData?[0], audioBuffer.frameLength > 0 {
            tags.append(first[0])
        }
    }

    func requestFinalTranscript() {}
    func cancel() {}
}

struct YishuContinuousCapturePreRollTests {
    @Test func delayedASRSessionReceivesPrefixOnceInOrder() {
        let roll = YishuContinuousCapturePreRoll()
        let session = RecordingTranscriptionSession()

        roll.noteCaptured(taggedBuffer(1))
        roll.noteCaptured(taggedBuffer(2))
        #expect(roll.snapshot().frameCount == 2)
        #expect(session.tags.isEmpty)

        roll.noteCaptured(taggedBuffer(3))
        roll.attachAndReplay(session)
        roll.noteCaptured(taggedBuffer(4))
        roll.noteCaptured(taggedBuffer(5))

        #expect(session.tags == [1, 2, 3, 4, 5])
        #expect(session.appendCount == 5)
        #expect(roll.snapshot().frameCount == 0)
        #expect(roll.snapshot().replayedIntoCurrentSession)
        #expect(roll.snapshot().liveAppendsAfterReplay == 2)
    }

    @Test func nextUtteranceDoesNotReceivePreviousFrames() {
        let roll = YishuContinuousCapturePreRoll()
        let first = RecordingTranscriptionSession()
        roll.noteCaptured(taggedBuffer(1))
        roll.noteCaptured(taggedBuffer(2))
        roll.attachAndReplay(first)
        roll.noteCaptured(taggedBuffer(3))
        #expect(first.tags == [1, 2, 3])

        roll.detach()
        let second = RecordingTranscriptionSession()
        roll.noteCaptured(taggedBuffer(8))
        roll.noteCaptured(taggedBuffer(9))
        roll.attachAndReplay(second)
        #expect(second.tags == [8, 9])
        #expect(!second.tags.contains(1))
        #expect(!second.tags.contains(2))
        #expect(!second.tags.contains(3))
    }

    @Test func disableClearsPendingPreRoll() {
        let roll = YishuContinuousCapturePreRoll()
        roll.noteCaptured(taggedBuffer(1))
        roll.noteCaptured(taggedBuffer(2))
        #expect(roll.snapshot().frameCount == 2)
        roll.clear()
        #expect(roll.snapshot().frameCount == 0)
        #expect(roll.snapshot().bytes == 0)
        let session = RecordingTranscriptionSession()
        roll.attachAndReplay(session)
        #expect(session.tags.isEmpty)
        #expect(session.appendCount == 0)
    }

    @Test func ringDropsOldestWhenBounded() {
        let roll = YishuContinuousCapturePreRoll()
        let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        let framesPerBuffer = AVAudioFrameCount(16_000)
        for tag in 1...8 {
            roll.noteCaptured(taggedBuffer(Float(tag), format: format, frames: framesPerBuffer))
        }
        let snap = roll.snapshot()
        #expect(snap.seconds <= YishuContinuousCapturePreRoll.maxDurationSeconds + 0.05)
        #expect(snap.bytes <= YishuContinuousCapturePreRoll.maxStoredBytes)
        #expect(snap.frameCount < 8)
        #expect(snap.frameCount > 0)

        let session = RecordingTranscriptionSession()
        roll.attachAndReplay(session)
        #expect(!session.tags.contains(1))
        #expect(session.tags.last == 8)
        #expect(Set(session.tags).count == session.tags.count)
    }

    private func taggedBuffer(
        _ tag: Float,
        format: AVAudioFormat? = nil,
        frames: AVAudioFrameCount = 160
    ) -> AVAudioPCMBuffer {
        let format = format ?? AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        if let channel = buffer.floatChannelData?[0] {
            for index in 0..<Int(frames) {
                channel[index] = index == 0 ? tag : 0
            }
        }
        return buffer
    }
}
