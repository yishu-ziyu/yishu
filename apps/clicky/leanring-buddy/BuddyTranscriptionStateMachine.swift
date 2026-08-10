//
//  BuddyTranscriptionStateMachine.swift
//  leanring-buddy
//
//  Pure lifecycle reducer for streaming dictation. It deliberately has no
//  audio, URLSession, actor, clock, or UI dependency. Those concerns consume
//  the effects emitted by this value type on their own queues.
//

import Foundation

struct BuddyTranscriptionSessionToken: Equatable, Hashable, Sendable {
    let token: UInt64
    let generation: UInt64
}

enum BuddyTranscriptionPhase: Equatable, Sendable {
    case idle
    case capturing
    case finalizing
    case fallingBack
    case completed
    case cancelled
}

enum BuddyTranscriptionFailure: String, Equatable, Sendable {
    case transport
    case connectTimeout
    case finalTimeout
    case audioRetentionOverflow
    case fallbackUnavailable
}

enum BuddyTranscriptionTimeoutPhase: String, Equatable, Sendable {
    case connect
    case final
}

enum BuddyTranscriptionCancelReason: String, Equatable, Sendable {
    case userCancelled
    case superseded
    case providerStopped
}

enum BuddyTranscriptionDropReason: String, Equatable, Sendable {
    case noActiveSession
    case tokenMismatch
    case staleSequence
    case afterRelease
    case duplicateRelease
    case afterFallback
    case terminal
    case emptyFinal
}

enum BuddyTranscriptionEvent: Equatable, Sendable {
    case partial(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        text: String
    )
    case release(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64
    )
    case final(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        text: String
    )
    case fallbackFinal(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        text: String
    )
    case failure(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        reason: BuddyTranscriptionFailure
    )
    case timeout(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        phase: BuddyTranscriptionTimeoutPhase,
        fallbackText: String? = nil
    )
    case cancel(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        reason: BuddyTranscriptionCancelReason
    )
}

enum BuddyTranscriptionEffect: Equatable, Sendable {
    case updatePartial(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        text: String
    )
    case submitFinal(
        token: BuddyTranscriptionSessionToken,
        sequence: UInt64,
        text: String
    )
    case armFinalTimeout(token: BuddyTranscriptionSessionToken)
    case startBufferedFallback(token: BuddyTranscriptionSessionToken)
    case cancelTransport(token: BuddyTranscriptionSessionToken)
    case drop(
        token: BuddyTranscriptionSessionToken?,
        sequence: UInt64?,
        reason: BuddyTranscriptionDropReason
    )
}

private extension BuddyTranscriptionEvent {
    var token: BuddyTranscriptionSessionToken {
        switch self {
        case let .partial(token, _, _),
             let .release(token, _),
             let .final(token, _, _),
             let .fallbackFinal(token, _, _),
             let .failure(token, _, _),
             let .timeout(token, _, _, _),
             let .cancel(token, _, _):
            return token
        }
    }

    var sequence: UInt64 {
        switch self {
        case let .partial(_, sequence, _),
             let .release(_, sequence),
             let .final(_, sequence, _),
             let .fallbackFinal(_, sequence, _),
             let .failure(_, sequence, _),
             let .timeout(_, sequence, _, _),
             let .cancel(_, sequence, _):
            return sequence
        }
    }
}

struct BuddyTranscriptionStateSnapshot: Equatable, Sendable {
    let phase: BuddyTranscriptionPhase
    let token: BuddyTranscriptionSessionToken?
    let lastSequence: UInt64
    let releaseSeen: Bool
    let finalSeen: Bool
    let fallbackRequired: Bool
    let submissionEmitted: Bool
    let pendingFinalText: String?
}

struct BuddyTranscriptionStateMachine: Sendable {
    private(set) var snapshot = BuddyTranscriptionStateSnapshot(
        phase: .idle,
        token: nil,
        lastSequence: 0,
        releaseSeen: false,
        finalSeen: false,
        fallbackRequired: false,
        submissionEmitted: false,
        pendingFinalText: nil
    )

    /// Starts or supersedes a session. A new generation/token makes every
    /// event from an older transport unambiguously stale.
    mutating func start(token: BuddyTranscriptionSessionToken) -> [BuddyTranscriptionEffect] {
        var effects: [BuddyTranscriptionEffect] = []
        if let oldToken = snapshot.token,
           snapshot.phase != .idle,
           snapshot.phase != .completed,
           snapshot.phase != .cancelled {
            effects.append(.cancelTransport(token: oldToken))
        }

        snapshot = BuddyTranscriptionStateSnapshot(
            phase: .capturing,
            token: token,
            lastSequence: 0,
            releaseSeen: false,
            finalSeen: false,
            fallbackRequired: false,
            submissionEmitted: false,
            pendingFinalText: nil
        )
        return effects
    }

    mutating func reduce(_ event: BuddyTranscriptionEvent) -> [BuddyTranscriptionEffect] {
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
        case .capturing, .finalizing, .fallingBack:
            snapshot = BuddyTranscriptionStateSnapshot(
                phase: snapshot.phase,
                token: snapshot.token,
                lastSequence: event.sequence,
                releaseSeen: snapshot.releaseSeen,
                finalSeen: snapshot.finalSeen,
                fallbackRequired: snapshot.fallbackRequired,
                submissionEmitted: snapshot.submissionEmitted,
                pendingFinalText: snapshot.pendingFinalText
            )
        }

        switch event {
        case let .partial(token, sequence, text):
            guard snapshot.phase == .capturing,
                  !snapshot.releaseSeen,
                  !snapshot.fallbackRequired else {
                return [.drop(token: token, sequence: sequence, reason: snapshot.phase == .fallingBack ? .afterFallback : .afterRelease)]
            }
            let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedText.isEmpty else {
                return [.drop(token: token, sequence: sequence, reason: .emptyFinal)]
            }
            return [.updatePartial(token: token, sequence: sequence, text: trimmedText)]

        case let .release(token, sequence):
            guard snapshot.phase == .capturing || snapshot.phase == .finalizing else {
                return [.drop(token: token, sequence: sequence, reason: snapshot.phase == .fallingBack ? .afterFallback : .terminal)]
            }
            guard !snapshot.releaseSeen else {
                return [.drop(token: token, sequence: sequence, reason: .duplicateRelease)]
            }

            let finalText = snapshot.pendingFinalText?.trimmingCharacters(in: .whitespacesAndNewlines)
            let hasFinalText = !(finalText?.isEmpty ?? true)
            if hasFinalText, let finalText {
                snapshot = updatedSnapshot(
                    phase: .completed,
                    releaseSeen: true,
                    finalSeen: true,
                    fallbackRequired: snapshot.fallbackRequired,
                    submissionEmitted: true,
                    pendingFinalText: finalText
                )
                return [.submitFinal(token: token, sequence: sequence, text: finalText)]
            }

            if snapshot.fallbackRequired {
                snapshot = updatedSnapshot(
                    phase: .fallingBack,
                    releaseSeen: true,
                    finalSeen: snapshot.finalSeen,
                    fallbackRequired: true,
                    submissionEmitted: false,
                    pendingFinalText: snapshot.pendingFinalText
                )
                return [
                    .cancelTransport(token: token),
                    .startBufferedFallback(token: token),
                ]
            }

            snapshot = updatedSnapshot(
                phase: .finalizing,
                releaseSeen: true,
                finalSeen: snapshot.finalSeen,
                fallbackRequired: false,
                submissionEmitted: false,
                pendingFinalText: snapshot.pendingFinalText
            )
            return [.armFinalTimeout(token: token)]

        case let .final(token, sequence, text):
            guard snapshot.phase == .capturing || snapshot.phase == .finalizing else {
                return [.drop(token: token, sequence: sequence, reason: snapshot.phase == .fallingBack ? .afterFallback : .terminal)]
            }
            guard !snapshot.fallbackRequired else {
                return [.drop(token: token, sequence: sequence, reason: .afterFallback)]
            }
            let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedText.isEmpty else {
                return [.drop(token: token, sequence: sequence, reason: .emptyFinal)]
            }

            if snapshot.releaseSeen {
                snapshot = updatedSnapshot(
                    phase: .completed,
                    releaseSeen: true,
                    finalSeen: true,
                    fallbackRequired: false,
                    submissionEmitted: true,
                    pendingFinalText: trimmedText
                )
                return [.submitFinal(token: token, sequence: sequence, text: trimmedText)]
            }

            snapshot = updatedSnapshot(
                phase: .capturing,
                releaseSeen: false,
                finalSeen: true,
                fallbackRequired: snapshot.fallbackRequired,
                submissionEmitted: false,
                pendingFinalText: trimmedText
            )
            return []

        case let .fallbackFinal(token, sequence, text):
            guard snapshot.phase == .fallingBack, snapshot.releaseSeen else {
                return [.drop(token: token, sequence: sequence, reason: .afterFallback)]
            }
            let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedText.isEmpty else {
                snapshot = updatedSnapshot(
                    phase: .completed,
                    releaseSeen: true,
                    finalSeen: true,
                    fallbackRequired: true,
                    submissionEmitted: false,
                    pendingFinalText: nil
                )
                return [.drop(token: token, sequence: sequence, reason: .emptyFinal)]
            }
            snapshot = updatedSnapshot(
                phase: .completed,
                releaseSeen: true,
                finalSeen: true,
                fallbackRequired: true,
                submissionEmitted: true,
                pendingFinalText: trimmedText
            )
            return [.submitFinal(token: token, sequence: sequence, text: trimmedText)]

        case let .failure(token, sequence, _):
            guard snapshot.phase == .capturing || snapshot.phase == .finalizing else {
                return [.drop(token: token, sequence: sequence, reason: snapshot.phase == .fallingBack ? .afterFallback : .terminal)]
            }
            if snapshot.releaseSeen {
                snapshot = updatedSnapshot(
                    phase: .fallingBack,
                    releaseSeen: true,
                    finalSeen: snapshot.finalSeen,
                    fallbackRequired: true,
                    submissionEmitted: false,
                    pendingFinalText: snapshot.pendingFinalText
                )
                return [
                    .cancelTransport(token: token),
                    .startBufferedFallback(token: token),
                ]
            }
            snapshot = updatedSnapshot(
                phase: snapshot.phase,
                releaseSeen: false,
                finalSeen: snapshot.finalSeen,
                fallbackRequired: true,
                submissionEmitted: false,
                pendingFinalText: snapshot.pendingFinalText
            )
            return [.cancelTransport(token: token)]

        case let .timeout(token, sequence, phase, fallbackText):
            guard phase == .final else {
                guard snapshot.phase == .capturing else {
                    return [.drop(token: token, sequence: sequence, reason: .terminal)]
                }
                snapshot = updatedSnapshot(
                    phase: .capturing,
                    releaseSeen: false,
                    finalSeen: snapshot.finalSeen,
                    fallbackRequired: true,
                    submissionEmitted: false,
                    pendingFinalText: snapshot.pendingFinalText
                )
                return [.cancelTransport(token: token)]
            }

            guard snapshot.phase == .finalizing, snapshot.releaseSeen else {
                return [.drop(token: token, sequence: sequence, reason: .terminal)]
            }

            let trimmedFallbackText = fallbackText?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let trimmedFallbackText, !trimmedFallbackText.isEmpty {
                snapshot = updatedSnapshot(
                    phase: .completed,
                    releaseSeen: true,
                    finalSeen: true,
                    fallbackRequired: true,
                    submissionEmitted: true,
                    pendingFinalText: trimmedFallbackText
                )
                return [.submitFinal(token: token, sequence: sequence, text: trimmedFallbackText)]
            }

            snapshot = updatedSnapshot(
                phase: .fallingBack,
                releaseSeen: true,
                finalSeen: snapshot.finalSeen,
                fallbackRequired: true,
                submissionEmitted: false,
                pendingFinalText: snapshot.pendingFinalText
            )
            return [
                .cancelTransport(token: token),
                .startBufferedFallback(token: token),
            ]

        case let .cancel(token, sequence, _):
            guard snapshot.phase != .completed, snapshot.phase != .cancelled else {
                return [.drop(token: token, sequence: sequence, reason: .terminal)]
            }
            snapshot = updatedSnapshot(
                phase: .cancelled,
                releaseSeen: snapshot.releaseSeen,
                finalSeen: snapshot.finalSeen,
                fallbackRequired: snapshot.fallbackRequired,
                submissionEmitted: false,
                pendingFinalText: snapshot.pendingFinalText
            )
            return [.cancelTransport(token: token)]
        }
    }

    private func updatedSnapshot(
        phase: BuddyTranscriptionPhase,
        releaseSeen: Bool,
        finalSeen: Bool,
        fallbackRequired: Bool,
        submissionEmitted: Bool,
        pendingFinalText: String?
    ) -> BuddyTranscriptionStateSnapshot {
        BuddyTranscriptionStateSnapshot(
            phase: phase,
            token: snapshot.token,
            lastSequence: snapshot.lastSequence,
            releaseSeen: releaseSeen,
            finalSeen: finalSeen,
            fallbackRequired: fallbackRequired,
            submissionEmitted: submissionEmitted,
            pendingFinalText: pendingFinalText
        )
    }
}
