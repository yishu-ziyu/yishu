//
//  BuddyHybridTranscriptionStateMachine.swift
//  leanring-buddy
//
//  Pure reducer for the Apple Speech shadow + StepFun authoritative voice
//  turn. It owns no audio, timer, actor, UI, or provider objects.
//

import Foundation

enum BuddyHybridTranscriptionSource: String, Equatable, Sendable {
    case appleSpeechShadow
    case appleSpeechFallback
    case stepFunAuthoritative
    case legacyBuffered
}

enum BuddyHybridTranscriptionDropReason: String, Equatable, Sendable {
    case noActiveSession
    case tokenMismatch
    case staleSequence
    case afterRelease
    case duplicateRelease
    case sourceUnavailable
    case terminal
    case emptyFinal
}

enum BuddyHybridTranscriptionEvent: Equatable, Sendable {
    case partial(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        text: String
    )
    case final(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        source: BuddyHybridTranscriptionSource,
        text: String
    )
    case release(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64
    )
    case failure(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        source: BuddyHybridTranscriptionSource
    )
    case timeout(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64
    )
    case cancel(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64
    )
}

enum BuddyHybridTranscriptionEffect: Equatable, Sendable {
    case updatePartial(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        text: String
    )
    case submitFinal(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        source: BuddyHybridTranscriptionSource,
        text: String
    )
    case armFinalTimeout(token: BuddyTranscriptionSessionToken)
    case cancelStepFun(token: BuddyTranscriptionSessionToken)
    case cancelAppleSpeech(token: BuddyTranscriptionSessionToken)
    case cancelAll(token: BuddyTranscriptionSessionToken)
    case startLegacyBufferedFallback(token: BuddyTranscriptionSessionToken)
    case drop(
        token: BuddyTranscriptionSessionToken?,
        sequence: UInt64?,
        reason: BuddyHybridTranscriptionDropReason
    )
}

enum BuddyHybridTranscriptionPhase: Equatable, Sendable {
    case idle
    case capturing
    case finalizing
    case completed
    case cancelled
}

struct BuddyHybridTranscriptionStateSnapshot: Equatable, Sendable {
    let phase: BuddyHybridTranscriptionPhase
    let token: BuddyTranscriptionSessionToken?
    let lastSequence: UInt64
    let releaseSeen: Bool
    let stepFunFailed: Bool
    let appleSpeechFailed: Bool
    let submissionEmitted: Bool
    let pendingStepFunFinalText: String?
    let pendingAppleFinalText: String?
}

struct BuddyHybridTranscriptionStateMachine: Sendable {
    private(set) var snapshot = BuddyHybridTranscriptionStateSnapshot(
        phase: .idle,
        token: nil,
        lastSequence: 0,
        releaseSeen: false,
        stepFunFailed: false,
        appleSpeechFailed: false,
        submissionEmitted: false,
        pendingStepFunFinalText: nil,
        pendingAppleFinalText: nil
    )

    mutating func start(token: BuddyTranscriptionSessionToken) -> [BuddyHybridTranscriptionEffect] {
        var effects: [BuddyHybridTranscriptionEffect] = []
        if let oldToken = snapshot.token,
           snapshot.phase != .idle,
           snapshot.phase != .completed,
           snapshot.phase != .cancelled {
            effects.append(.cancelAll(token: oldToken))
        }

        snapshot = BuddyHybridTranscriptionStateSnapshot(
            phase: .capturing,
            token: token,
            lastSequence: 0,
            releaseSeen: false,
            stepFunFailed: false,
            appleSpeechFailed: false,
            submissionEmitted: false,
            pendingStepFunFinalText: nil,
            pendingAppleFinalText: nil
        )
        return effects
    }

    mutating func reduce(_ event: BuddyHybridTranscriptionEvent) -> [BuddyHybridTranscriptionEffect] {
        guard let activeToken = snapshot.token else {
            return [.drop(token: event.token, sequence: event.sequence, reason: .noActiveSession)]
        }
        guard event.token == activeToken else {
            return [.drop(token: event.token, sequence: event.sequence, reason: .tokenMismatch)]
        }
        guard event.sequence > snapshot.lastSequence else {
            return [.drop(token: event.token, sequence: event.sequence, reason: .staleSequence)]
        }

        switch snapshot.phase {
        case .idle:
            return [.drop(token: event.token, sequence: event.sequence, reason: .noActiveSession)]
        case .completed, .cancelled:
            return [.drop(token: event.token, sequence: event.sequence, reason: .terminal)]
        case .capturing, .finalizing:
            snapshot = snapshotWith(lastSequence: event.sequence)
        }

        switch event {
        case let .partial(token, sequence, text):
            guard snapshot.phase == .capturing, !snapshot.releaseSeen else {
                return [.drop(token: token, sequence: sequence, reason: .afterRelease)]
            }
            let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedText.isEmpty else {
                return [.drop(token: token, sequence: sequence, reason: .emptyFinal)]
            }
            return [.updatePartial(token: token, sequence: sequence, text: trimmedText)]

        case let .final(token, sequence, source, text):
            guard snapshot.phase == .capturing || snapshot.phase == .finalizing else {
                return [.drop(token: token, sequence: sequence, reason: .terminal)]
            }
            let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedText.isEmpty else {
                return [.drop(token: token, sequence: sequence, reason: .emptyFinal)]
            }

            switch source {
            case .stepFunAuthoritative:
                guard !snapshot.stepFunFailed else {
                    return [.drop(token: token, sequence: sequence, reason: .sourceUnavailable)]
                }
                guard snapshot.releaseSeen else {
                    snapshot = snapshotWith(pendingStepFunFinalText: trimmedText)
                    return []
                }
                return submit(
                    token: token,
                    sequence: sequence,
                    source: .stepFunAuthoritative,
                    text: trimmedText
                )
            case .appleSpeechShadow, .appleSpeechFallback:
                guard !snapshot.appleSpeechFailed else {
                    return [.drop(token: token, sequence: sequence, reason: .sourceUnavailable)]
                }
                if snapshot.releaseSeen, snapshot.stepFunFailed {
                    return submit(
                        token: token,
                        sequence: sequence,
                        source: .appleSpeechFallback,
                        text: trimmedText
                    )
                }
                snapshot = snapshotWith(pendingAppleFinalText: trimmedText)
                return []
            case .legacyBuffered:
                guard snapshot.releaseSeen else {
                    return [.drop(token: token, sequence: sequence, reason: .afterRelease)]
                }
                return submit(
                    token: token,
                    sequence: sequence,
                    source: .legacyBuffered,
                    text: trimmedText
                )
            }

        case let .release(token, sequence):
            guard snapshot.phase == .capturing || snapshot.phase == .finalizing else {
                return [.drop(token: token, sequence: sequence, reason: .terminal)]
            }
            guard !snapshot.releaseSeen else {
                return [.drop(token: token, sequence: sequence, reason: .duplicateRelease)]
            }
            if let stepFunFinal = snapshot.pendingStepFunFinalText,
               !stepFunFinal.isEmpty {
                return submit(
                    token: token,
                    sequence: sequence,
                    source: .stepFunAuthoritative,
                    text: stepFunFinal
                )
            }
            if snapshot.stepFunFailed,
               let appleFinal = snapshot.pendingAppleFinalText,
               !appleFinal.isEmpty {
                return submit(
                    token: token,
                    sequence: sequence,
                    source: .appleSpeechFallback,
                    text: appleFinal
                )
            }
            snapshot = snapshotWith(
                phase: .finalizing,
                releaseSeen: true
            )
            return [.armFinalTimeout(token: token)]

        case let .failure(token, sequence, source):
            switch source {
            case .stepFunAuthoritative:
                guard !snapshot.stepFunFailed else {
                    return [.drop(token: token, sequence: sequence, reason: .sourceUnavailable)]
                }
                snapshot = snapshotWith(stepFunFailed: true)
                var effects: [BuddyHybridTranscriptionEffect] = [
                    .cancelStepFun(token: token)
                ]
                if snapshot.releaseSeen,
                   let appleFinal = snapshot.pendingAppleFinalText,
                   !appleFinal.isEmpty {
                    effects.append(contentsOf: submit(
                        token: token,
                        sequence: sequence,
                        source: .appleSpeechFallback,
                        text: appleFinal
                    ))
                }
                return effects
            case .appleSpeechShadow, .appleSpeechFallback:
                guard !snapshot.appleSpeechFailed else {
                    return [.drop(token: token, sequence: sequence, reason: .sourceUnavailable)]
                }
                snapshot = snapshotWith(appleSpeechFailed: true)
                return [.cancelAppleSpeech(token: token)]
            case .legacyBuffered:
                return [.drop(token: token, sequence: sequence, reason: .sourceUnavailable)]
            }

        case let .timeout(token, sequence):
            guard snapshot.phase == .finalizing, snapshot.releaseSeen else {
                return [.drop(token: token, sequence: sequence, reason: .terminal)]
            }
            if let appleFinal = snapshot.pendingAppleFinalText,
               !appleFinal.isEmpty {
                return submit(
                    token: token,
                    sequence: sequence,
                    source: .appleSpeechFallback,
                    text: appleFinal
                )
            }
            snapshot = snapshotWith(phase: .completed)
            return [
                .cancelStepFun(token: token),
                .startLegacyBufferedFallback(token: token)
            ]

        case let .cancel(token, _):
            snapshot = snapshotWith(
                phase: .cancelled,
                submissionEmitted: false
            )
            return [.cancelAll(token: token)]
        }
    }

    private mutating func submit(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        source: BuddyHybridTranscriptionSource,
        text: String
    ) -> [BuddyHybridTranscriptionEffect] {
        // The caller can safely apply this effect once; the reducer is already
        // terminal and rejects all subsequent callbacks from either provider.
        snapshotWith(
            phase: .completed,
            releaseSeen: true,
            submissionEmitted: true
        )
        return [.submitFinal(token: token, sequence: sequence, source: source, text: text)]
    }

    @discardableResult
    private mutating func snapshotWith(
        phase: BuddyHybridTranscriptionPhase? = nil,
        lastSequence: UInt64? = nil,
        releaseSeen: Bool? = nil,
        stepFunFailed: Bool? = nil,
        appleSpeechFailed: Bool? = nil,
        submissionEmitted: Bool? = nil,
        pendingStepFunFinalText: String?? = nil,
        pendingAppleFinalText: String?? = nil
    ) -> BuddyHybridTranscriptionStateSnapshot {
        let next = BuddyHybridTranscriptionStateSnapshot(
            phase: phase ?? snapshot.phase,
            token: snapshot.token,
            lastSequence: lastSequence ?? snapshot.lastSequence,
            releaseSeen: releaseSeen ?? snapshot.releaseSeen,
            stepFunFailed: stepFunFailed ?? snapshot.stepFunFailed,
            appleSpeechFailed: appleSpeechFailed ?? snapshot.appleSpeechFailed,
            submissionEmitted: submissionEmitted ?? snapshot.submissionEmitted,
            pendingStepFunFinalText: pendingStepFunFinalText.flatMap { $0 } ?? snapshot.pendingStepFunFinalText,
            pendingAppleFinalText: pendingAppleFinalText.flatMap { $0 } ?? snapshot.pendingAppleFinalText
        )
        snapshot = next
        return next
    }
}

private extension BuddyHybridTranscriptionEvent {
    var token: BuddyTranscriptionSessionToken {
        switch self {
        case let .partial(token, _, _),
             let .final(token, _, _, _),
             let .release(token, _),
             let .failure(token, _, _),
             let .timeout(token, _),
             let .cancel(token, _):
            return token
        }
    }

    var sequence: UInt64 {
        switch self {
        case let .partial(_, sequence, _),
             let .final(_, sequence, _, _),
             let .release(_, sequence),
             let .failure(_, sequence, _),
             let .timeout(_, sequence),
             let .cancel(_, sequence):
            return sequence
        }
    }
}
