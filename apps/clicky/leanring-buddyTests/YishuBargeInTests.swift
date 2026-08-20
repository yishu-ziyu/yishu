import Foundation
import Testing
@testable import Clicky

struct YishuBargeInTests {
    @Test func sameSessionSteerIsStrictlyPureConversation() {
        #expect(YishuBargeInPolicy.allowsSameSessionConversation("换个说法，我想问为什么天空是蓝色的"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("点击这个按钮"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("解释一下当前页面"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("给我创建一个关于雨的故事"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("create a story about rain"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("复制上一段并粘贴到这里"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("剪切前一个，拷贝上一个"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("copy the last paragraph and paste it here"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("cut the previous one"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("继续刚才的"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("把它改成红色"))
        #expect(YishuBargeInPolicy.allowsSameSessionConversation("它是什么意思"))
        #expect(YishuBargeInPolicy.allowsSameSessionConversation("What does it mean?"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("记住：我喜欢简短回答"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("20分钟后提醒我喝一口水"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("能不能20分钟后提醒我喝水"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation("20分钟后提醒我喝水呢"))
        #expect(!YishuBargeInPolicy.allowsSameSessionConversation(""))
    }

    @Test func projectionReducerSupportsConsecutiveOneToTwoToThreeInterruptions() {
        let requestID = UUID()
        var reducer = YishuTurnProjectionReducer(requestId: requestID)

        #expect(reducer.accepts(requestId: requestID, generation: 1))
        let beganFirstInterruption = reducer.beginInterruption(
            requestId: requestID,
            expectedGeneration: 1
        )
        #expect(beganFirstInterruption)
        #expect(!reducer.accepts(requestId: requestID, generation: 1))
        let acceptedSecondGeneration = reducer.acceptInterruption(
            requestId: requestID,
            interruptedGeneration: 1,
            nextGeneration: 2
        )
        #expect(acceptedSecondGeneration)
        #expect(reducer.accepts(requestId: requestID, generation: 2))
        #expect(!reducer.accepts(requestId: requestID, generation: 1))
        let consumedSecondGeneration = reducer.consumeSteer(
            requestId: requestID,
            nextGeneration: 2
        )
        let duplicatedSecondGeneration = reducer.consumeSteer(
            requestId: requestID,
            nextGeneration: 2
        )
        #expect(consumedSecondGeneration)
        #expect(!duplicatedSecondGeneration)

        let beganSecondInterruption = reducer.beginInterruption(
            requestId: requestID,
            expectedGeneration: 2
        )
        let acceptedThirdGeneration = reducer.acceptInterruption(
            requestId: requestID,
            interruptedGeneration: 2,
            nextGeneration: 3
        )
        let consumedThirdGeneration = reducer.consumeSteer(
            requestId: requestID,
            nextGeneration: 3
        )
        #expect(beganSecondInterruption)
        #expect(acceptedThirdGeneration)
        #expect(consumedThirdGeneration)
        #expect(reducer.accepts(requestId: requestID, generation: 3))
        #expect(!reducer.accepts(requestId: requestID, generation: 2))
        #expect(!reducer.accepts(requestId: UUID(), generation: 3))
    }

    @Test func generationAdvanceDropsOldAccumulationAndKeepsOnlyNewFinal() {
        var projection = YishuRuntimePresentationReducer()
        projection.appendCurrentDelta("旧回答。")

        let advancedToSecondGeneration = projection.advancePresentation(to: 2)
        #expect(advancedToSecondGeneration == .advanced)
        #expect(projection.authoritativeText.isEmpty)
        projection.appendCurrentDelta("新回")
        projection.appendCurrentDelta("答。")
        projection.completeCurrent(with: "新回答。")

        let oldGenerationDisposition = projection.advancePresentation(to: 1)
        #expect(oldGenerationDisposition == .stale)
        #expect(projection.authoritativeText == "新回答。")
        let advancedToThirdGeneration = projection.advancePresentation(to: 3)
        #expect(advancedToThirdGeneration == .advanced)
        #expect(projection.authoritativeText.isEmpty)
    }

    @Test @MainActor func runtimeIngressDropsWrongEnvelopeDuplicatesAndStaleGeneration() async throws {
        let client = YishuAgentRuntimeClient()
        let requestID = UUID()
        let traceID = UUID()
        let parked = client.parkTurnForTests(requestId: requestID, traceId: traceID)

        client.dispatchRuntimeEventForTests(event(
            "response.delta",
            requestID: requestID,
            traceID: UUID(),
            payload: ["text": "wrong-trace", "generation": 1]
        ))
        client.dispatchRuntimeEventForTests(event(
            "response.completed",
            requestID: requestID,
            traceID: UUID(),
            payload: ["text": "wrong-terminal", "verified": true, "generation": 1]
        ))
        client.dispatchRuntimeEventForTests(event(
            "turn.cancelled",
            requestID: requestID,
            traceID: UUID(),
            payload: ["generation": 1]
        ))
        client.dispatchRuntimeEventForTests(event(
            "response.delta",
            schemaVersion: 2,
            requestID: requestID,
            traceID: traceID,
            payload: ["text": "wrong-schema", "generation": 1]
        ))

        let duplicateID = UUID()
        let firstDelta = event(
            "response.delta",
            eventID: duplicateID,
            requestID: requestID,
            traceID: traceID,
            payload: ["text": "A-before", "generation": 1]
        )
        client.dispatchRuntimeEventForTests(firstDelta)
        client.dispatchRuntimeEventForTests(firstDelta)
        #expect(client.suppressTurnForInterruption(
            requestId: requestID,
            expectedGeneration: 1
        ))
        client.dispatchRuntimeEventForTests(event(
            "response.delta",
            requestID: requestID,
            traceID: traceID,
            payload: ["text": "A-stale", "generation": 1]
        ))
        #expect(client.acceptTurnInterruptionForTests(
            requestId: requestID,
            interruptedGeneration: 1,
            nextGeneration: 2
        ))
        client.dispatchRuntimeEventForTests(event(
            "response.delta",
            requestID: requestID,
            traceID: traceID,
            payload: ["text": "B", "generation": 2]
        ))
        client.dispatchRuntimeEventForTests(event(
            "response.delta",
            requestID: requestID,
            traceID: traceID,
            payload: ["text": "A-late", "generation": 1]
        ))
        client.dispatchRuntimeEventForTests(event(
            "response.completed",
            requestID: requestID,
            traceID: traceID,
            payload: ["text": "B", "verified": true, "generation": 2]
        ))

        var projection: [String] = []
        for try await runtimeEvent in parked.turn.events {
            switch runtimeEvent {
            case let .responseDelta(text, generation):
                projection.append("delta:\(generation):\(text)")
            case let .completed(text, _, generation):
                projection.append("completed:\(generation):\(text)")
            default:
                break
            }
        }
        #expect(projection == ["delta:1:A-before", "delta:2:B", "completed:2:B"])
        #expect(client.pendingTurnCountForTests == 0)
    }

    @Test @MainActor func oldTerminalDuringPendingInterruptClosesWithoutProjectionOrHang() async {
        let client = YishuAgentRuntimeClient()
        let requestID = UUID()
        let traceID = UUID()
        let parked = client.parkTurnForTests(requestId: requestID, traceId: traceID)
        #expect(client.suppressTurnForInterruption(
            requestId: requestID,
            expectedGeneration: 1
        ))

        client.dispatchRuntimeEventForTests(event(
            "response.completed",
            requestID: requestID,
            traceID: traceID,
            payload: ["text": "must-not-project", "verified": true, "generation": 1]
        ))

        var projectedCount = 0
        var cancelled = false
        do {
            for try await _ in parked.turn.events {
                projectedCount += 1
            }
        } catch is CancellationError {
            cancelled = true
        } catch {
            Issue.record("Unexpected terminal race error: \(error)")
        }
        #expect(projectedCount == 0)
        #expect(cancelled)
        #expect(client.pendingTurnCountForTests == 0)
    }

    @Test @MainActor func rejectedSubmittedSteerTriggersOneImmediateFreshStartTranscript() async {
        let client = YishuAgentRuntimeClient()
        let requestID = UUID()
        let traceID = UUID()
        let parked = client.parkTurnForTests(requestId: requestID, traceId: traceID)
        let message = "create a story about rain"

        #expect(client.suppressTurnForInterruption(
            requestId: requestID,
            expectedGeneration: 1
        ))
        #expect(client.acceptTurnInterruptionForTests(
            requestId: requestID,
            interruptedGeneration: 1,
            nextGeneration: 2
        ))
        #expect(client.markTurnSteeredForTests(
            requestId: requestID,
            message: message,
            nextGeneration: 2
        ))

        // Runtime acknowledges queueing the steer before the replacement
        // assistant starts. This status must not consume the replay marker.
        client.dispatchRuntimeEventForTests(event(
            "runtime.status",
            requestID: requestID,
            traceID: traceID,
            payload: ["generation": 2, "status": "steering_received"]
        ))

        client.dispatchRuntimeEventForTests(event(
            "turn.interrupt.rejected",
            requestID: requestID,
            traceID: UUID(),
            payload: ["generation": 2, "code": "effectful_steer"]
        ))
        #expect(client.pendingTurnCountForTests == 1)

        let rejection = event(
            "turn.interrupt.rejected",
            requestID: requestID,
            traceID: traceID,
            payload: ["generation": 2, "code": "effectful_steer"]
        )
        client.dispatchRuntimeEventForTests(rejection)
        client.dispatchRuntimeEventForTests(rejection)

        var projectedCount = 0
        var freshStarts: [String] = []
        do {
            for try await _ in parked.turn.events {
                projectedCount += 1
            }
        } catch {
            if let transcript = CompanionManager.rejectedSteerTranscript(from: error) {
                freshStarts.append(transcript)
            } else {
                Issue.record("Unexpected steer rejection error: \(error)")
            }
        }
        #expect(projectedCount == 0)
        #expect(freshStarts == [message])
        #expect(client.pendingTurnCountForTests == 0)
    }

    @Test @MainActor func latePriorSteerRejectionCannotReplayAfterNextInterruptBegins() async {
        let client = YishuAgentRuntimeClient()
        let requestID = UUID()
        let traceID = UUID()
        let parked = client.parkTurnForTests(requestId: requestID, traceId: traceID)

        #expect(client.suppressTurnForInterruption(
            requestId: requestID,
            expectedGeneration: 1
        ))
        #expect(client.acceptTurnInterruptionForTests(
            requestId: requestID,
            interruptedGeneration: 1,
            nextGeneration: 2
        ))
        #expect(client.markTurnSteeredForTests(
            requestId: requestID,
            message: "B",
            nextGeneration: 2
        ))
        client.dispatchRuntimeEventForTests(event(
            "response.delta",
            requestID: requestID,
            traceID: traceID,
            payload: ["text": "B-live", "generation": 2]
        ))

        // This is the same reducer state as after a second interrupt RPC timed
        // out: the generation-2 floor remains pending, but its continuation is
        // gone. A late generation-2 rejection must not be reinterpreted as the
        // already-live B steer failing and replay B beside the new C utterance.
        #expect(client.suppressTurnForInterruption(
            requestId: requestID,
            expectedGeneration: 2
        ))
        client.dispatchRuntimeEventForTests(event(
            "turn.interrupt.rejected",
            requestID: requestID,
            traceID: traceID,
            payload: ["generation": 2, "code": "stale_generation"]
        ))
        #expect(client.pendingTurnCountForTests == 1)

        client.timeoutTurnForTests(requestId: requestID)
        var deltas: [String] = []
        do {
            for try await runtimeEvent in parked.turn.events {
                if case let .responseDelta(text, _) = runtimeEvent {
                    deltas.append(text)
                }
            }
        } catch let error as YishuAgentRuntimeClientError {
            if case .turnTimedOut = error {} else {
                Issue.record("Unexpected second-interrupt cleanup error: \(error)")
            }
        } catch {
            Issue.record("Unexpected second-interrupt cleanup error: \(error)")
        }
        #expect(deltas == ["B-live"])
    }

    @Test @MainActor func steerFailureBeforeAnyLiveReplacementFreshStartsExactlyOnce() async {
        let client = YishuAgentRuntimeClient()
        let requestID = UUID()
        let traceID = UUID()
        let parked = client.parkTurnForTests(requestId: requestID, traceId: traceID)
        let message = "请换成更温柔的说法"

        #expect(client.suppressTurnForInterruption(
            requestId: requestID,
            expectedGeneration: 1
        ))
        #expect(client.acceptTurnInterruptionForTests(
            requestId: requestID,
            interruptedGeneration: 1,
            nextGeneration: 2
        ))
        #expect(client.markTurnSteeredForTests(
            requestId: requestID,
            message: message,
            nextGeneration: 2
        ))

        client.dispatchRuntimeEventForTests(event(
            "runtime.status",
            requestID: requestID,
            traceID: traceID,
            payload: ["generation": 2, "status": "steering_received"]
        ))

        client.dispatchRuntimeEventForTests(event(
            "turn.failed",
            requestID: requestID,
            traceID: UUID(),
            payload: [
                "generation": 2,
                "code": "steer_replacement_failed_before_start",
            ]
        ))
        client.dispatchRuntimeEventForTests(event(
            "turn.failed",
            requestID: requestID,
            traceID: traceID,
            payload: [
                "generation": 1,
                "code": "steer_replacement_failed_before_start",
            ]
        ))
        #expect(client.pendingTurnCountForTests == 1)

        let preLiveFailure = event(
            "turn.failed",
            requestID: requestID,
            traceID: traceID,
            payload: [
                "generation": 2,
                "code": "steer_replacement_failed_before_start",
            ]
        )
        client.dispatchRuntimeEventForTests(preLiveFailure)
        client.dispatchRuntimeEventForTests(preLiveFailure)

        var freshStarts: [String] = []
        do {
            for try await _ in parked.turn.events {}
        } catch {
            if let transcript = CompanionManager.rejectedSteerTranscript(from: error) {
                freshStarts.append(transcript)
            } else {
                Issue.record("Unexpected pre-live steer failure: \(error)")
            }
        }
        #expect(freshStarts == [message])
        #expect(client.pendingTurnCountForTests == 0)
    }

    @Test @MainActor func steerFailureAfterReplacementIsLiveDoesNotReplayTranscript() async {
        let client = YishuAgentRuntimeClient()
        let requestID = UUID()
        let traceID = UUID()
        let parked = client.parkTurnForTests(requestId: requestID, traceId: traceID)

        #expect(client.suppressTurnForInterruption(
            requestId: requestID,
            expectedGeneration: 1
        ))
        #expect(client.acceptTurnInterruptionForTests(
            requestId: requestID,
            interruptedGeneration: 1,
            nextGeneration: 2
        ))
        #expect(client.markTurnSteeredForTests(
            requestId: requestID,
            message: "B",
            nextGeneration: 2
        ))
        client.dispatchRuntimeEventForTests(event(
            "response.delta",
            requestID: requestID,
            traceID: traceID,
            payload: ["text": "B-live", "generation": 2]
        ))
        client.dispatchRuntimeEventForTests(event(
            "turn.failed",
            requestID: requestID,
            traceID: traceID,
            payload: ["generation": 2, "code": "pi_turn_failed"]
        ))

        var deltas: [String] = []
        var replayed = false
        var failedNormally = false
        do {
            for try await runtimeEvent in parked.turn.events {
                if case let .responseDelta(text, _) = runtimeEvent {
                    deltas.append(text)
                }
            }
        } catch {
            replayed = CompanionManager.rejectedSteerTranscript(from: error) != nil
            if let runtimeError = error as? YishuAgentRuntimeClientError,
               case .turnFailed = runtimeError {
                failedNormally = true
            }
        }
        #expect(deltas == ["B-live"])
        #expect(!replayed)
        #expect(failedNormally)
    }

    @Test @MainActor func foregroundTurnTimeoutAlwaysClearsContinuation() async {
        let client = YishuAgentRuntimeClient()
        let parked = client.parkTurnForTests()
        client.timeoutTurnForTests(requestId: parked.turn.requestId)

        var timedOut = false
        do {
            for try await _ in parked.turn.events {}
        } catch let error as YishuAgentRuntimeClientError {
            if case .turnTimedOut = error {
                timedOut = true
            }
        } catch {
            Issue.record("Unexpected watchdog error: \(error)")
        }
        #expect(timedOut)
        #expect(client.pendingTurnCountForTests == 0)
    }

    @Test @MainActor func firstByteTimeoutFailsTheTurnAsTimedOut() async {
        let client = YishuAgentRuntimeClient()
        let requestID = UUID()
        let traceID = UUID()
        let parked = client.parkTurnForTests(requestId: requestID, traceId: traceID)
        client.dispatchRuntimeEventForTests(event(
            "turn.failed",
            requestID: requestID,
            traceID: traceID,
            payload: ["generation": 1, "code": "first_byte_timeout"]
        ))

        var timedOut = false
        do {
            for try await _ in parked.turn.events {}
        } catch let error as YishuAgentRuntimeClientError {
            if case .turnTimedOut = error {
                timedOut = true
            }
        } catch {
            Issue.record("Unexpected first-byte mapping error: \(error)")
        }
        #expect(timedOut)
        #expect(client.pendingTurnCountForTests == 0)
    }

    @Test @MainActor func authorizationFenceBlocksEveryIrreversibleCommitSeam() {
        var commitCount = 0
        for _ in 0..<3 {
            let result = YishuComputerUseActuator.authorizedCommit({ false }) {
                commitCount += 1
                return true
            }
            #expect(result == nil)
        }
        #expect(commitCount == 0)

        let allowed = YishuComputerUseActuator.authorizedCommit({ true }) {
            commitCount += 1
            return true
        }
        #expect(allowed == true)
        #expect(commitCount == 1)
    }

    private func event(
        _ type: String,
        schemaVersion: Int = 1,
        eventID: UUID = UUID(),
        requestID: UUID,
        traceID: UUID,
        payload: [String: Any]
    ) -> [String: Any] {
        [
            "schemaVersion": schemaVersion,
            "type": type,
            "eventId": eventID.uuidString,
            "requestId": requestID.uuidString,
            "traceId": traceID.uuidString,
            "sentAt": "2026-08-13T00:00:00Z",
            "payload": payload,
        ]
    }
}
