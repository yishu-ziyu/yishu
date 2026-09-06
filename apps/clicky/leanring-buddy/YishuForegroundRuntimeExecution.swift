import Foundation

/// Low-level Runtime turn mutations the presentation owner must not call.
@MainActor
protocol YishuForegroundRuntimeControlling: AnyObject {
    func startTurn(
        utterance: String,
        contextFrame: YishuContextFrame,
        modelProvider: String,
        model: String,
        modelRouting: YishuModelRouting,
        capabilityProfile: String
    ) throws -> YishuRuntimeTurn
    func cancelTurn(requestId: UUID, reason: String) throws
    func interruptTurn(
        requestId: UUID,
        expectedGeneration: Int
    ) async throws -> YishuTurnInterruptDecision
    func steerTurn(
        requestId: UUID,
        message: String,
        nextGeneration: Int
    ) throws
    func suppressTurnForInterruption(requestId: UUID, expectedGeneration: Int) -> Bool
    func activeGeneration(requestId: UUID) -> Int?
    func hasActiveTurn(requestId: UUID) -> Bool
    var hasActiveTurn: Bool { get }
}

extension YishuAgentRuntimeClient: YishuForegroundRuntimeControlling {}

/// Rejected `start` while another foreground execution is still owned.
/// Distinct from cancel: callers must cancel first.
enum YishuForegroundRuntimeExecutionError: Error, Equatable {
    case alreadyActive
}

/// Presentation-facing view of one foreground execution. Cancelling
/// iteration of `events` does not cancel or settle the Runtime turn.
struct YishuForegroundRuntimeSession {
    let requestId: UUID
    let conversationId: UUID
    let events: AsyncThrowingStream<YishuRuntimeTurnEvent, Error>
}

/// Sole owner of the active foreground Runtime request identity, of
/// start / cancel / interrupt / steer, and of the async lifetime that
/// keeps the Runtime turn/event stream alive.
///
/// Runtime Client → this type → typed execution events → presentation.
/// Stopping speech or detaching a presentation consumer is a different
/// operation from cancelling execution.
@MainActor
final class YishuForegroundRuntimeExecution {
    private let runtime: any YishuForegroundRuntimeControlling
    private(set) var activeRequestId: UUID?
    private var runtimeEventTask: Task<Void, Never>?
    private var consumingRequestId: UUID?
    private var presentationSubscribers: [UUID: AsyncThrowingStream<YishuRuntimeTurnEvent, Error>.Continuation] = [:]

    init(runtime: any YishuForegroundRuntimeControlling) {
        self.runtime = runtime
    }

    deinit {
        runtimeEventTask?.cancel()
    }

    var isActive: Bool { activeRequestId != nil }

    func owns(_ requestId: UUID) -> Bool {
        activeRequestId == requestId
    }

    func activeGeneration(requestId: UUID) -> Int? {
        guard owns(requestId) else { return nil }
        return runtime.activeGeneration(requestId: requestId)
    }

    func hasActiveTurn(requestId: UUID) -> Bool {
        owns(requestId) && runtime.hasActiveTurn(requestId: requestId)
    }

    func start(
        utterance: String,
        contextFrame: YishuContextFrame,
        modelProvider: String,
        model: String,
        modelRouting: YishuModelRouting,
        capabilityProfile: String = "conversation"
    ) throws -> YishuForegroundRuntimeSession {
        guard !isActive else {
            throw YishuForegroundRuntimeExecutionError.alreadyActive
        }
        let turn = try runtime.startTurn(
            utterance: utterance,
            contextFrame: contextFrame,
            modelProvider: modelProvider,
            model: model,
            modelRouting: modelRouting,
            capabilityProfile: capabilityProfile
        )
        abandonRuntimeEventConsumer()
        activeRequestId = turn.requestId
        consumingRequestId = turn.requestId
        let events = makePresentationEvents()
        startOwningRuntimeEvents(turn)
        return YishuForegroundRuntimeSession(
            requestId: turn.requestId,
            conversationId: turn.conversationId,
            events: events
        )
    }

    func cancel(reason: String) {
        guard let requestId = activeRequestId else { return }
        cancel(requestId: requestId, reason: reason)
    }

    func cancel(requestId: UUID, reason: String) {
        guard activeRequestId == requestId else { return }
        activeRequestId = nil
        try? runtime.cancelTurn(requestId: requestId, reason: reason)
    }

    func suppressForInterruption(requestId: UUID, expectedGeneration: Int) -> Bool {
        guard owns(requestId) else { return false }
        return runtime.suppressTurnForInterruption(
            requestId: requestId,
            expectedGeneration: expectedGeneration
        )
    }

    func interrupt(
        requestId: UUID,
        expectedGeneration: Int
    ) async throws -> YishuTurnInterruptDecision {
        guard owns(requestId) else {
            throw YishuAgentRuntimeClientError.turnInterruptUnavailable
        }
        return try await runtime.interruptTurn(
            requestId: requestId,
            expectedGeneration: expectedGeneration
        )
    }

    func steer(
        requestId: UUID,
        message: String,
        nextGeneration: Int
    ) throws {
        guard owns(requestId) else {
            throw YishuAgentRuntimeClientError.turnInterruptUnavailable
        }
        try runtime.steerTurn(
            requestId: requestId,
            message: message,
            nextGeneration: nextGeneration
        )
    }

    /// Additional presentation subscriber. Detaching it does not settle
    /// execution. Events already observed by a prior consumer are not replayed.
    func makePresentationEvents() -> AsyncThrowingStream<YishuRuntimeTurnEvent, Error> {
        let subscriberId = UUID()
        var continuation: AsyncThrowingStream<YishuRuntimeTurnEvent, Error>.Continuation?
        let stream = AsyncThrowingStream<YishuRuntimeTurnEvent, Error> { continuation = $0 }
        guard let continuation else { return stream }
        presentationSubscribers[subscriberId] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor in
                self?.presentationSubscribers.removeValue(forKey: subscriberId)
            }
        }
        return stream
    }

    private func abandonRuntimeEventConsumer() {
        runtimeEventTask?.cancel()
        runtimeEventTask = nil
        consumingRequestId = nil
        let subscribers = presentationSubscribers
        presentationSubscribers.removeAll()
        for continuation in subscribers.values {
            continuation.finish()
        }
    }

    private func startOwningRuntimeEvents(_ turn: YishuRuntimeTurn) {
        let requestId = turn.requestId
        runtimeEventTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                for try await event in turn.events {
                    guard !Task.isCancelled else { return }
                    guard self.consumingRequestId == requestId else { return }
                    self.broadcast(event)
                }
                self.finishRuntimeStream(requestId: requestId, error: nil)
            } catch is CancellationError {
                return
            } catch {
                self.finishRuntimeStream(requestId: requestId, error: error)
            }
        }
    }

    private func broadcast(_ event: YishuRuntimeTurnEvent) {
        for continuation in presentationSubscribers.values {
            continuation.yield(event)
        }
    }

    private func finishRuntimeStream(requestId: UUID, error: Error?) {
        guard consumingRequestId == requestId else { return }
        if activeRequestId == requestId {
            activeRequestId = nil
        }
        consumingRequestId = nil
        runtimeEventTask = nil
        let subscribers = presentationSubscribers
        presentationSubscribers.removeAll()
        for continuation in subscribers.values {
            if let error {
                continuation.finish(throwing: error)
            } else {
                continuation.finish()
            }
        }
    }
}
