import Foundation
import Testing
@testable import Clicky

@MainActor
struct YishuCreateNoteTests {
    @Test func strictCreateNoteDecodeRequiresTheCompleteTypedContract() throws {
        let requestID = UUID()
        let traceID = UUID()
        let actionID = UUID()
        let intentID = UUID()
        let attemptID = UUID()
        let basisFrameID = UUID()
        let payload: [String: Any] = [
            "actionId": actionID.uuidString,
            "action": "create_note",
            "x": 0,
            "y": 0,
            "title": "  Shopping  ",
            "content": "  Milk & tea  ",
            "targetBundleId": "com.apple.Notes",
            "intentId": intentID.uuidString,
            "attemptId": attemptID.uuidString,
            "basisFrameId": basisFrameID.uuidString,
            "effectClass": "write",
        ]

        let request = try #require(YishuAgentRuntimeClient.decodeComputerActionRequest(
            payload: payload,
            requestId: requestID,
            traceId: traceID,
            schemaVersion: NSNumber(value: 1)
        ))
        #expect(request.title == "Shopping")
        #expect(request.content == "Milk & tea")
        #expect(request.targetBundleId == "com.apple.Notes")
        #expect(request.targetPid == nil)

        var invalid = payload
        invalid["effectClass"] = "navigation"
        #expect(YishuAgentRuntimeClient.decodeComputerActionRequest(
            payload: invalid,
            requestId: requestID,
            traceId: traceID,
            schemaVersion: NSNumber(value: 1)
        ) == nil)
    }

    @Test func injectedExecutorVerifiesExactReadbackAndFencePreventsExecution() async throws {
        let title = "Shopping"
        let content = "Milk & <tea>"
        let request = YishuComputerActionRequest(
            requestId: UUID(),
            traceId: UUID(),
            actionId: UUID(),
            action: "create_note",
            x: 0,
            y: 0,
            title: title,
            content: content,
            targetBundleId: "com.apple.Notes",
            intentId: UUID().uuidString,
            attemptId: UUID().uuidString,
            basisFrameId: UUID().uuidString,
            effectClass: "write"
        )
        var allowedExecutionCount = 0
        let verified = await YishuComputerUseActuator.perform(
            request,
            screenCaptures: [],
            notesExecutor: { receivedTitle, htmlBody, expectedPlaintext, authorizationFence in
                #expect(receivedTitle == title)
                #expect(htmlBody == "Milk &amp; &lt;tea&gt;")
                #expect(expectedPlaintext == content)
                return YishuComputerUseActuator.authorizedCommit(authorizationFence) {
                    allowedExecutionCount += 1
                    return .created(noteId: "note-id", title: title, plaintext: content)
                } ?? .blockedBeforeSubmission
            }
        )
        #expect(verified.status == .verified)
        #expect(verified.method == .nativeCommand)
        #expect(allowedExecutionCount == 1)

        let preparation = NotesPreparationLatch()
        var authorized = true
        var blockedExecutionCount = 0
        let pending = Task { @MainActor in
            await YishuComputerUseActuator.perform(
                request,
                screenCaptures: [],
                authorizationFence: { authorized },
                notesExecutor: { _, _, _, authorizationFence in
                    await preparation.reachAndWait()
                    return YishuComputerUseActuator.authorizedCommit(authorizationFence) {
                        blockedExecutionCount += 1
                        return .created(noteId: "must-not-exist", title: title, plaintext: content)
                    } ?? .blockedBeforeSubmission
                }
            )
        }
        await preparation.waitUntilReached()
        authorized = false
        await preparation.release()
        let blocked = await pending.value
        #expect(blocked.status == .blocked)
        #expect(blocked.code == .permissionDenied)
        #expect(!blocked.succeeded)
        #expect(blockedExecutionCount == 0)
    }
}

private actor NotesPreparationLatch {
    private var reached = false
    private var released = false
    private var reachWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func reachAndWait() async {
        reached = true
        let waiters = reachWaiters
        reachWaiters.removeAll()
        waiters.forEach { $0.resume() }
        guard !released else { return }
        await withCheckedContinuation { releaseWaiter = $0 }
    }

    func waitUntilReached() async {
        guard !reached else { return }
        await withCheckedContinuation { reachWaiters.append($0) }
    }

    func release() {
        released = true
        releaseWaiter?.resume()
        releaseWaiter = nil
    }
}
