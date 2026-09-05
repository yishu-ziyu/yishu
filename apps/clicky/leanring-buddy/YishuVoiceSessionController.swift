import Combine
import Foundation

/// Identity for one keyboard PTT capture. The trace ID is created on press;
/// `releaseAt` is filled on release and the origin is consumed exactly once
/// when a terminal capture event is emitted.
struct VoiceTurnOrigin: Equatable {
    let traceID: String
    let releaseAt: UInt64?
}

enum YishuVoiceCaptureFailureReason: Equatable, Sendable {
    case emptyOrNearSilence
}

/// Typed capture-boundary events. Product layers react; this type does not
/// own runtime turns, TTS, overlays, or screen capture.
enum YishuVoiceSessionEvent: Equatable {
    case pressed(traceID: String)
    case partial(traceID: String, text: String)
    case released(origin: VoiceTurnOrigin)
    case finalized(origin: VoiceTurnOrigin, transcript: String)
    case captureFailed(traceID: String, reason: YishuVoiceCaptureFailureReason)
    case cancelled(traceID: String)
}

@MainActor
protocol YishuKeyboardDictationControlling: AnyObject {
    var isDictationInProgress: Bool { get }
    func startPushToTalkFromKeyboardShortcut(
        currentDraftText: String,
        updateDraftText: @escaping (String) -> Void,
        submitDraftText: @escaping (String) -> Void
    ) async
    func stopPushToTalkFromKeyboardShortcut()
    func cancelCurrentDictation(preserveDraftText: Bool)
}

protocol YishuPushToTalkShortcutMonitoring: AnyObject {
    var shortcutTransitionPublisher: PassthroughSubject<
        BuddyPushToTalkShortcut.ShortcutTransition,
        Never
    > { get }
    func start()
    func stop()
}

extension BuddyDictationManager: YishuKeyboardDictationControlling {}
extension GlobalPushToTalkShortcutMonitor: YishuPushToTalkShortcutMonitoring {}

/// Owns keyboard PTT + dictation session lifecycle. CompanionManager consumes
/// `YishuVoiceSessionEvent` and keeps runtime / presentation / barge-in.
@MainActor
final class YishuVoiceSessionController: ObservableObject {
    let dictationManager: BuddyDictationManager?

    @Published private(set) var isKeyHeld = false

    var shouldBegin: () -> Bool
    var onEvent: (YishuVoiceSessionEvent) -> Void

    private let dictation: any YishuKeyboardDictationControlling
    private let monitor: any YishuPushToTalkShortcutMonitoring
    private var shortcutTransitionCancellable: AnyCancellable?
    private var pendingStartTask: Task<Void, Never>?
    private var pendingOrigin: VoiceTurnOrigin?
    private var sessionGeneration: UInt64 = 0
    private var didEmitTerminalForGeneration = false

    convenience init(
        shouldBegin: @escaping () -> Bool = { true },
        onEvent: @escaping (YishuVoiceSessionEvent) -> Void = { _ in }
    ) {
        self.init(
            dictationManager: BuddyDictationManager(),
            monitor: GlobalPushToTalkShortcutMonitor(),
            shouldBegin: shouldBegin,
            onEvent: onEvent
        )
    }

    init(
        dictationManager: BuddyDictationManager,
        monitor: GlobalPushToTalkShortcutMonitor,
        shouldBegin: @escaping () -> Bool = { true },
        onEvent: @escaping (YishuVoiceSessionEvent) -> Void = { _ in }
    ) {
        self.dictationManager = dictationManager
        self.dictation = dictationManager
        self.monitor = monitor
        self.shouldBegin = shouldBegin
        self.onEvent = onEvent
    }

    init(
        dictation: any YishuKeyboardDictationControlling,
        monitor: any YishuPushToTalkShortcutMonitoring,
        shouldBegin: @escaping () -> Bool = { true },
        onEvent: @escaping (YishuVoiceSessionEvent) -> Void = { _ in }
    ) {
        self.dictationManager = dictation as? BuddyDictationManager
        self.dictation = dictation
        self.monitor = monitor
        self.shouldBegin = shouldBegin
        self.onEvent = onEvent
    }

    func start() {
        guard shortcutTransitionCancellable == nil else { return }
        shortcutTransitionCancellable = monitor.shortcutTransitionPublisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] transition in
                self?.handleShortcutTransition(transition)
            }
    }

    func stop() {
        cancelCapture()
        monitor.stop()
        shortcutTransitionCancellable?.cancel()
        shortcutTransitionCancellable = nil
    }

    func setShortcutMonitorEnabled(_ enabled: Bool) {
        if enabled {
            monitor.start()
        } else {
            monitor.stop()
        }
    }

    func cancelCapture() {
        pendingStartTask?.cancel()
        pendingStartTask = nil
        dictation.cancelCurrentDictation(preserveDraftText: true)
        isKeyHeld = false
        didEmitTerminalForGeneration = true
        sessionGeneration &+= 1
        let traceID = pendingOrigin?.traceID
        pendingOrigin = nil
        if let traceID {
            onEvent(.cancelled(traceID: traceID))
        }
    }

    func handleShortcutTransition(_ transition: BuddyPushToTalkShortcut.ShortcutTransition) {
        switch transition {
        case .pressed:
            beginCaptureIfPossible()
        case .released:
            releaseCapture()
        case .none:
            break
        }
    }

    private func beginCaptureIfPossible() {
        guard shouldBegin() else { return }
        guard !dictation.isDictationInProgress else { return }

        sessionGeneration &+= 1
        let generation = sessionGeneration
        let traceID = Self.newVoiceTurnTraceID()
        pendingOrigin = VoiceTurnOrigin(traceID: traceID, releaseAt: nil)
        didEmitTerminalForGeneration = false
        isKeyHeld = true
        onEvent(.pressed(traceID: traceID))

        pendingStartTask?.cancel()
        pendingStartTask = Task { [weak self] in
            await self?.dictation.startPushToTalkFromKeyboardShortcut(
                currentDraftText: "",
                updateDraftText: { [weak self] partialText in
                    self?.handlePartial(
                        generation: generation,
                        traceID: traceID,
                        text: partialText
                    )
                },
                submitDraftText: { [weak self] finalTranscript in
                    self?.handleFinal(
                        generation: generation,
                        traceID: traceID,
                        text: finalTranscript
                    )
                }
            )
        }
    }

    private func releaseCapture() {
        let releaseAt = DispatchTime.now().uptimeNanoseconds
        if let origin = pendingOrigin {
            pendingOrigin = VoiceTurnOrigin(
                traceID: origin.traceID,
                releaseAt: releaseAt
            )
        }
        let releasedOrigin = pendingOrigin
        pendingStartTask?.cancel()
        pendingStartTask = nil
        dictation.stopPushToTalkFromKeyboardShortcut()
        isKeyHeld = false
        onEvent(
            .released(
                origin: releasedOrigin
                    ?? VoiceTurnOrigin(traceID: "unknown", releaseAt: releaseAt)
            )
        )
    }

    private func handlePartial(generation: UInt64, traceID: String, text: String) {
        guard generation == sessionGeneration else { return }
        guard !didEmitTerminalForGeneration else { return }
        onEvent(.partial(traceID: traceID, text: text))
    }

    private func handleFinal(generation: UInt64, traceID: String, text: String) {
        guard generation == sessionGeneration else { return }
        guard !didEmitTerminalForGeneration else { return }
        didEmitTerminalForGeneration = true
        let origin = consumeOrigin(for: traceID)
            ?? VoiceTurnOrigin(traceID: traceID, releaseAt: nil)
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            onEvent(
                .captureFailed(
                    traceID: traceID,
                    reason: .emptyOrNearSilence
                )
            )
            return
        }
        onEvent(.finalized(origin: origin, transcript: trimmed))
    }

    private func consumeOrigin(for traceID: String) -> VoiceTurnOrigin? {
        guard let origin = pendingOrigin, origin.traceID == traceID else {
            return nil
        }
        pendingOrigin = nil
        return origin
    }

    private static func newVoiceTurnTraceID() -> String {
        let compactUUID = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        return String(compactUUID.prefix(12)).lowercased()
    }
}
