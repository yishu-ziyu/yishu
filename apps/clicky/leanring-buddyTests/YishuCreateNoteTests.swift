import CoreGraphics
import Foundation
import Testing
import YishuContext
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

        let source: [String: Any] = [
            "sourceBundleId": "com.apple.Safari",
            "sourcePid": 42,
            "sourceWindowNumber": 9,
            "sourceWindowTitle": "Three actions",
            "sourceWindowBounds": ["x": 12.0, "y": 34.0, "width": 800.0, "height": 600.0],
        ]
        let pageRequest = try #require(YishuAgentRuntimeClient.decodeComputerActionRequest(
            payload: payload.merging(source) { _, new in new },
            requestId: requestID,
            traceId: traceID,
            schemaVersion: NSNumber(value: 1)
        ))
        #expect(pageRequest.sourceWindowTarget?.windowNumber == 9)

        var partialSource = payload
        partialSource["sourceBundleId"] = "com.apple.Safari"
        #expect(YishuAgentRuntimeClient.decodeComputerActionRequest(
            payload: partialSource,
            requestId: requestID,
            traceId: traceID,
            schemaVersion: NSNumber(value: 1)
        ) == nil)

        var invalidBounds = payload.merging(source) { _, new in new }
        invalidBounds["sourceWindowBounds"] = ["x": 0, "y": 0, "width": 0, "height": 100]
        #expect(YishuAgentRuntimeClient.decodeComputerActionRequest(
            payload: invalidBounds,
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

    @Test func pageNoteSourceAndAuthorizationAreBothCheckedAtSubmission() async {
        let title = "Current page"
        let content = "1. First\n2. Second\n3. Third"
        let request = YishuComputerActionRequest(
            requestId: UUID(), traceId: UUID(), actionId: UUID(), action: "create_note", x: 0, y: 0,
            title: title, content: content,
            sourceBundleId: "com.apple.Safari", sourcePid: 42, sourceWindowNumber: 9,
            sourceWindowTitle: "Three actions",
            sourceWindowBounds: YishuWindowBounds(x: 12, y: 34, width: 800, height: 600),
            targetBundleId: "com.apple.Notes", intentId: UUID().uuidString,
            attemptId: UUID().uuidString, basisFrameId: UUID().uuidString, effectClass: "write"
        )
        var authorized = true
        var sourceMatches = true
        var submissions = 0
        let executor: YishuComputerUseActuator.NotesExecutor = { receivedTitle, _, expectedPlaintext, fence in
            YishuComputerUseActuator.authorizedCommit(fence) {
                submissions += 1
                return .created(noteId: "note-id", title: receivedTitle, plaintext: expectedPlaintext)
            } ?? .blockedBeforeSubmission
        }

        let verified = await YishuComputerUseActuator.perform(
            request, screenCaptures: [], authorizationFence: { authorized }, notesExecutor: executor,
            sourceWindowValidator: { _ in sourceMatches }
        )
        #expect(verified.verified)
        #expect(submissions == 1)

        sourceMatches = false
        let stale = await YishuComputerUseActuator.perform(
            request, screenCaptures: [], authorizationFence: { authorized }, notesExecutor: executor,
            sourceWindowValidator: { _ in sourceMatches }
        )
        #expect(stale.code == .targetStale)
        #expect(submissions == 1)

        sourceMatches = true
        authorized = false
        let blocked = await YishuComputerUseActuator.perform(
            request, screenCaptures: [], authorizationFence: { authorized }, notesExecutor: executor,
            sourceWindowValidator: { _ in sourceMatches }
        )
        #expect(blocked.code == .permissionDenied)
        #expect(submissions == 1)
    }

    @Test func sourceWindowUsesOnlyTheFrontmostWindowForTheSameApp() {
        let pid = pid_t(42)
        let oldWindow: [String: Any] = [
            kCGWindowOwnerPID as String: pid,
            kCGWindowLayer as String: 0,
            kCGWindowNumber as String: 9,
        ]
        let newlyFrontmostWindow: [String: Any] = [
            kCGWindowOwnerPID as String: pid,
            kCGWindowLayer as String: 0,
            kCGWindowNumber as String: 10,
        ]
        let selected = YishuComputerUseActuator.frontmostLayerZeroWindow(
            in: [newlyFrontmostWindow, oldWindow],
            ownedBy: pid
        )
        #expect(selected?[kCGWindowNumber as String] as? Int == 10)
        #expect(selected?[kCGWindowNumber as String] as? Int != 9)
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
