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

/// Sole owner of the active foreground Runtime request identity and of
/// start / cancel / interrupt / steer. CompanionManager decides product
/// policy and presentation; stopping speech is a different operation.
@MainActor
final class YishuForegroundRuntimeExecution {
    private let runtime: any YishuForegroundRuntimeControlling
    private(set) var activeRequestId: UUID?

    init(runtime: any YishuForegroundRuntimeControlling) {
        self.runtime = runtime
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
    ) throws -> YishuRuntimeTurn {
        let turn = try runtime.startTurn(
            utterance: utterance,
            contextFrame: contextFrame,
            modelProvider: modelProvider,
            model: model,
            modelRouting: modelRouting,
            capabilityProfile: capabilityProfile
        )
        activeRequestId = turn.requestId
        return turn
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

    /// Completes, fails, times out, or otherwise ends without sending cancel.
    func settle(_ requestId: UUID) {
        guard activeRequestId == requestId else { return }
        activeRequestId = nil
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
}
