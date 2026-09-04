import Testing
@testable import Clicky

@MainActor
struct CompanionResponseContinuityTests {
    @Test func thinkingStaysMountedUntilVisibleResponseArrives() {
        let manager = CompanionResponseOverlayManager()

        manager.showThinking()
        #expect(manager.viewModel.presentationPhase == .thinking)
        #expect(manager.viewModel.isShowingResponse)
        #expect(manager.viewModel.streamingResponseText.isEmpty)

        manager.showOverlayAndBeginStreaming()
        manager.updateStreamingText("   ")
        #expect(manager.viewModel.presentationPhase == .thinking)

        manager.updateStreamingText("你好")
        #expect(manager.viewModel.presentationPhase == .response)
        #expect(manager.viewModel.streamingResponseText == "你好")

        manager.finishStreaming()
        #expect(manager.viewModel.presentationPhase == .response)
        #expect(manager.hasScheduledHide)

        manager.updateStreamingText("你好")
        #expect(manager.viewModel.presentationPhase == .response)
        #expect(!manager.hasScheduledHide)
    }

    @Test func staticFeedbackUsesMessagePhaseAndHideResetsTheTurn() {
        let manager = CompanionResponseOverlayManager()

        manager.showStaticMessage("没听清，请再说一次。", autoHideAfter: 0)
        #expect(manager.viewModel.presentationPhase == .message)

        manager.hideOverlay()
        #expect(manager.viewModel.presentationPhase == .hidden)
        #expect(!manager.viewModel.isShowingResponse)
        #expect(manager.viewModel.streamingResponseText.isEmpty)
    }

    @Test func runtimeFailureFallbackNeverReplaysTranscript() {
        let manager = CompanionResponseOverlayManager()
        manager.updateTranscriptText("在吗在吗")
        #expect(manager.currentStreamingText.isEmpty)
        #expect(CompanionManager.spokenRuntimeFailureMessage(
            for: YishuAgentRuntimeClientError.unsupportedModel,
            streamedDelta: manager.currentStreamingText
        ) == "这个模型还接不上。")

        manager.updateStreamingText("我在")
        #expect(manager.currentStreamingText == "我在")
    }

    @Test func presenceCueKeepsLastInterimText() {
        let manager = CompanionResponseOverlayManager()
        manager.updateTranscriptText("中间稿")
        manager.showPresenceCue()
        #expect(manager.viewModel.presentationPhase == .response)
        #expect(manager.viewModel.textKind == .transcript)
        #expect(manager.viewModel.streamingResponseText == "中间稿")
    }

    @Test func transcriptStaysSecondaryUntilFirstReplyDelta() {
        let manager = CompanionResponseOverlayManager()
        manager.updateTranscriptText("这个窗口里最大的标题写的是什么")
        #expect(manager.viewModel.textKind == .transcript)
        #expect(manager.viewModel.presentationPhase == .response)

        manager.showOverlayAndBeginStreaming()
        #expect(manager.viewModel.textKind == .transcript)
        #expect(manager.viewModel.streamingResponseText.contains("标题"))

        manager.updateStreamingText("最大的标题是设置")
        #expect(manager.viewModel.textKind == .reply)
        #expect(manager.viewModel.streamingResponseText == "最大的标题是设置")
        #expect(manager.viewModel.presentationPhase == .response)
    }

    @Test func transcriptCollapsesToOneLine() {
        let manager = CompanionResponseOverlayManager()
        manager.updateTranscriptText("第一行\n第二行")
        #expect(manager.viewModel.streamingResponseText == "第一行 第二行")
        #expect(manager.viewModel.textKind == .transcript)
    }
}
