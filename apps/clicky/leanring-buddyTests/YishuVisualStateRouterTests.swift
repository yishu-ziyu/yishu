import Foundation
import Testing
@testable import Clicky

struct YishuVisualStateRouterTests {
    @Test func everyProductVisualStateMapsToAnOfficialThinkingOrbState() {
        for visualState in YishuVisualState.allCases {
            #expect(YishuBreathingOrbState.allCases.contains(visualState.orbState))
        }
    }

    @Test func canonicalVoiceAndRuntimeStatesRouteToVisualStates() {
        #expect(YishuVisualStateRouter.route(voiceState: .idle) == .breathing)
        #expect(YishuVisualStateRouter.route(voiceState: .listening) == .listening)
        #expect(YishuVisualStateRouter.route(voiceState: .responding) == .shaping)
        #expect(YishuVisualStateRouter.route(YishuVisualStateInputs(
            runtimePhase: .connecting
        )) == .connecting)
        #expect(YishuVisualStateRouter.route(runtimeEvent: .ready(mode: "pi")) == .idle)
        #expect(YishuVisualStateRouter.route(runtimeEvent: .stopped(exitCode: 1)) == .connecting)
    }

    @Test func turnPhasesRouteWithoutLocalizedStatusText() {
        let expectations: [(YishuTurnVisualPhase, YishuVisualState)] = [
            (.idle, .breathing),
            (.finalizingSpeech, .composing),
            (.observingContext, .searching),
            (.searchingContext, .searching),
            (.reasoning, .solving),
            (.usingTool, .working),
            (.performingAction, .working),
            (.confirmingToolResult, .working),
            (.composingResponse, .composing),
            (.shapingOutput, .shaping),
        ]

        for (phase, state) in expectations {
            #expect(YishuVisualStateRouter.route(YishuVisualStateInputs(
                voiceState: .processing,
                turnPhase: phase
            )) == state)
        }
    }

    @Test func typedRuntimeEventsRouteToTurnPhases() {
        let request = YishuComputerActionRequest(
            requestId: UUID(),
            traceId: UUID(),
            actionId: UUID(),
            action: "left_click",
            x: 10,
            y: 20,
            screen: 1,
            label: "按钮"
        )
        let memory = YishuMemoryUsedItem(
            id: UUID(),
            summary: "偏好",
            source: "conversation",
            capturedAt: "2026-08-12T08:00:00Z",
            scope: "personal"
        )

        #expect(YishuVisualStateRouter.route(turnEvent: .started) == .reasoning)
        #expect(YishuVisualStateRouter.route(turnEvent: .responseDelta("你好")) == .composingResponse)
        #expect(YishuVisualStateRouter.route(turnEvent: .toolStarted("search")) == .usingTool)
        #expect(YishuVisualStateRouter.route(turnEvent: .toolCompleted(name: "search", isError: false)) == .confirmingToolResult)
        #expect(YishuVisualStateRouter.route(turnEvent: .computerActionRequested(request)) == .performingAction)
        #expect(YishuVisualStateRouter.route(turnEvent: .memoryUsed([memory])) == .searchingContext)
        #expect(YishuVisualStateRouter.route(turnEvent: .completed(text: "好了", verified: true)) == .shapingOutput)
        #expect(YishuVisualStateRouter.route(turnEvent: .cancelled) == .idle)
    }

    @Test func delegatedRunningTasksRouteToWeavingAndTerminalTasksDoNot() {
        let now = Date()
        let running = delegatedTask(status: .running, updatedAt: now)
        let done = delegatedTask(status: .done, updatedAt: now, resultKind: .succeeded, summary: "完成")

        #expect(YishuVisualStateRouter.route(delegatedTasks: []) == .idle)
        #expect(YishuVisualStateRouter.route(delegatedTasks: [done]) == .idle)
        #expect(YishuVisualStateRouter.route(delegatedTasks: [done, running]) == .activeWorkerCount(1))
        #expect(YishuVisualStateRouter.route(YishuVisualStateInputs(
            delegatedPresence: .activeWorkerCount(2)
        )) == .weaving)
    }

    @Test func foregroundVoiceListeningWinsOverDelegatedWeaving() {
        #expect(YishuVisualStateRouter.route(YishuVisualStateInputs(
            voiceState: .listening,
            delegatedPresence: .activeWorkerCount(3)
        )) == .listening)
        #expect(YishuVisualStateRouter.route(YishuVisualStateInputs(
            voiceState: .responding,
            delegatedPresence: .activeWorkerCount(3)
        )) == .shaping)
    }

    private func delegatedTask(
        status: YishuDelegatedTaskStatus,
        updatedAt: Date,
        resultKind: YishuDelegatedResultKind? = nil,
        summary: String? = nil
    ) -> YishuDelegatedTaskPresenceEvent {
        YishuDelegatedTaskPresenceEvent(
            id: UUID(),
            parentId: UUID(),
            mainConversationId: UUID(),
            title: "研究任务",
            status: status,
            createdAt: updatedAt,
            updatedAt: updatedAt,
            provider: "openai",
            model: "gpt-5.6-sol",
            resultKind: resultKind,
            summary: summary
        )
    }
}
