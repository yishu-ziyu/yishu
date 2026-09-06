import Foundation
import Testing
import YishuContext
@testable import Clicky

@MainActor
final class FakeForegroundRuntime: YishuForegroundRuntimeControlling {
    var startCount = 0
    var cancelCount = 0
    var interruptCount = 0
    var steerCount = 0
    var startUtterances: [String] = []
    var cancelReasons: [String] = []
    var cancelRequestIds: [UUID] = []
    var steerMessages: [String] = []
    var steerGenerations: [Int] = []

    private var continuations: [UUID: AsyncThrowingStream<YishuRuntimeTurnEvent, Error>.Continuation] = [:]
    private var generations: [UUID: Int] = [:]
    private var pendingInterrupted: [UUID: Int] = [:]
    private var acceptedNext: [UUID: Int] = [:]
    let conversationId = UUID()

    var hasActiveTurn: Bool { !continuations.isEmpty }

    func startTurn(
        utterance: String,
        contextFrame: YishuContextFrame,
        modelProvider: String,
        model: String,
        modelRouting: YishuModelRouting,
        capabilityProfile: String
    ) throws -> YishuRuntimeTurn {
        startCount += 1
        startUtterances.append(utterance)
        let requestId = UUID()
        var continuation: AsyncThrowingStream<YishuRuntimeTurnEvent, Error>.Continuation?
        let stream = AsyncThrowingStream<YishuRuntimeTurnEvent, Error> { continuation = $0 }
        continuations[requestId] = continuation
        generations[requestId] = 1
        return YishuRuntimeTurn(
            requestId: requestId,
            conversationId: conversationId,
            events: stream
        )
    }

    func cancelTurn(requestId: UUID, reason: String) throws {
        cancelCount += 1
        cancelReasons.append(reason)
        cancelRequestIds.append(requestId)
        continuations[requestId]?.finish()
        continuations.removeValue(forKey: requestId)
        generations.removeValue(forKey: requestId)
        pendingInterrupted.removeValue(forKey: requestId)
        acceptedNext.removeValue(forKey: requestId)
    }

    func interruptTurn(
        requestId: UUID,
        expectedGeneration: Int
    ) async throws -> YishuTurnInterruptDecision {
        interruptCount += 1
        guard continuations[requestId] != nil,
              pendingInterrupted[requestId] == expectedGeneration else {
            throw YishuAgentRuntimeClientError.turnInterruptUnavailable
        }
        let nextGeneration = expectedGeneration + 1
        generations[requestId] = nextGeneration
        acceptedNext[requestId] = nextGeneration
        pendingInterrupted[requestId] = nil
        return .accepted(
            interruptedGeneration: expectedGeneration,
            nextGeneration: nextGeneration
        )
    }

    func steerTurn(
        requestId: UUID,
        message: String,
        nextGeneration: Int
    ) throws {
        guard continuations[requestId] != nil,
              acceptedNext[requestId] == nextGeneration else {
            throw YishuAgentRuntimeClientError.turnInterruptUnavailable
        }
        steerCount += 1
        steerMessages.append(message)
        steerGenerations.append(nextGeneration)
        acceptedNext[requestId] = nil
    }

    func suppressTurnForInterruption(requestId: UUID, expectedGeneration: Int) -> Bool {
        guard continuations[requestId] != nil,
              generations[requestId] == expectedGeneration,
              pendingInterrupted[requestId] == nil else {
            return false
        }
        pendingInterrupted[requestId] = expectedGeneration
        acceptedNext[requestId] = nil
        return true
    }

    func activeGeneration(requestId: UUID) -> Int? {
        generations[requestId]
    }

    func hasActiveTurn(requestId: UUID) -> Bool {
        continuations[requestId] != nil
    }

    func finish(_ requestId: UUID, throwing error: Error? = nil) {
        if let error {
            continuations[requestId]?.finish(throwing: error)
        } else {
            continuations[requestId]?.finish()
        }
        continuations.removeValue(forKey: requestId)
    }
}

@MainActor
struct YishuForegroundRuntimeExecutionTests {
    @Test func startGivesExecutionOwnerAuthoritativeRequestIdentity() throws {
        let runtime = FakeForegroundRuntime()
        let execution = YishuForegroundRuntimeExecution(runtime: runtime)
        let turn = try execution.startTestTurn("在吗")

        #expect(runtime.startCount == 1)
        #expect(execution.owns(turn.requestId))
        #expect(execution.isActive)
        #expect(execution.hasActiveTurn(requestId: turn.requestId))
        #expect(execution.activeGeneration(requestId: turn.requestId) == 1)
        #expect(!execution.owns(UUID()))
    }

    @Test func presentationStopAloneDoesNotCancelRuntimeExecution() throws {
        let runtime = FakeForegroundRuntime()
        let execution = YishuForegroundRuntimeExecution(runtime: runtime)
        let turn = try execution.startTestTurn("在吗")
        var playbackStops = 0
        let pipeline = YishuSentenceSpeechPipeline(
            speaker: { _ in },
            stopPlayback: { playbackStops += 1 }
        )

        pipeline.cancel()
        pipeline.cancel()

        #expect(playbackStops == 1)
        #expect(runtime.cancelCount == 0)
        #expect(runtime.interruptCount == 0)
        #expect(runtime.steerCount == 0)
        #expect(execution.owns(turn.requestId))
        #expect(runtime.hasActiveTurn(requestId: turn.requestId))
    }

    @Test func explicitUserInterruptCancelsRuntimeExactlyOnce() throws {
        let runtime = FakeForegroundRuntime()
        let execution = YishuForegroundRuntimeExecution(runtime: runtime)
        let turn = try execution.startTestTurn("先说这个")

        execution.cancel(reason: "user-interrupted")
        execution.cancel(reason: "user-interrupted")
        execution.cancel(requestId: turn.requestId, reason: "task-cancelled")

        #expect(runtime.cancelCount == 1)
        #expect(runtime.cancelReasons == ["user-interrupted"])
        #expect(runtime.cancelRequestIds == [turn.requestId])
        #expect(!execution.isActive)
        #expect(!execution.owns(turn.requestId))
        #expect(!runtime.hasActiveTurn(requestId: turn.requestId))
    }

    @Test func eligibleConversationalBargeInSteersSameTurn() async throws {
        let runtime = FakeForegroundRuntime()
        let execution = YishuForegroundRuntimeExecution(runtime: runtime)
        let firstUtterance = "换个说法，我想问为什么天空是蓝色的"
        #expect(YishuBargeInPolicy.allowsSameSessionConversation(firstUtterance))
        let turn = try execution.startTestTurn("天空为什么是蓝的")
        let generation = try #require(execution.activeGeneration(requestId: turn.requestId))

        #expect(execution.suppressForInterruption(
            requestId: turn.requestId,
            expectedGeneration: generation
        ))
        let decision = try await execution.interrupt(
            requestId: turn.requestId,
            expectedGeneration: generation
        )
        guard case let .accepted(interruptedGeneration, nextGeneration) = decision else {
            Issue.record("expected accepted interrupt, got \(decision)")
            return
        }
        #expect(interruptedGeneration == generation)
        try execution.steer(
            requestId: turn.requestId,
            message: firstUtterance,
            nextGeneration: nextGeneration
        )

        #expect(runtime.startCount == 1)
        #expect(runtime.cancelCount == 0)
        #expect(runtime.interruptCount == 1)
        #expect(runtime.steerCount == 1)
        #expect(runtime.steerMessages == [firstUtterance])
        #expect(runtime.steerGenerations == [nextGeneration])
        #expect(execution.owns(turn.requestId))
        var presentation = YishuRuntimePresentationReducer()
        presentation.appendCurrentDelta("旧回答。")
        #expect(presentation.advancePresentation(to: nextGeneration) == .advanced)
        #expect(presentation.authoritativeText.isEmpty)
    }

    @Test func effectfulUtteranceCancelsAndStartsFreshContextTurn() throws {
        let runtime = FakeForegroundRuntime()
        let execution = YishuForegroundRuntimeExecution(runtime: runtime)
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("点击这个按钮"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("解释一下当前页面"))

        let first = try execution.startTestTurn("它是什么意思")
        execution.cancel(reason: "fresh-context-required")
        let second = try execution.startTestTurn("点击这个按钮")

        #expect(runtime.startCount == 2)
        #expect(runtime.cancelCount == 1)
        #expect(runtime.cancelReasons == ["fresh-context-required"])
        #expect(runtime.steerCount == 0)
        #expect(runtime.startUtterances == ["它是什么意思", "点击这个按钮"])
        #expect(!execution.owns(first.requestId))
        #expect(execution.owns(second.requestId))
        #expect(first.requestId != second.requestId)
    }

    @Test(arguments: [
        TerminalKind.completed,
        .cancelled,
        .failed,
        .timedOut,
        .terminated,
    ])
    func terminalOutcomesSettleExecutionExactlyOnce(kind: TerminalKind) throws {
        let runtime = FakeForegroundRuntime()
        let execution = YishuForegroundRuntimeExecution(runtime: runtime)
        let turn = try execution.startTestTurn("在吗")

        switch kind {
        case .cancelled:
            execution.cancel(reason: "user-interrupted")
        case .completed, .failed, .timedOut, .terminated:
            if kind == .failed {
                runtime.finish(turn.requestId, throwing: YishuAgentRuntimeClientError.turnFailed(
                    code: "turn_failed",
                    message: nil
                ))
            } else if kind == .timedOut {
                runtime.finish(turn.requestId, throwing: YishuAgentRuntimeClientError.turnTimedOut)
            } else {
                runtime.finish(turn.requestId)
            }
            execution.settle(turn.requestId)
        }

        execution.settle(turn.requestId)
        execution.cancel(reason: "late-duplicate")
        execution.cancel(requestId: turn.requestId, reason: "task-cancelled")

        #expect(!execution.isActive)
        #expect(!execution.owns(turn.requestId))
        if kind == .cancelled {
            #expect(runtime.cancelCount == 1)
            #expect(runtime.cancelReasons == ["user-interrupted"])
        } else {
            #expect(runtime.cancelCount == 0)
        }
    }

    @Test func staleRequestAndGenerationEventsCannotResurrectExecution() async throws {
        let runtime = FakeForegroundRuntime()
        let execution = YishuForegroundRuntimeExecution(runtime: runtime)
        let first = try execution.startTestTurn("第一轮")
        execution.settle(first.requestId)
        let second = try execution.startTestTurn("第二轮")

        runtime.finish(first.requestId)
        execution.settle(first.requestId)
        execution.cancel(requestId: first.requestId, reason: "stale")
        do {
            try execution.steer(
                requestId: first.requestId,
                message: "迟到的转向",
                nextGeneration: 2
            )
            Issue.record("stale steer must not succeed")
        } catch YishuAgentRuntimeClientError.turnInterruptUnavailable {
        } catch {
            Issue.record("stale steer threw \(error)")
        }
        do {
            _ = try await execution.interrupt(
                requestId: first.requestId,
                expectedGeneration: 1
            )
            Issue.record("stale interrupt must not succeed")
        } catch YishuAgentRuntimeClientError.turnInterruptUnavailable {
        } catch {
            Issue.record("stale interrupt threw \(error)")
        }
        #expect(!execution.suppressForInterruption(
            requestId: first.requestId,
            expectedGeneration: 1
        ))
        #expect(execution.activeGeneration(requestId: first.requestId) == nil)

        #expect(execution.owns(second.requestId))
        #expect(!execution.owns(first.requestId))
        #expect(runtime.cancelCount == 0)
        #expect(runtime.startCount == 2)
    }
}

enum TerminalKind: String, CaseIterable {
    case completed
    case cancelled
    case failed
    case timedOut
    case terminated
}

extension YishuForegroundRuntimeExecution {
    fileprivate func startTestTurn(_ utterance: String) throws -> YishuRuntimeTurn {
        try start(
            utterance: utterance,
            contextFrame: dummyFrame(),
            modelProvider: "local",
            model: "test",
            modelRouting: .fixed(
                preference: YishuModelPreference(provider: "local", model: "test")
            )
        )
    }
}

private func dummyFrame() -> YishuContextFrame {
    let now = Date()
    let point = YishuScreenPoint(x: 0, y: 0, coordinateSpace: .globalTopLeft)
    return YishuContextFrame(
        capturedAt: now,
        expiresAt: now.addingTimeInterval(15),
        cursor: YishuObservedValue(
            value: point,
            source: "test",
            capturedAt: now,
            confidence: 1
        ),
        pointerTrail: [],
        frontmostApplication: nil,
        activeWindow: nil,
        elementUnderCursor: nil,
        screenshots: [],
        numberedTargets: [],
        warnings: []
    )
}
