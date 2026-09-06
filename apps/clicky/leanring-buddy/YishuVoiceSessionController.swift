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

/// Read-only capture activity for product voiceState mapping.
/// Priority matches the former dictation-flag observation:
/// finalizing > recording > (preparing || key held) > continuous armed > idle.
enum YishuVoiceCapturePhase: Equatable, Sendable {
    case idle
    case holding
    case armed
    case recording
    case finalizing

    static func projected(
        isFinalizing: Bool,
        isRecording: Bool,
        isPreparing: Bool,
        isKeyHeld: Bool,
        isContinuousArmed: Bool = false
    ) -> YishuVoiceCapturePhase {
        if isFinalizing { return .finalizing }
        if isRecording { return .recording }
        if isPreparing || isKeyHeld { return .holding }
        if isContinuousArmed { return .armed }
        return .idle
    }
}

/// Typed capture-boundary events. Product layers react; this type does not
/// own runtime turns, TTS, overlays, or screen capture.
enum YishuVoiceSessionEvent: Equatable {
    case pressed(traceID: String)
    case speechOnset(traceID: String)
    case partial(traceID: String, text: String)
    case released(origin: VoiceTurnOrigin)
    case finalized(origin: VoiceTurnOrigin, transcript: String)
    case captureFailed(traceID: String, reason: YishuVoiceCaptureFailureReason)
    case cancelled(traceID: String)
}

@MainActor
protocol YishuKeyboardDictationControlling: AnyObject {
    var isDictationInProgress: Bool { get }
    var isPreparingToRecord: Bool { get }
    var isRecordingFromKeyboardShortcut: Bool { get }
    var isFinalizingTranscript: Bool { get }
    func startPushToTalkFromKeyboardShortcut(
        currentDraftText: String,
        updateDraftText: @escaping (String) -> Void,
        submitDraftText: @escaping (String) -> Void
    ) async
    func stopPushToTalkFromKeyboardShortcut()
    func cancelCurrentDictation(preserveDraftText: Bool)
}

@MainActor
protocol YishuContinuousDictationControlling: AnyObject {
    var isContinuousCaptureActive: Bool { get }
    func startContinuousCapture(
        onPartial: @escaping (String) -> Void,
        onFinal: @escaping (String) -> Void,
        onPower: @escaping (CGFloat) -> Void
    ) async
    func beginContinuousUtterance() async
    func requestContinuousUtteranceFinal()
    func stopContinuousCapture()
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
extension BuddyDictationManager: YishuContinuousDictationControlling {}

extension GlobalPushToTalkShortcutMonitor: YishuPushToTalkShortcutMonitoring {}

/// Owns keyboard PTT + dictation session lifecycle. CompanionManager consumes
/// `YishuVoiceSessionEvent` and `capturePhase`; it does not see the dictation
/// manager.
@MainActor
final class YishuVoiceSessionController: ObservableObject {
    @Published private(set) var isKeyHeld = false {
        didSet { refreshCapturePhase() }
    }
    @Published private(set) var capturePhase: YishuVoiceCapturePhase = .idle
    @Published private(set) var isContinuousListeningEnabled = false

    var shouldBegin: () -> Bool
    var onEvent: (YishuVoiceSessionEvent) -> Void

    private let dictation: any YishuKeyboardDictationControlling
    private let continuousDictation: (any YishuContinuousDictationControlling)?
    private let monitor: any YishuPushToTalkShortcutMonitoring
    private let clock: any YishuMonotonicClock
    private var shortcutTransitionCancellable: AnyCancellable?
    private var pendingStartTask: Task<Void, Never>?
    private var pendingOrigin: VoiceTurnOrigin?
    private var sessionGeneration: UInt64 = 0
    private var didEmitTerminalForGeneration = false
    private var continuousPhase: YishuHandsFreeListeningPolicy.Phase = .armed
    private var assistantPlaybackActive = false
    private var lastLoudAtMs: Int?
    private var utteranceStartedAtMs: Int?
    private var continuousStartTask: Task<Void, Never>?

    convenience init(
        shouldBegin: @escaping () -> Bool = { true },
        onEvent: @escaping (YishuVoiceSessionEvent) -> Void = { _ in }
    ) {
        let dictation = BuddyDictationManager()
        self.init(
            dictation: dictation,
            monitor: GlobalPushToTalkShortcutMonitor(),
            shouldBegin: shouldBegin,
            onEvent: onEvent,
            continuousDictation: dictation
        )
    }

    init(
        dictation: any YishuKeyboardDictationControlling,
        monitor: any YishuPushToTalkShortcutMonitoring,
        shouldBegin: @escaping () -> Bool = { true },
        onEvent: @escaping (YishuVoiceSessionEvent) -> Void = { _ in },
        continuousDictation: (any YishuContinuousDictationControlling)? = nil,
        clock: any YishuMonotonicClock = YishuSystemMonotonicClock()
    ) {
        self.dictation = dictation
        self.continuousDictation = continuousDictation
        self.monitor = monitor
        self.clock = clock
        self.shouldBegin = shouldBegin
        self.onEvent = onEvent
        refreshCapturePhase()
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
        if isContinuousListeningEnabled {
            setContinuousListeningEnabled(false)
        }
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

    func setContinuousListeningEnabled(_ enabled: Bool) {
        guard enabled != isContinuousListeningEnabled else { return }
        isContinuousListeningEnabled = enabled
        if enabled {
            armContinuousListening()
        } else {
            disarmContinuousListening()
        }
        refreshCapturePhase()
    }

    func setAssistantPlaybackActive(_ active: Bool) {
        assistantPlaybackActive = active
    }

    func handleAudioPower(_ power: CGFloat) {
        guard isContinuousListeningEnabled else { return }
        guard continuousDictation != nil else { return }
        let now = clock.milliseconds()
        if YishuHandsFreeListeningPolicy.isHoldSpeech(power: power)
            || YishuHandsFreeListeningPolicy.isUserSpeech(
                power: power,
                assistantPlaybackActive: assistantPlaybackActive
            ) {
            lastLoudAtMs = now
        }
        let millisecondsSinceLoud = lastLoudAtMs.map { now - $0 } ?? Int.max
        let utteranceDurationMs = utteranceStartedAtMs.map { now - $0 } ?? 0
        let decision = YishuHandsFreeListeningPolicy.decision(
            phase: continuousPhase,
            power: power,
            assistantPlaybackActive: assistantPlaybackActive,
            millisecondsSinceLoud: millisecondsSinceLoud,
            utteranceDurationMs: utteranceDurationMs
        )
        switch decision {
        case .none:
            break
        case .beginUtterance:
            beginContinuousUtterance()
        case .endUtterance:
            endContinuousUtterance()
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
        refreshCapturePhase()
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

    private func refreshCapturePhase() {
        let continuousArmed = isContinuousListeningEnabled
            && continuousPhase == .armed
            && !isKeyHeld
        let next = YishuVoiceCapturePhase.projected(
            isFinalizing: dictation.isFinalizingTranscript || continuousPhase == .finalizing,
            isRecording: dictation.isRecordingFromKeyboardShortcut
                || continuousPhase == .inUtterance,
            isPreparing: dictation.isPreparingToRecord,
            isKeyHeld: isKeyHeld,
            isContinuousArmed: continuousArmed
        )
        if capturePhase != next {
            capturePhase = next
        }
    }

    private func beginCaptureIfPossible() {
        guard shouldBegin() else { return }
        guard !isContinuousListeningEnabled else { return }
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
            self?.refreshCapturePhase()
        }
    }

    private func releaseCapture() {
        guard !isContinuousListeningEnabled else { return }
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
        refreshCapturePhase()
        onEvent(
            .released(
                origin: releasedOrigin
                    ?? VoiceTurnOrigin(traceID: "unknown", releaseAt: releaseAt)
            )
        )
    }

    private func armContinuousListening() {
        guard let continuousDictation else { return }
        continuousPhase = .armed
        lastLoudAtMs = nil
        utteranceStartedAtMs = nil
        didEmitTerminalForGeneration = true
        pendingOrigin = nil
        continuousStartTask?.cancel()
        continuousStartTask = Task { [weak self] in
            await continuousDictation.startContinuousCapture(
                onPartial: { [weak self] text in
                    self?.handleContinuousPartial(text)
                },
                onFinal: { [weak self] text in
                    self?.handleContinuousFinal(text)
                },
                onPower: { [weak self] power in
                    self?.handleAudioPower(power)
                }
            )
            self?.refreshCapturePhase()
        }
        refreshCapturePhase()
    }

    private func disarmContinuousListening() {
        continuousStartTask?.cancel()
        continuousStartTask = nil
        continuousDictation?.stopContinuousCapture()
        continuousPhase = .armed
        lastLoudAtMs = nil
        utteranceStartedAtMs = nil
        didEmitTerminalForGeneration = true
        sessionGeneration &+= 1
        let traceID = pendingOrigin?.traceID
        pendingOrigin = nil
        if let traceID {
            onEvent(.cancelled(traceID: traceID))
        }
    }

    private func beginContinuousUtterance() {
        guard isContinuousListeningEnabled else { return }
        guard continuousPhase == .armed else { return }
        guard let continuousDictation else { return }

        sessionGeneration &+= 1
        let generation = sessionGeneration
        let traceID = Self.newVoiceTurnTraceID()
        pendingOrigin = VoiceTurnOrigin(traceID: traceID, releaseAt: nil)
        didEmitTerminalForGeneration = false
        continuousPhase = .inUtterance
        utteranceStartedAtMs = clock.milliseconds()
        lastLoudAtMs = utteranceStartedAtMs
        onEvent(.speechOnset(traceID: traceID))
        refreshCapturePhase()

        pendingStartTask?.cancel()
        pendingStartTask = Task { [weak self] in
            await continuousDictation.beginContinuousUtterance()
            guard let self, self.sessionGeneration == generation else { return }
            self.refreshCapturePhase()
        }
    }

    private func endContinuousUtterance() {
        guard isContinuousListeningEnabled else { return }
        guard continuousPhase == .inUtterance else { return }
        continuousPhase = .finalizing
        let releaseAt = DispatchTime.now().uptimeNanoseconds
        if let origin = pendingOrigin {
            pendingOrigin = VoiceTurnOrigin(
                traceID: origin.traceID,
                releaseAt: releaseAt
            )
        }
        continuousDictation?.requestContinuousUtteranceFinal()
        refreshCapturePhase()
        if let origin = pendingOrigin {
            onEvent(.released(origin: origin))
        }
    }

    private func handleContinuousPartial(_ text: String) {
        guard let origin = pendingOrigin else { return }
        handlePartial(
            generation: sessionGeneration,
            traceID: origin.traceID,
            text: text
        )
    }

    private func handleContinuousFinal(_ text: String) {
        guard let origin = pendingOrigin else { return }
        handleFinal(
            generation: sessionGeneration,
            traceID: origin.traceID,
            text: text
        )
        if isContinuousListeningEnabled {
            continuousPhase = .armed
            utteranceStartedAtMs = nil
            lastLoudAtMs = clock.milliseconds()
            refreshCapturePhase()
        }
    }

    private func handlePartial(generation: UInt64, traceID: String, text: String) {
        guard generation == sessionGeneration else { return }
        guard !didEmitTerminalForGeneration else { return }
        onEvent(.partial(traceID: traceID, text: text))
    }

    private func handleFinal(generation: UInt64, traceID: String, text: String) {
        guard generation == sessionGeneration else { return }
        guard !didEmitTerminalForGeneration else { return }
        refreshCapturePhase()
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
