import Foundation
import Testing
@testable import Clicky

struct YishuSpeechSilenceTrimTests {
    private let sampleRate = 44100.0

    @Test func leadingSilenceBeyond80msIsCutToExactWindowIndex() {
        let window = YishuSpeechSilenceTrim.framesForMs(10, sampleRate: sampleRate)
        #expect(window == 441)
        let keepLead = YishuSpeechSilenceTrim.framesForMs(80, sampleRate: sampleRate)
        #expect(keepLead == 3528)

        let silentWindows = 20
        let loudWindows = 5
        var samples = [Float](repeating: 0, count: (silentWindows + loudWindows) * window)
        let loudStart = silentWindows * window
        for index in loudStart..<samples.count {
            samples[index] = 0.5
        }

        let range = YishuSpeechSilenceTrim.keptRange(samples: samples, sampleRate: sampleRate)
        #expect(range.lowerBound == loudStart - keepLead)
        #expect(range.lowerBound == 5292)
        #expect(range.upperBound == samples.count)
        #expect(YishuSpeechSilenceTrim.trim(samples: samples, sampleRate: sampleRate).count == range.count)
    }

    @Test func trailingSilenceBeyond200msIsCutToExactWindowIndex() {
        let window = YishuSpeechSilenceTrim.framesForMs(10, sampleRate: sampleRate)
        let keepTrail = YishuSpeechSilenceTrim.framesForMs(200, sampleRate: sampleRate)
        #expect(keepTrail == 8820)

        let loudWindows = 5
        let silentWindows = 40
        var samples = [Float](repeating: 0, count: (loudWindows + silentWindows) * window)
        for index in 0..<(loudWindows * window) {
            samples[index] = 0.5
        }

        let range = YishuSpeechSilenceTrim.keptRange(samples: samples, sampleRate: sampleRate)
        let lastLoudEnd = loudWindows * window
        #expect(range.lowerBound == 0)
        #expect(range.upperBound == lastLoudEnd + keepTrail)
        #expect(range.upperBound == 11025)
        #expect(samples.count - range.upperBound == 8820)
    }

    @Test func allSilentReturnsEmpty() {
        let samples = [Float](repeating: 0, count: 44100)
        let range = YishuSpeechSilenceTrim.keptRange(samples: samples, sampleRate: sampleRate)
        #expect(range == 0..<0)
        #expect(YishuSpeechSilenceTrim.trim(samples: samples, sampleRate: sampleRate).isEmpty)
    }

    @Test func noSilenceLeavesSamplesUnchanged() {
        let samples = [Float](repeating: 0.5, count: 44100)
        let range = YishuSpeechSilenceTrim.keptRange(samples: samples, sampleRate: sampleRate)
        #expect(range == 0..<samples.count)
        #expect(YishuSpeechSilenceTrim.trim(samples: samples, sampleRate: sampleRate) == samples)
    }

    @Test func thresholdIsMinus40dBFS() {
        let window = YishuSpeechSilenceTrim.framesForMs(10, sampleRate: sampleRate)
        let quiet = [Float](repeating: 0.009, count: window)
        let loud = [Float](repeating: 0.01, count: window)
        #expect(YishuSpeechSilenceTrim.keptRange(samples: quiet, sampleRate: sampleRate).isEmpty)
        #expect(YishuSpeechSilenceTrim.keptRange(samples: loud, sampleRate: sampleRate) == 0..<window)
    }
}

struct YishuSpeechClipGateTests {
    @Test func lastBufferDataPlayedBackCompletes() {
        var gate = YishuSpeechClipGate()
        gate.reset(generation: 1)
        gate.noteScheduled()
        gate.noteScheduled()
        gate.noteParseFinished()
        #expect(!gate.isComplete)

        gate.noteCallback(.dataPlayedBack, generation: 1)
        #expect(!gate.isComplete)

        gate.noteCallback(.dataPlayedBack, generation: 1)
        #expect(gate.isComplete)
    }

    @Test func dataConsumedAndDataRenderedDoNotComplete() {
        var gate = YishuSpeechClipGate()
        gate.reset(generation: 1)
        gate.noteScheduled()
        gate.noteParseFinished()
        gate.noteCallback(.dataConsumed, generation: 1)
        #expect(!gate.isComplete)
        gate.noteCallback(.dataRendered, generation: 1)
        #expect(!gate.isComplete)
        gate.noteCallback(.dataPlayedBack, generation: 1)
        #expect(gate.isComplete)
    }

    @Test func completionAfterStopWithOldGenerationIsIgnored() {
        var gate = YishuSpeechClipGate()
        gate.reset(generation: 1)
        gate.noteScheduled()
        gate.noteParseFinished()
        let oldGeneration = gate.generation
        gate.stop()
        #expect(!gate.isComplete)
        gate.noteCallback(.dataPlayedBack, generation: oldGeneration)
        #expect(!gate.isComplete)
    }

    @Test func emptyClipCompletesImmediately() {
        var gate = YishuSpeechClipGate()
        gate.reset(generation: 1)
        gate.noteParseFinished()
        #expect(gate.isComplete)
    }
}
