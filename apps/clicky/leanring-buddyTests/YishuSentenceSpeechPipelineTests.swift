import Foundation
import Testing
@testable import Clicky

struct YishuSentenceSpeechPipelineTests {
    @Test @MainActor func streamsEachSentenceOnceAndFinalOnlyAddsTheTail() async {
        #expect(YishuSentenceSpeechPolicy.allowsStreaming(for: "解释一下当前页面"))
        #expect(!YishuSentenceSpeechPolicy.allowsStreaming(for: "点击左上角新对话"))
        #expect(!YishuSentenceSpeechPolicy.allowsStreaming(for: "先点击 A，再输入 hello"))
        #expect(!YishuSentenceSpeechPolicy.allowsStreaming(for: "输入：hello"))
        #expect(!YishuSentenceSpeechPolicy.allowsStreaming(for: "点击左上角的返回按钮"))
        #expect(!YishuSentenceSpeechPolicy.allowsStreaming(for: "打开设置"))
        #expect(!YishuSentenceSpeechPolicy.allowsStreaming(for: "把这条消息发送出去"))
        #expect(!YishuSentenceSpeechPolicy.allowsStreaming(for: "向下滚动一页"))
        // Even an explanatory desktop question stays final-only: false
        // negatives cost latency, while false positives can speak fake success.
        #expect(!YishuSentenceSpeechPolicy.allowsStreaming(for: "怎么打开这个设置？"))

        var spoken: [String] = []
        let pipeline = YishuSentenceSpeechPipeline(
            speaker: { sentence in spoken.append(sentence) },
            stopPlayback: {}
        )

        let firstCount = pipeline.consume("第一句。第二")
        #expect(firstCount == 1)
        for _ in 0..<20 where spoken.isEmpty {
            await Task.yield()
        }
        // This proves the first sentence entered TTS before response.completed.
        #expect(spoken == ["第一句。"])

        pipeline.consume("句。收尾")
        let handled = await pipeline.finish(authoritativeText: "第一句。第二句。收尾")

        #expect(handled)
        #expect(spoken == ["第一句。", "第二句。", "收尾"])
    }

    @Test @MainActor func cancellationStopsCurrentPlaybackAndDropsQueuedSentences() async {
        var spoken: [String] = []
        var stopCount = 0
        let pipeline = YishuSentenceSpeechPipeline(
            speaker: { sentence in
                spoken.append(sentence)
                if spoken.count == 1 {
                    try await Task.sleep(nanoseconds: 30_000_000_000)
                }
            },
            stopPlayback: { stopCount += 1 }
        )

        pipeline.consume("第一句。第二句。")
        for _ in 0..<50 where spoken.isEmpty {
            await Task.yield()
        }
        #expect(spoken == ["第一句。"])

        pipeline.cancel()
        for _ in 0..<20 {
            await Task.yield()
        }

        #expect(stopCount == 1)
        #expect(spoken == ["第一句。"])
        #expect(await pipeline.finish(authoritativeText: "第一句。第二句。") == false)
    }

    @Test @MainActor func holdsAmbiguousMarkupAndDecimalOrURLPeriods() async {
        var spoken: [String] = []
        let pipeline = YishuSentenceSpeechPipeline(
            speaker: { sentence in spoken.append(sentence) },
            stopPlayback: {}
        )

        #expect(pipeline.consume("版本 1.2，参考 https://example.com/a.") == 0)
        #expect(pipeline.consume(" [PO") == 0)
        #expect(spoken.isEmpty)

        _ = await pipeline.finish(authoritativeText: "版本 1.2，参考 https://example.com/a.")
        #expect(spoken == ["版本 1.2，参考 https://example.com/a."])
    }

    @Test @MainActor func failedStreamingSpeechFallsBackToAuthoritativeFinalPresentation() async {
        var stopCount = 0
        let pipeline = YishuSentenceSpeechPipeline(
            speaker: { _ in throw URLError(.cannotConnectToHost) },
            stopPlayback: { stopCount += 1 }
        )

        pipeline.consume("第一句。")
        let handled = await pipeline.finish(authoritativeText: "第一句。")

        #expect(!handled)
        #expect(pipeline.didEnqueueSpeech)
        #expect(!pipeline.didCompleteSpeech)
        #expect(stopCount == 0)
    }

    @Test @MainActor func nonMonotonicFinalStopsStaleSpeechAndRequestsFinalOnlyFallback() async {
        var stopCount = 0
        let pipeline = YishuSentenceSpeechPipeline(
            speaker: { _ in try await Task.sleep(nanoseconds: 30_000_000_000) },
            stopPlayback: { stopCount += 1 }
        )

        pipeline.consume("旧回答。")
        let handled = await pipeline.finish(authoritativeText: "新回答。")

        #expect(!handled)
        #expect(stopCount == 1)
    }
}
