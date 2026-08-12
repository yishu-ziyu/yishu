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
}
