//
//  CompanionManager.swift
//  leanring-buddy
//
//  Central state manager for the companion voice mode. Owns the push-to-talk
//  pipeline (dictation manager + global shortcut monitor + overlay) and
//  exposes observable voice state for the panel UI.
//

import AVFoundation
import Combine
import CoreGraphics
import Foundation
import os.log
import ScreenCaptureKit
import SwiftUI
import YishuContext

enum CompanionVoiceState {
    case idle
    case listening
    case processing
    case responding
}

private enum DirectClickFastPathOutcome {
    case handled(YishuComputerActionResult)
    case miss(DirectClickFastPathMissReason)
}

private enum DirectClickFastPathMissReason: String {
    case intentNotDirect = "intent_not_direct"
    case cancelled = "cancelled"
    case screenCaptureFailed = "screen_capture_failed"
    case ocrNoMatch = "ocr_no_match"
}

enum YishuRuntimeFailureRecoveryRoute: Equatable {
    case useActionReceipt
    case restartRuntime
    case surfaceFailure
}

enum YishuAgentRuntimeAvailability: Equatable {
    case starting
    case ready
    case stopped
}

private struct VoiceTurnOrigin {
    let traceID: String
    let releaseAt: UInt64?
}

private struct YishuRuntimeVoiceResponse {
    let text: String
    let speechAlreadyPresented: Bool
    let presentationTranscript: String
    let allowsScreenEffects: Bool
}

enum YishuRuntimePresentationAdvance: Equatable {
    case stale
    case current
    case advanced
}

/// Pure accumulator for one Runtime-owned presentation generation. The manager
/// uses the `advanced` edge to replace its sentence pipeline and visible text,
/// so a final response can never concatenate pre-interrupt and steered output.
struct YishuRuntimePresentationReducer: Equatable {
    private(set) var generation = 1
    private(set) var accumulatedText = ""
    private(set) var completedText: String?

    var authoritativeText: String {
        completedText ?? accumulatedText
    }

    mutating func advancePresentation(to nextGeneration: Int) -> YishuRuntimePresentationAdvance {
        guard nextGeneration >= generation else { return .stale }
        guard nextGeneration > generation else { return .current }
        generation = nextGeneration
        accumulatedText = ""
        completedText = nil
        return .advanced
    }

    mutating func appendCurrentDelta(_ text: String) {
        accumulatedText += text
    }

    mutating func completeCurrent(with text: String) {
        completedText = text
    }
}

/// Same-session steer is intentionally narrower than ordinary conversation.
/// It carries language context only: any desktop effect, product action, screen
/// reference, or ambiguous deictic phrase requires a fresh ContextFrame/turn.
enum YishuBargeInPolicy {
    static func allowsSameSessionConversation(_ utterance: String) -> Bool {
        let text = utterance.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty,
              YishuSentenceSpeechPolicy.allowsStreaming(for: text),
              YishuProductUtteranceRouter.classify(text) == .conversation else {
            return false
        }
        // This shell-only preflight is deliberately more conservative than
        // Kernel's authoritative IntentFrame: any likely desktop dependency
        // pays for a fresh frame instead of risking a stale same-session steer.
        let freshFrameEffect = #"(?:\b(?:click|press|open|close|type|enter|select|drag|scroll|send|delete|move|rename|create|save|execute|copy|paste|cut)\b|点击|打开|关闭|输入|选择|拖动|滚动|发送|删除|移动|重命名|创建|保存|执行|复制|粘贴|剪切|拷贝)"#
        guard text.range(
            of: freshFrameEffect,
            options: [.regularExpression, .caseInsensitive]
        ) == nil else { return false }
        let screenDependency = #"(?:这个|那个|这些|那些|这里|那里|刚才那个|刚刚那个|上一段|上一个|前一个|刚才的|当前|现在这个|屏幕|页面|网页|窗口|按钮|菜单|光标|鼠标|左边|右边|上面|下面|前台|选中|高亮|图里|截图|\b(?:this|that|these|those|here|there|last|previous|current\s+(?:screen|page|window)|screen|page|window|button|menu|cursor|selected)\b)"#
        guard text.range(
            of: screenDependency,
            options: [.regularExpression, .caseInsensitive]
        ) == nil else { return false }

        // Bare pronouns remain valid language context (for example, “它是什么
        // 意思?”). They require a fresh frame only when coupled to a likely
        // target mutation or spatial relation.
        let referentialInteraction = #"(?:(?:它|其).*(?:改|替换|放到|放在|移到|位置|旁边|里面)|(?:改|替换|放到|放在|移到).*(?:它|其)|\b(?:it|its)\b.*\b(?:change|replace|put|position|beside|inside)\b|\b(?:change|replace|put)\b.*\b(?:it|its)\b)"#
        return text.range(
            of: referentialInteraction,
            options: [.regularExpression, .caseInsensitive]
        ) == nil
    }
}

private enum YishuBargeInStatus: Equatable {
    case awaitingAcknowledgement
    case accepted(nextGeneration: Int)
    case rejected
}

private struct YishuBargeInAttempt: Equatable {
    let id: UUID
    let requestId: UUID
    let voiceTraceID: String
    var status: YishuBargeInStatus
}

private struct DirectClickPrewarmCache {
    let resolutionKey: String
    let screenCaptures: [CompanionScreenCapture]
    let match: YishuDirectClickMatch
    let capturedAtUptimeNanoseconds: UInt64
    let frontmostProcessIdentifier: pid_t?
    let displayFingerprint: String
    let traceID: String
}

private struct HeldSceneCache {
    let context: YishuCapturedContext
    let capturedAtUptimeNanoseconds: UInt64
    let startedAt: Date
    let frontmostProcessIdentifier: pid_t?
    let displayFingerprint: String
    let activeWindowNumber: Int?
    let traceID: String
}

/// Keeps the latency story observable without retaining transcripts, labels,
/// screenshots, or other private content. The trace origin is created on PTT
/// press; this timing object is created when final ASR text arrives and starts
/// at the recorded release timestamp when that origin is valid.
@MainActor
private final class VoiceTurnTiming {
    private let startedAt: UInt64
    private var previousAt: UInt64
    private let traceID: String
    private let hasValidReleaseOrigin: Bool

    init(origin: VoiceTurnOrigin?) {
        let now = DispatchTime.now().uptimeNanoseconds
        traceID = origin?.traceID ?? "unknown"
        if let releaseAt = origin?.releaseAt, releaseAt <= now {
            startedAt = releaseAt
            previousAt = releaseAt
            hasValidReleaseOrigin = true
        } else {
            startedAt = now
            previousAt = now
            hasValidReleaseOrigin = false
        }
    }

    func mark(
        _ phase: String,
        reason: String,
        sourceDimensions: String? = nil,
        receiptID: String? = nil
    ) {
        let now = DispatchTime.now().uptimeNanoseconds
        let deltaMS = Double(now - previousAt) / 1_000_000.0
        let totalMS = Double(now - startedAt) / 1_000_000.0
        let loggedReason = phase == "asr_complete" && !hasValidReleaseOrigin
            ? "unknown_origin"
            : reason
        CompanionManager.logVoicePhase(
            turnID: traceID,
            phase: phase,
            deltaMS: deltaMS,
            totalMS: totalMS,
            reason: loggedReason,
            sourceDimensions: sourceDimensions,
            receiptID: receiptID
        )
        previousAt = now
    }
}

@MainActor
final class CompanionManager: ObservableObject {
    private static let computerActionLogger = Logger(
        subsystem: "com.yishu.yishu-buddy",
        category: "computer-action"
    )

    @Published private(set) var voiceState: CompanionVoiceState = .idle {
        didSet {
            updateVisualState()
            if voiceState == .idle {
                scheduleDelegatedTaskReturnProcessing()
                scheduleTimeReminderReturnProcessing()
            }
        }
    }
    @Published private(set) var visualState: YishuVisualState = .breathing
    @Published private(set) var lastTranscript: String?
    @Published private(set) var livePartialTranscript = ""
    @Published private(set) var hasAccessibilityPermission = false
    @Published private(set) var hasScreenRecordingPermission = false
    @Published private(set) var hasMicrophonePermission = false
    @Published private(set) var hasScreenContentPermission = false
    @Published private(set) var sessionScope: YishuSessionScope = .personal
    @Published var projectScopeDraft = ""
    @Published private(set) var sessionScopeNotice: String?
    /// Personal history rows for the "我的" entry (never project/private).
    @Published private(set) var personalHistoryItems: [YishuHistoryListItem] = []
    @Published private(set) var personalHistoryLoading = false
    @Published private(set) var personalHistoryEmpty = false
    @Published private(set) var historyNotice: String?
    /// Personal memory rows for the "我的" entry (never project/private).
    @Published private(set) var personalMemoryItems: [YishuMemoryListItem] = []
    @Published private(set) var personalMemoryLoading = false
    @Published private(set) var personalMemoryEmpty = false
    @Published private(set) var memoryNotice: String?
    /// Visible source line for the **current** answer only. Must clear on any
    /// conversation/scope switch, cancel, or failure so a stale line cannot
    /// imply the new context still used that memory.
    @Published private(set) var memorySourceNotice: String?
    @Published var lastVerifiedSnapshot: YishuLastVerifiedSnapshot? =
        YishuLastVerifiedProjection.load()
    /// Pending delete confirmation target (title shown in confirm UI).
    @Published private(set) var historyDeleteCandidate: YishuHistoryListItem?
    @Published private(set) var historyDeleteInFlight = false
    /// Pending forget confirmation for one personal memory row.
    @Published private(set) var memoryForgetCandidate: YishuMemoryListItem?
    @Published private(set) var memoryForgetInFlight = false
    @Published private(set) var personalNoteSaving = false
    /// Local 8787 voice proxy health. Panel "在线" requires this ready.
    @Published private(set) var voiceProxyAvailability: YishuVoiceProxyAvailability = .stopped
    /// Pi sidecar health. A healthy voice proxy alone must never make the menu
    /// claim the agent runtime is online.
    @Published private(set) var agentRuntimeAvailability: YishuAgentRuntimeAvailability = .stopped

    /// Screen location (global AppKit coords) of a detected UI element the
    /// thinking-orb should fly to and point at. Parsed from Claude's response;
    /// observed by YishuPresenceView to trigger the flight animation.
    @Published var detectedElementScreenLocation: CGPoint?
    /// The display frame (global AppKit coords) of the screen the detected
    /// element is on, so YishuPresenceView knows which screen overlay should animate.
    @Published var detectedElementDisplayFrame: CGRect?
    /// Custom speech bubble text for the pointing animation. When set,
    /// YishuPresenceView uses this instead of a random pointer phrase.
    @Published var detectedElementBubbleText: String?

    // MARK: - Onboarding Video State (shared across all screen overlays)

    @Published var onboardingVideoPlayer: AVPlayer?
    @Published var showOnboardingVideo: Bool = false
    @Published var onboardingVideoOpacity: Double = 0.0
    private var onboardingVideoEndObserver: NSObjectProtocol?
    private var onboardingDemoTimeObserver: Any?

    // MARK: - Onboarding Prompt Bubble

    /// Text streamed character-by-character on the cursor after the onboarding video ends.
    @Published var onboardingPromptText: String = ""
    @Published var onboardingPromptOpacity: Double = 0.0
    @Published var showOnboardingPrompt: Bool = false

    // MARK: - Onboarding Music

    private var onboardingMusicPlayer: AVAudioPlayer?
    private var onboardingMusicFadeTimer: Timer?

    let buddyDictationManager = BuddyDictationManager()
    let globalPushToTalkShortcutMonitor = GlobalPushToTalkShortcutMonitor()
    let overlayWindowManager = OverlayWindowManager()
    private let responseOverlayManager = CompanionResponseOverlayManager()
    var responseOverlayViewModel: CompanionResponseOverlayViewModel {
        responseOverlayManager.viewModel
    }
    private let agentPresenceWindowManager = AgentPresenceWindowManager()
    var agentPresenceViewModel: AgentPresenceViewModel {
        agentPresenceWindowManager.viewModel
    }
    private let yishuPointerTrailMonitor = YishuPointerTrailMonitor()
    private lazy var yishuContextFrameCollector = YishuContextFrameCollector(
        pointerMonitor: yishuPointerTrailMonitor
    )
    private let yishuAgentRuntimeClient = YishuAgentRuntimeClient()
    private let voiceProxySupervisor = YishuVoiceProxySupervisor.shared
    private var voiceProxyAvailabilityCancellable: AnyCancellable?
    lazy var providerAccountsViewModel = ProviderAccountsViewModel(
        runtimeClient: yishuAgentRuntimeClient
    )
    /// Background ContextTrail sampling (metadata only, no screenshot bytes).
    private var trailSampleTask: Task<Void, Never>?
    private var taskSnapshotRefreshTask: Task<Void, Never>?
    private let trailSampleIntervalNanoseconds: UInt64 = 5_000_000_000

    /// A terminal delegated result remains in ResultInbox; this queue only
    /// controls its one-time, conversation-scoped spoken return.
    private var delegatedTaskReturnState = YishuDelegatedTaskReturnState()
    private var delegatedTaskReturnQueues: [UUID: [YishuDelegatedTaskPresenceEvent]] = [:]
    private var delegatedTaskReturnProcessingTask: Task<Void, Never>?
    private var delegatedTaskReturnProcessingToken: UUID?
    private var activeDelegatedTaskReturnID: UUID?
    /// System delivery is global rather than tied to whichever conversation is
    /// currently open. The identifier is remembered in a small in-memory ring
    /// so duplicated foreground callbacks never speak twice.
    private var timeReminderReturnState = YishuTimeReminderReturnState()
    private var timeReminderReturnProcessingTask: Task<Void, Never>?
    private let timeReminderQuietInterval: TimeInterval = 3
    private var agentRuntimeRestartTask: Task<Void, Never>?
    private var agentRuntimeRestartAttempts: [Date] = []
    private var agentRuntimeReadyWatchdogTask: Task<Void, Never>?
    private var agentRuntimeReadyWatchdogToken: UUID?

    /// Base URL for the local 奕枢 proxy. All voice API requests route through
    /// this so keys never ship in the app binary. Lifecycle is owned by
    /// `YishuVoiceProxySupervisor`.
    private static let workerBaseURL = "http://127.0.0.1:8787"

    private lazy var elevenLabsTTSClient: ElevenLabsTTSClient = {
        return ElevenLabsTTSClient(proxyURL: "\(Self.workerBaseURL)/tts")
    }()
    private var activeSentenceSpeechPipeline: YishuSentenceSpeechPipeline?
    private var coverSpeechTask: Task<Void, Never>?

    /// The currently running AI response task, if any. Cancelled when the user
    /// speaks again so a new response can begin immediately.
    private var currentResponseTask: Task<Void, Never>?
    private var activeVoiceTurnToken: UUID?
    private var activeRuntimeRequestId: UUID?
    private var activeRuntimePresentationTranscript: String?
    private var activeTurnEffectInFlight = false
    private var activeBargeInAttempt: YishuBargeInAttempt?
    private var bargeInInterruptTask: Task<Void, Never>?
    private var bargeInSubmissionTask: Task<Void, Never>?
    private var bargeInTranscriptWatchdogTask: Task<Void, Never>?
    private var visualStateMachine = YishuVisualStateMachine()
    private var runtimeVisualPhase: YishuRuntimeVisualPhase {
        get { visualStateMachine.runtimePhase }
        set {
            visualStateMachine.setRuntimePhase(newValue)
            updateVisualState()
        }
    }
    private var turnVisualPhase: YishuTurnVisualPhase {
        get { visualStateMachine.turnPhase }
        set {
            visualStateMachine.setTurnPhase(newValue)
            updateVisualState()
        }
    }
    #if DEBUG
    private var visualStateDemoOverride: YishuVisualState?
    #endif
    /// At most one computer action may be consumed for a voice turn. A Pi
    /// response can still contain a point tag after its action event; that tag
    /// must not replay the same click in `presentVoiceResponse`.
    private var activeTurnConsumedComputerAction = false
    private var activeTurnLastComputerActionResult: YishuComputerActionResult?
    private var activeTurnLastComputerActionName: String?
    private var directClickPrewarmTask: Task<Void, Never>?
    private var directClickPrewarmCache: DirectClickPrewarmCache?
    private var directClickPrewarmTraceID: String?
    private var didAttemptDirectClickPrewarm = false
    /// Press-time scene capture. Listening and looking start together.
    private var heldSceneTask: Task<Void, Never>?
    private var heldSceneCache: HeldSceneCache?
    private var partialTranscriptCount = 0
    private var firstPartialTranscriptAt: UInt64?
    /// Origin for the next keyboard PTT transcript. The trace ID is created
    /// on press; the monotonic release timestamp is filled on release and the
    /// origin is consumed exactly once when final ASR text is submitted.
    private var pendingVoiceTurnOrigin: VoiceTurnOrigin?

    private var shortcutTransitionCancellable: AnyCancellable?
    private var voiceStateCancellable: AnyCancellable?
    private var delegatedPresenceCancellable: AnyCancellable?
    private var accessibilityCheckTimer: Timer?
    private var pendingKeyboardShortcutStartTask: Task<Void, Never>?
    /// True while Control+Option (or configured PTT) is physically held.
    private var isPushToTalkKeyHeld = false
    /// Scheduled hide for transient cursor mode — cancelled if the user
    /// speaks again before the delay elapses.
    private var transientHideTask: Task<Void, Never>?

    /// True when all three required permissions (accessibility, screen recording,
    /// microphone) are granted. Used by the panel to show a single "all good" state.
    var allPermissionsGranted: Bool {
        hasAccessibilityPermission && hasScreenRecordingPermission && hasMicrophonePermission && hasScreenContentPermission
    }

    var canSwitchSessionScope: Bool {
        activeRuntimeRequestId == nil && voiceState == .idle && !yishuAgentRuntimeClient.hasActiveTurn
    }

    var canChangeConversation: Bool {
        canSwitchSessionScope
    }

    /// Current durable conversation id owned by the runtime client.
    var currentConversationId: UUID {
        yishuAgentRuntimeClient.currentConversationId
    }

    private var routedVisualState: YishuVisualState {
        #if DEBUG
        if let visualStateDemoOverride {
            return visualStateDemoOverride
        }
        #endif
        return visualStateMachine.visualState(
            voiceState: voiceState,
            delegatedTasks: agentPresenceViewModel.tasks
        )
    }

    private func updateVisualState() {
        let nextState = routedVisualState
        if visualState != nextState {
            visualState = nextState
        }
        let occupied = voiceState != .idle
            || yishuAgentRuntimeClient.hasActiveTurn
            || isPushToTalkKeyHeld
        agentPresenceWindowManager.setForegroundOccupied(occupied)
    }

    var sessionScopeLabel: String {
        switch sessionScope.kind {
        case .personal:
            return "我的"
        case .project:
            return sessionScope.projectLabel ?? "项目"
        case .privateSession:
            return "不保存"
        }
    }

    /// A scope change always creates a new conversation and drops Yishu's
    /// fallback cache, so neither the runtime nor the local fallback can retain another
    /// project's/private session's text.
    func activateSessionScope(_ kind: YishuSessionScopeKind) {
        guard canSwitchSessionScope else {
            sessionScopeNotice = "请等当前回答结束后再切换。"
            return
        }

        let nextScope: YishuSessionScope
        switch kind {
        case .personal:
            nextScope = .personal
        case .privateSession:
            nextScope = .privateSession
        case .project:
            let normalized = projectScopeDraft
                .split(whereSeparator: \.isWhitespace)
                .joined(separator: " ")
            let rememberedProject = yishuAgentRuntimeClient.lastProjectScope
            let reusableProjectID = sessionScope.kind == .project
                ? sessionScope.projectId
                : (rememberedProject?.projectLabel == normalized ? rememberedProject?.projectId : nil)
            guard let project = YishuSessionScope.project(
                id: reusableProjectID ?? UUID(),
                label: normalized
            ) else {
                sessionScopeNotice = "先填写项目名称。"
                return
            }
            nextScope = project
        }

        if nextScope == sessionScope {
            sessionScopeNotice = nil
            return
        }
        guard yishuAgentRuntimeClient.beginNewConversation(scope: nextScope) else {
            sessionScopeNotice = "当前会话仍在执行，暂时不能切换。"
            return
        }
        clearMemorySourceNotice()
        resetDelegatedTaskProjectionForConversationChange()
        sessionScope = nextScope
        projectScopeDraft = nextScope.projectLabel ?? projectScopeDraft
        sessionScopeNotice = nextScope.kind == .privateSession
            ? "这次内容不会保存，也不会用于以后的回答。"
            : "已切换到「\(sessionScopeLabel)」。"
        historyNotice = nil
        memoryNotice = nil
        if nextScope.kind == .personal {
            refreshPersonalHistory()
            refreshPersonalMemories()
        } else {
            personalHistoryItems = []
            personalHistoryEmpty = false
            personalMemoryItems = []
            personalMemoryEmpty = false
            memoryForgetCandidate = nil
        }
    }

    /// Reload "我的" durable history. No fake rows on empty or failure.
    /// - Parameter clearNotice: When true (default), drop any prior notice so
    ///   a manual refresh does not leave stale success text. New-conversation
    ///   sets its notice first and passes false so "已开始新对话。" stays visible.
    func refreshPersonalHistory(clearNotice: Bool = true) {
        guard sessionScope.kind == .personal else {
            personalHistoryItems = []
            personalHistoryEmpty = false
            return
        }
        guard yishuAgentRuntimeClient.isRunning else {
            historyNotice = "运行时尚未就绪，稍后再看历史。"
            return
        }
        personalHistoryLoading = true
        if clearNotice {
            historyNotice = nil
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.personalHistoryLoading = false }
            do {
                let items = try await self.yishuAgentRuntimeClient.listHistory(
                    scope: .personal,
                    limit: 30
                )
                self.personalHistoryItems = items
                self.personalHistoryEmpty = items.isEmpty
            } catch {
                self.personalHistoryItems = []
                self.personalHistoryEmpty = false
                self.historyNotice = error.localizedDescription
            }
        }
    }

    /// Reload "我的" personal memories. No fake rows on empty or failure.
    func refreshPersonalMemories(clearNotice: Bool = true) {
        guard sessionScope.kind == .personal else {
            personalMemoryItems = []
            personalMemoryEmpty = false
            memoryForgetCandidate = nil
            return
        }
        guard yishuAgentRuntimeClient.isRunning else {
            memoryNotice = YishuPersonalNotesCopy.runtimeNotReadyRead
            return
        }
        personalMemoryLoading = true
        if clearNotice {
            memoryNotice = nil
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.personalMemoryLoading = false }
            do {
                let items = try await self.yishuAgentRuntimeClient.listMemories(
                    scope: .personal,
                    limit: 50
                )
                self.personalMemoryItems = items
                self.personalMemoryEmpty = items.isEmpty
            } catch {
                self.personalMemoryItems = []
                self.personalMemoryEmpty = false
                self.memoryNotice = error.localizedDescription
            }
        }
    }

    /// User actively selected an old personal conversation to continue.
    func continuePersonalHistory(_ item: YishuHistoryListItem) {
        guard canChangeConversation else {
            historyNotice = "请等当前回答结束后再切换对话。"
            return
        }
        guard sessionScope.kind == .personal else {
            historyNotice = "先切到「我的」再打开个人历史。"
            return
        }
        guard yishuAgentRuntimeClient.isRunning else {
            historyNotice = "运行时尚未就绪。"
            return
        }
        historyNotice = nil
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let opened = try await self.yishuAgentRuntimeClient.openHistory(
                    conversationId: item.id,
                    scope: .personal
                )
                guard self.canChangeConversation else {
                    self.historyNotice = "请等当前回答结束后再切换对话。"
                    return
                }
                guard self.yishuAgentRuntimeClient.selectConversation(
                    id: opened.conversationId,
                    scope: .personal
                ) else {
                    self.historyNotice = "当前会话仍在执行，暂时不能切换。"
                    return
                }
                // Continuing another conversation must not inherit the prior
                // turn's memory source line (Codex PROOF-1b residual).
                self.clearMemorySourceNotice()
                self.resetDelegatedTaskProjectionForConversationChange()
                self.sessionScope = .personal
                self.historyNotice = "已继续「\(item.title)」。"
            } catch {
                self.historyNotice = error.localizedDescription
            }
        }
    }

    /// Create a clean personal conversation with no prior local context.
    func beginNewPersonalConversation() {
        guard canChangeConversation else {
            historyNotice = "请等当前回答结束后再新建对话。"
            return
        }
        guard yishuAgentRuntimeClient.beginNewConversation(scope: .personal) else {
            historyNotice = "当前会话仍在执行，暂时不能新建。"
            return
        }
        clearMemorySourceNotice()
        resetDelegatedTaskProjectionForConversationChange()
        sessionScope = .personal
        historyNotice = "已开始新对话。"
        // Keep the success notice; a plain refresh would wipe it immediately.
        refreshPersonalHistory(clearNotice: false)
        refreshPersonalMemories(clearNotice: false)
    }

    /// Ask the user to confirm soft-delete of one personal history row.
    func requestDeletePersonalHistory(_ item: YishuHistoryListItem) {
        guard canChangeConversation else {
            historyNotice = "请等当前回答结束后再删除对话。"
            return
        }
        guard sessionScope.kind == .personal else {
            historyNotice = "先切到「我的」再删除个人历史。"
            return
        }
        guard !historyDeleteInFlight else { return }
        historyDeleteCandidate = item
        historyNotice = nil
    }

    /// Cancel pending delete confirmation without touching storage or list.
    func cancelDeletePersonalHistory() {
        historyDeleteCandidate = nil
    }

    /// Confirm soft-delete. Only removes from UI after storage succeeds.
    /// If the deleted row is the current conversation, rotates to a new clean ID.
    func confirmDeletePersonalHistory() {
        guard let item = historyDeleteCandidate else { return }
        guard canChangeConversation else {
            historyNotice = "请等当前回答结束后再删除对话。"
            historyDeleteCandidate = nil
            return
        }
        guard sessionScope.kind == .personal else {
            historyNotice = "先切到「我的」再删除个人历史。"
            historyDeleteCandidate = nil
            return
        }
        guard yishuAgentRuntimeClient.isRunning else {
            historyNotice = "运行时尚未就绪，删除未执行。"
            historyDeleteCandidate = nil
            return
        }
        guard !historyDeleteInFlight else { return }
        historyDeleteInFlight = true
        let deletingCurrent = yishuAgentRuntimeClient.currentConversationId == item.id
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.historyDeleteInFlight = false
                self.historyDeleteCandidate = nil
            }
            do {
                let deleted = try await self.yishuAgentRuntimeClient.deleteHistory(
                    conversationId: item.id,
                    scope: .personal
                )
                guard deleted.status == "archived" else {
                    self.historyNotice = "删除失败，原对话仍保留。"
                    return
                }
                // Only drop the row after store confirmed archive.
                self.personalHistoryItems.removeAll { $0.id == item.id }
                self.personalHistoryEmpty = self.personalHistoryItems.isEmpty
                if deletingCurrent {
                    guard self.yishuAgentRuntimeClient.beginNewConversation(scope: .personal) else {
                        self.historyNotice = "已删除，但当前会话仍在执行，稍后请手动新建。"
                        return
                    }
                    self.clearMemorySourceNotice()
                    self.resetDelegatedTaskProjectionForConversationChange()
                    self.sessionScope = .personal
                    self.historyNotice = "已删除「\(item.title)」，已开始新对话。"
                } else {
                    self.historyNotice = "已删除「\(item.title)」。"
                }
            } catch {
                // Keep the original row on any failure.
                self.historyNotice = error.localizedDescription.isEmpty
                    ? "删除失败，原对话仍保留。"
                    : error.localizedDescription
            }
        }
    }

    /// Ask the user to confirm forget of one personal memory row.
    func requestForgetPersonalMemory(_ item: YishuMemoryListItem) {
        guard canChangeConversation else {
            // Policy: busy answer refuses without store writes or list mutation.
            if !YishuMemoryForgetUIPolicy.shouldMutateStoreWhenBusy {
                memoryNotice = YishuMemoryForgetUIPolicy.busyRefuseNotice
            }
            return
        }
        guard sessionScope.kind == .personal else {
            memoryNotice = YishuPersonalNotesCopy.needPersonal
            return
        }
        guard !memoryForgetInFlight else { return }
        memoryForgetCandidate = item
        memoryNotice = nil
    }

    /// Cancel pending forget without touching storage or list.
    func cancelForgetPersonalMemory() {
        // Policy: cancel never writes the store or drops list rows.
        if !YishuMemoryForgetUIPolicy.shouldMutateStoreOnCancel {
            memoryForgetCandidate = nil
        }
    }

    /// Confirm forget. Only removes from UI after storage succeeds.
    func confirmForgetPersonalMemory() {
        guard let item = memoryForgetCandidate else { return }
        guard canChangeConversation else {
            memoryNotice = YishuMemoryForgetUIPolicy.busyRefuseNotice
            memoryForgetCandidate = nil
            return
        }
        guard sessionScope.kind == .personal else {
            memoryNotice = YishuPersonalNotesCopy.needPersonal
            memoryForgetCandidate = nil
            return
        }
        guard yishuAgentRuntimeClient.isRunning else {
            memoryNotice = YishuPersonalNotesCopy.runtimeNotReadyForget
            memoryForgetCandidate = nil
            return
        }
        guard !memoryForgetInFlight else { return }
        memoryForgetInFlight = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.memoryForgetInFlight = false
                self.memoryForgetCandidate = nil
            }
            do {
                let forgotten = try await self.yishuAgentRuntimeClient.forgetMemory(
                    memoryId: item.id,
                    scope: .personal
                )
                // Policy: only drop the row after store confirmed hard delete.
                if YishuMemoryForgetUIPolicy.shouldRemoveRowOnlyAfterStoreSuccess {
                    self.personalMemoryItems.removeAll {
                        $0.id == forgotten.memoryId || $0.id == item.id
                    }
                    self.personalMemoryEmpty = self.personalMemoryItems.isEmpty
                }
                self.memoryNotice = forgotten.alreadyGone
                    ? YishuPersonalNotesCopy.alreadyGone
                    : YishuPersonalNotesCopy.forgot(item.summary)
            } catch {
                // Keep the original row on any failure (do not remove).
                self.memoryNotice = error.localizedDescription.isEmpty
                    ? YishuPersonalNotesCopy.forgetFailed
                    : error.localizedDescription
            }
        }
    }

    /// Write one personal note through the existing memory store.
    /// Empty text never creates a row. The draft clears only after confirmed success.
    func savePersonalNote(_ raw: String, onConfirmed: @escaping () -> Void = {}) {
        let text = YishuPersonalNoteWritePolicy.normalizedText(raw)
        guard YishuPersonalNoteWritePolicy.shouldCreate(text) else {
            memoryNotice = YishuPersonalNotesCopy.emptyDraft
            return
        }
        guard canChangeConversation else {
            memoryNotice = YishuPersonalNotesCopy.busyWrite
            return
        }
        guard sessionScope.kind == .personal else {
            memoryNotice = YishuPersonalNotesCopy.needPersonal
            return
        }
        guard yishuAgentRuntimeClient.isRunning else {
            memoryNotice = YishuPersonalNotesCopy.runtimeNotReadyWrite
            return
        }
        guard !personalNoteSaving else { return }
        personalNoteSaving = true
        memoryNotice = nil
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.personalNoteSaving = false }
            do {
                let remembered = try await self.yishuAgentRuntimeClient.rememberMemory(
                    text: text,
                    scope: .personal
                )
                guard remembered.confirmed else {
                    self.memoryNotice = YishuPersonalNotesCopy.unconfirmed
                    self.refreshPersonalMemories(clearNotice: false)
                    return
                }
                self.personalMemoryItems.removeAll { $0.id == remembered.item.id }
                self.personalMemoryItems.insert(remembered.item, at: 0)
                if self.personalMemoryItems.count > 50 {
                    self.personalMemoryItems.removeLast()
                }
                self.personalMemoryEmpty = false
                self.memoryNotice = YishuPersonalNotesCopy.saved
                onConfirmed()
            } catch {
                self.memoryNotice = error.localizedDescription.isEmpty
                    ? YishuPersonalNotesCopy.notSaved
                    : error.localizedDescription
                self.refreshPersonalMemories(clearNotice: false)
            }
        }
    }

    /// Whether the blue cursor overlay is currently visible on screen.
    /// Used by the panel to show accurate status text ("Active" vs "Ready").
    @Published private(set) var isOverlayVisible: Bool = false

    private static let selectedModelDefaultsKey = "selectedClaudeModel"
    private static let selectedModelProviderDefaultsKey = "selectedModelProvider"

    private static let bootSelection: (provider: String, model: String) = {
        let resolved = YishuConversationModelCatalog.resolvedSelection(
            storedModel: UserDefaults.standard.string(forKey: selectedModelDefaultsKey),
            storedProvider: UserDefaults.standard.string(forKey: selectedModelProviderDefaultsKey)
        )
        UserDefaults.standard.set(resolved.provider, forKey: selectedModelProviderDefaultsKey)
        UserDefaults.standard.set(resolved.model, forKey: selectedModelDefaultsKey)
        return resolved
    }()

    @Published private(set) var selectedModelProvider: String = CompanionManager.bootSelection.provider

    @Published private(set) var selectedModel: String = CompanionManager.bootSelection.model

    var configuredAuthModels: [YishuAuthModel] {
        YishuAuthProvider.allCases.flatMap { provider -> [YishuAuthModel] in
            let state = providerAccountsViewModel.state(for: provider)
            return state.isConfigured ? state.models : []
        }
    }

    var availableConversationModels: [YishuConversationModelOption] {
        YishuConversationModelCatalog.available(authModels: configuredAuthModels)
    }

    var conversationModelSections: [(title: String, models: [YishuConversationModelOption])] {
        YishuConversationModelCatalog.sections(authModels: configuredAuthModels)
    }

    var selectedModelLabel: String {
        guard let option = availableConversationModels.first(where: {
            $0.provider == selectedModelProvider && $0.model == selectedModel
        }) else {
            return "\(selectedModel) · 需登录"
        }
        return YishuAccountSurfaceCopy.selectedLine(label: option.label, source: option.sourceLabel)
    }

    func setSelectedModel(_ option: YishuConversationModelOption) {
        guard availableConversationModels.contains(option) else { return }
        selectedModelProvider = option.provider
        selectedModel = option.model
        UserDefaults.standard.set(option.provider, forKey: Self.selectedModelProviderDefaultsKey)
        UserDefaults.standard.set(option.model, forKey: Self.selectedModelDefaultsKey)
        UserDefaults.standard.set(true, forKey: "clicky.chatModel.userPicked.v1")
        print("🧠 奕枢 model → \(option.provider)/\(option.model)")
    }

    /// User preference for whether Yishu's thinking-orb should be shown.
    /// When toggled off, the overlay is hidden and push-to-talk is disabled.
    /// Persisted to UserDefaults so the choice survives app restarts.
    /// The defaults key stays `isClickyCursorEnabled` so existing installs keep their choice.
    @Published var isYishuCursorEnabled: Bool = UserDefaults.standard.object(forKey: "isClickyCursorEnabled") == nil
        ? true
        : UserDefaults.standard.bool(forKey: "isClickyCursorEnabled")

    /// Spoken reply rate for MiniMax TTS (0.5…2.0). Default 1.0. Not a secret.
    @Published var speechSpeed: Double = YishuSpeechSpeed.load()

    private var speechSpeedPreviewTask: Task<Void, Never>?

    func setYishuCursorEnabled(_ enabled: Bool) {
        isYishuCursorEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: "isClickyCursorEnabled")
        transientHideTask?.cancel()
        transientHideTask = nil

        if enabled {
            overlayWindowManager.hasShownOverlayBefore = true
            overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
            isOverlayVisible = true
        } else {
            overlayWindowManager.hideOverlay()
            isOverlayVisible = false
        }
    }

    func setSpeechSpeed(_ raw: Double) {
        let clamped = YishuSpeechSpeed.clamp(raw)
        speechSpeed = clamped
        YishuSpeechSpeed.store(clamped)
    }

    func resetSpeechSpeedToDefault() {
        setSpeechSpeed(YishuSpeechSpeed.defaultValue)
    }

    /// Fixed non-private sample so the user can hear the current rate.
    func previewSpeechSpeed() {
        speechSpeedPreviewTask?.cancel()
        elevenLabsTTSClient.stopPlayback()
        let speed = speechSpeed
        speechSpeedPreviewTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await self.elevenLabsTTSClient.speakText(
                    YishuSpeechSpeed.previewUtterance,
                    speed: speed
                )
            } catch {
                print("⚠️ 奕枢 TTS preview failed")
            }
        }
    }

    func stopSpeechPlayback() {
        speechSpeedPreviewTask?.cancel()
        speechSpeedPreviewTask = nil
        stopCoverSpeech()
        cancelActiveSentenceSpeechPipeline()
        elevenLabsTTSClient.stopPlayback()
    }

    @Published var hasSeenIntro: Bool = YishuActivationPolicy.introSeen()
    @Published var hasCompletedOnboarding: Bool = YishuActivationPolicy.isActivated()

    /// Personal fork: email gate disabled (always treated as submitted).
    @Published var hasSubmittedEmail: Bool = true

    /// Kept for UI compatibility. No network submit on the personal fork.
    func submitEmail(_ email: String) {
        hasSubmittedEmail = true
        UserDefaults.standard.set(true, forKey: "hasSubmittedEmail")
        print("📩 奕枢: skip remote email submit")
    }

    func start() {
        if yishuAgentRuntimeClient.currentSessionScope.kind != .personal {
            _ = yishuAgentRuntimeClient.beginNewConversation(scope: .personal)
        }
        sessionScope = .personal
        projectScopeDraft = ""
        refreshAllPermissions()
        print("🔑 奕枢 start — accessibility: \(hasAccessibilityPermission), screen: \(hasScreenRecordingPermission), mic: \(hasMicrophonePermission), screenContent: \(hasScreenContentPermission), intro: \(hasSeenIntro), activated: \(hasCompletedOnboarding)")
        startPermissionPolling()
        bindVoiceStateObservation()
        bindShortcutTransitions()
        bindVoiceProxyAvailability()
        bindDelegatedPresenceObservation()
        yishuPointerTrailMonitor.start()
        agentPresenceWindowManager.onCancelTask = { [weak self] task in
            guard let self else { return }
            self.agentPresenceWindowManager.markCancelRequesting(task.id)
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    _ = try await self.yishuAgentRuntimeClient.cancelDelegatedTask(
                        taskId: task.id,
                        mainConversationId: task.mainConversationId
                    )
                    self.agentPresenceWindowManager.markCancelAccepted(task.id)
                } catch {
                    self.agentPresenceWindowManager.markCancelFailed(
                        task.id,
                        message: error.localizedDescription
                    )
                }
            }
        }
        agentPresenceWindowManager.onPresentResult = { [weak self] task in
            guard let self else { return }
            guard task.taskKind == .contextReminder else { return }
            self.interruptDelegatedTaskReturnForForegroundTurn()
            self.suppressDelegatedTaskReturn(task.id)
            Task { @MainActor [weak self] in
                guard let self else { return }
                let text = self.spokenTextForDelegatedReturn(task)
                self.responseOverlayManager.showStaticMessage(text, autoHideAfter: 12)
                try? await Task.sleep(nanoseconds: 12_000_000_000)
                self.scheduleDelegatedTaskReturnProcessing()
            }
        }
        agentPresenceWindowManager.onRetryFromBeginning = { [weak self] task in
            self?.retryDelegatedTaskFromBeginning(task)
        }
        agentPresenceWindowManager.onStartNewDirection = { [weak self] task in
            self?.promptForNewDirection(after: task)
        }
        yishuAgentRuntimeClient.onDelegatedTaskPresenceEvent = { [weak self] event in
            guard let self else { return }
            let currentConversationID = self.yishuAgentRuntimeClient.currentConversationId
            self.agentPresenceWindowManager.apply(
                event,
                expectedConversationId: currentConversationID
            )
            guard event.mainConversationId == currentConversationID else { return }
            if self.delegatedTaskReturnState.shouldEnqueueLive(event) {
                self.enqueueDelegatedTaskReturn(event)
            }
        }
        yishuAgentRuntimeClient.onLifecycleEvent = { [weak self] event in
            self?.updateRuntimeVisualPhase(for: event)
            switch event {
            case let .ready(mode):
                self?.cancelAgentRuntimeReadyWatchdog()
                self?.agentRuntimeRestartTask?.cancel()
                self?.agentRuntimeRestartTask = nil
                self?.agentRuntimeAvailability = .ready
                print("🧠 奕枢 Runtime ready (\(mode))")
                Task { @MainActor in
                    if self?.sessionScope.kind == .personal {
                        self?.refreshPersonalHistory()
                    }
                }
                self?.refreshDelegatedTaskSnapshot()
            case let .stopped(exitCode):
                self?.cancelAgentRuntimeReadyWatchdog()
                self?.agentRuntimeAvailability = .stopped
                print("⚠️ 奕枢 Runtime stopped (\(exitCode))")
                self?.taskSnapshotRefreshTask?.cancel()
                self?.taskSnapshotRefreshTask = nil
                self?.agentPresenceWindowManager.markRuntimeInterrupted()
                self?.scheduleAgentRuntimeRestart()
            }
        }
        // Local voice proxy (8787) must be ready before the panel claims online.
        Task { @MainActor [weak self] in
            await self?.voiceProxySupervisor.ensureStarted()
        }
        do {
            runtimeVisualPhase = .connecting
            agentRuntimeAvailability = .starting
            try yishuAgentRuntimeClient.start()
            armAgentRuntimeReadyWatchdog()
            startContextTrailSampling()
        } catch {
            runtimeVisualPhase = .idle
            agentRuntimeAvailability = .stopped
            print("⚠️ 奕枢 Runtime unavailable; scheduling bounded restart")
            scheduleAgentRuntimeRestart()
        }
        if hasSeenIntro && allPermissionsGranted && isYishuCursorEnabled {
            overlayWindowManager.hasShownOverlayBefore = true
            overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
            isOverlayVisible = true
        }

        #if DEBUG
        presentPresenceVisualDemoIfRequested()
        #endif

    }

    /// Panel retry control when the local voice proxy is down.
    func retryVoiceProxy() {
        voiceProxySupervisor.retry()
    }

    /// Panel retry control for the Pi sidecar. Availability stays `starting`
    /// until a typed runtime.ready event arrives.
    func retryAgentRuntime() {
        agentRuntimeRestartTask?.cancel()
        agentRuntimeRestartTask = nil
        agentRuntimeRestartAttempts.removeAll()
        guard !yishuAgentRuntimeClient.isRunning else { return }
        agentRuntimeAvailability = .starting
        runtimeVisualPhase = .connecting
        do {
            try yishuAgentRuntimeClient.start()
            armAgentRuntimeReadyWatchdog()
            startContextTrailSampling()
        } catch {
            agentRuntimeAvailability = .stopped
            runtimeVisualPhase = .idle
        }
    }

    /// Restart a crashed sidecar without replaying any user turn. Three
    /// launches per minute bound crash loops; a manual retry resets the budget.
    private func scheduleAgentRuntimeRestart() {
        guard agentRuntimeRestartTask == nil,
              !yishuAgentRuntimeClient.isRunning else { return }
        let now = Date()
        agentRuntimeRestartAttempts.removeAll {
            now.timeIntervalSince($0) >= 60
        }
        guard agentRuntimeRestartAttempts.count < 3 else { return }
        let delay = min(pow(2, Double(agentRuntimeRestartAttempts.count)) * 0.4, 2)
        agentRuntimeRestartAttempts.append(now)
        agentRuntimeRestartTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(
                    nanoseconds: UInt64(delay * 1_000_000_000)
                )
            } catch {
                return
            }
            guard let self else { return }
            self.agentRuntimeRestartTask = nil
            guard !self.yishuAgentRuntimeClient.isRunning else { return }
            self.agentRuntimeAvailability = .starting
            self.runtimeVisualPhase = .connecting
            do {
                try self.yishuAgentRuntimeClient.start()
                self.agentRuntimeRestartTask = nil
                self.armAgentRuntimeReadyWatchdog()
                self.startContextTrailSampling()
            } catch {
                self.agentRuntimeAvailability = .stopped
                self.runtimeVisualPhase = .idle
                self.scheduleAgentRuntimeRestart()
            }
        }
    }

    /// A live process is not yet a usable Runtime. If typed runtime.ready does
    /// not arrive, terminate this generation so the normal bounded restart
    /// path can recover instead of leaving the product stuck on “starting”.
    private func armAgentRuntimeReadyWatchdog() {
        cancelAgentRuntimeReadyWatchdog()
        guard agentRuntimeAvailability == .starting else { return }
        let token = UUID()
        agentRuntimeReadyWatchdogToken = token
        agentRuntimeReadyWatchdogTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: 12_000_000_000)
            } catch {
                return
            }
            guard let self,
                  self.agentRuntimeReadyWatchdogToken == token,
                  self.agentRuntimeAvailability == .starting,
                  self.yishuAgentRuntimeClient.isRunning else { return }
            print("⚠️ 奕枢 Runtime ready timeout; restarting boundedly")
            self.yishuAgentRuntimeClient.terminateForRecovery()
        }
    }

    private func cancelAgentRuntimeReadyWatchdog() {
        agentRuntimeReadyWatchdogTask?.cancel()
        agentRuntimeReadyWatchdogTask = nil
        agentRuntimeReadyWatchdogToken = nil
    }

    private func refreshDelegatedTaskSnapshot() {
        taskSnapshotRefreshTask?.cancel()
        let conversationId = yishuAgentRuntimeClient.currentConversationId
        taskSnapshotRefreshTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let tasks = try await self.yishuAgentRuntimeClient.listDelegatedTasks(
                    mainConversationId: conversationId
                )
                guard !Task.isCancelled,
                      self.agentRuntimeAvailability == .ready,
                      self.yishuAgentRuntimeClient.currentConversationId == conversationId else {
                    return
                }
                self.agentPresenceWindowManager.mergeSnapshot(tasks)
                for task in tasks where self.delegatedTaskReturnState.shouldEnqueueSnapshot(task) {
                    self.enqueueDelegatedTaskReturn(task)
                }
            } catch is CancellationError {
                return
            } catch {
                // Keep the last typed task state visible. An unsupported or
                // failed snapshot must never erase an interruption card.
            }
        }
    }

    private func resetDelegatedTaskProjectionForConversationChange() {
        taskSnapshotRefreshTask?.cancel()
        taskSnapshotRefreshTask = nil
        cancelDelegatedTaskReturnProcessing(stopActiveAnnouncement: true)
        delegatedTaskReturnQueues.removeAll()
        agentPresenceWindowManager.replaceWithSnapshot([])
        if agentRuntimeAvailability == .ready {
            refreshDelegatedTaskSnapshot()
        }
    }

    private func retryDelegatedTaskFromBeginning(_ task: YishuDelegatedTaskPresenceEvent) {
        suppressDelegatedTaskReturn(task.id)
        guard canChangeConversation else {
            ensureOverlayVisibleForVoiceFeedback()
            responseOverlayManager.showStaticMessage(
                "当前回答还在执行。等它结束后，再从头重试这项任务。",
                autoHideAfter: 8
            )
            return
        }
        runVoiceTurnTask(
            transcript: "请从头重新执行这项后台任务，不要假设之前的执行进度仍然存在：\(task.title)",
            origin: nil
        )
    }

    private func promptForNewDirection(after task: YishuDelegatedTaskPresenceEvent) {
        suppressDelegatedTaskReturn(task.id)
        agentPresenceWindowManager.acknowledge(task.id)
        ensureOverlayVisibleForVoiceFeedback()
        responseOverlayManager.showStaticMessage(
            "按住 Control + Option，说出新的方向。",
            autoHideAfter: 10
        )
    }

    private func bindVoiceProxyAvailability() {
        voiceProxyAvailability = voiceProxySupervisor.availability
        voiceProxyAvailabilityCancellable = voiceProxySupervisor.$availability
            .receive(on: RunLoop.main)
            .sink { [weak self] availability in
                self?.voiceProxyAvailability = availability
            }
    }

    private func bindDelegatedPresenceObservation() {
        delegatedPresenceCancellable = agentPresenceViewModel.$tasks
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.updateVisualState()
            }
    }

    /// Auto-return speaks the already-unwrapped finding. A second model
    /// excerpt can take 20s and miss the 4s chip.
    private func spokenTextForDelegatedReturn(
        _ task: YishuDelegatedTaskPresenceEvent
    ) -> String {
        task.returnAnnouncementText ?? task.statusLabel
    }

    private func enqueueDelegatedTaskReturn(_ task: YishuDelegatedTaskPresenceEvent) {
        guard task.mainConversationId == yishuAgentRuntimeClient.currentConversationId,
              task.returnAnnouncementText != nil,
              task.id != activeDelegatedTaskReturnID else { return }
        var queue = delegatedTaskReturnQueues[task.mainConversationId] ?? []
        guard !queue.contains(where: { $0.id == task.id }) else { return }
        queue.append(task)
        delegatedTaskReturnQueues[task.mainConversationId] = queue
        scheduleDelegatedTaskReturnProcessing()
    }

    /// Called only after macOS has already shown the foreground banner. This
    /// optional spoken follow-up is intentionally not attached to a turn, so a
    /// conversation change can never lose a reminder the system delivered.
    func enqueueTimeReminderReturn(identifier: String, body: String) {
        guard timeReminderReturnState.enqueue(identifier: identifier, body: body) else { return }
        scheduleTimeReminderReturnProcessing()
    }

    private func scheduleTimeReminderReturnProcessing() {
        guard timeReminderReturnProcessingTask == nil,
              !timeReminderReturnState.pending.isEmpty else { return }
        timeReminderReturnProcessingTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.timeReminderReturnProcessingTask = nil }
            while !Task.isCancelled, !self.timeReminderReturnState.pending.isEmpty {
                guard await self.waitForTimeReminderQuietWindow(),
                      let reminder = self.timeReminderReturnState.takeNext() else {
                    return
                }
                // The banner is already the delivery truth. Remove before TTS
                // so an interruption cannot replay this reminder later.
                let announcement = "提醒你：\(reminder.body)"
                self.ensureOverlayVisibleForVoiceFeedback()
                self.responseOverlayManager.showStaticMessage(announcement, autoHideAfter: 12)
                do {
                    try await self.elevenLabsTTSClient.speakText(
                        announcement,
                        speed: self.speechSpeed
                    )
                } catch {
                    // The system banner remains visible delivery; never retry
                    // or log the reminder text.
                }
            }
        }
    }

    private func waitForTimeReminderQuietWindow() async -> Bool {
        while !Task.isCancelled {
            let foregroundBusy = voiceState != .idle
                || currentResponseTask != nil
                || activeRuntimeRequestId != nil
                || yishuAgentRuntimeClient.hasActiveTurn
                || isPushToTalkKeyHeld
                || elevenLabsTTSClient.isPlaying
            let secondsSinceLastUserInput = CGEventSource.secondsSinceLastEventType(
                .hidSystemState,
                eventType: CGEventType(rawValue: UInt32.max)!
            )
            if YishuDelegatedTaskReturnState.canPresent(
                foregroundBusy: foregroundBusy,
                secondsSinceLastUserInput: secondsSinceLastUserInput,
                quietInterval: timeReminderQuietInterval
            ) {
                return true
            }
            do {
                try await Task.sleep(nanoseconds: 250_000_000)
            } catch {
                return false
            }
        }
        return false
    }

    private func suppressDelegatedTaskReturn(_ taskID: UUID) {
        delegatedTaskReturnState.markAnnounced(taskID)
        for conversationID in Array(delegatedTaskReturnQueues.keys) {
            delegatedTaskReturnQueues[conversationID]?.removeAll { $0.id == taskID }
        }
        if activeDelegatedTaskReturnID == taskID {
            cancelDelegatedTaskReturnProcessing(stopActiveAnnouncement: true)
        }
    }

    private func scheduleDelegatedTaskReturnProcessing() {
        guard delegatedTaskReturnProcessingTask == nil else { return }
        let conversationID = yishuAgentRuntimeClient.currentConversationId
        guard delegatedTaskReturnQueues[conversationID]?.isEmpty == false else { return }
        let token = UUID()
        delegatedTaskReturnProcessingToken = token
        delegatedTaskReturnProcessingTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.delegatedTaskReturnProcessingToken == token {
                    self.delegatedTaskReturnProcessingTask = nil
                    self.delegatedTaskReturnProcessingToken = nil
                    self.activeDelegatedTaskReturnID = nil
                }
            }
            while !Task.isCancelled,
                  self.yishuAgentRuntimeClient.currentConversationId == conversationID,
                  let task = self.delegatedTaskReturnQueues[conversationID]?.first {
                guard await self.waitForDelegatedReturnQuietWindow(
                    conversationID: conversationID
                ) else { return }
                guard !Task.isCancelled,
                      self.yishuAgentRuntimeClient.currentConversationId == conversationID,
                      self.delegatedTaskReturnQueues[conversationID]?.first?.id == task.id,
                      task.returnAnnouncementText != nil else { continue }

                let text = self.spokenTextForDelegatedReturn(task)
                self.activeDelegatedTaskReturnID = task.id
                if task.taskKind == .contextReminder {
                    self.ensureOverlayVisibleForVoiceFeedback()
                    self.responseOverlayManager.showStaticMessage(text, autoHideAfter: 12)
                }
                do {
                    try await self.elevenLabsTTSClient.speakText(
                        text,
                        speed: self.speechSpeed
                    )
                    while self.elevenLabsTTSClient.isPlaying && !Task.isCancelled {
                        try await Task.sleep(nanoseconds: 200_000_000)
                    }
                } catch is CancellationError {
                    // PTT/cancel is not delivery. Keep the head item durable and
                    // queued so it can return after the foreground turn ends.
                    return
                } catch {
                    print("⚠️ 奕枢后台任务回访 TTS 失败")
                }
                guard !Task.isCancelled,
                      self.delegatedTaskReturnQueues[conversationID]?.first?.id == task.id else {
                    return
                }
                self.delegatedTaskReturnQueues[conversationID]?.removeFirst()
                self.delegatedTaskReturnState.markAnnounced(task.id)
                self.activeDelegatedTaskReturnID = nil
                self.scheduleTransientHideIfNeeded()
            }
        }
    }

    private func waitForDelegatedReturnQuietWindow(conversationID: UUID) async -> Bool {
        while !Task.isCancelled {
            guard yishuAgentRuntimeClient.currentConversationId == conversationID else {
                return false
            }
            let foregroundBusy = voiceState != .idle
                || currentResponseTask != nil
                || activeRuntimeRequestId != nil
                || yishuAgentRuntimeClient.hasActiveTurn
                || isPushToTalkKeyHeld
                || elevenLabsTTSClient.isPlaying
            // quietInterval is 0: HID idle is not a gate. Do not sample it.
            if YishuDelegatedTaskReturnState.canPresent(
                foregroundBusy: foregroundBusy,
                secondsSinceLastUserInput: 0,
                quietInterval: 0
            ) {
                return true
            }
            do {
                try await Task.sleep(nanoseconds: 250_000_000)
            } catch {
                return false
            }
        }
        return false
    }

    private func cancelDelegatedTaskReturnProcessing(stopActiveAnnouncement: Bool) {
        delegatedTaskReturnProcessingTask?.cancel()
        delegatedTaskReturnProcessingTask = nil
        delegatedTaskReturnProcessingToken = nil
        if stopActiveAnnouncement, activeDelegatedTaskReturnID != nil {
            responseOverlayManager.hideOverlay()
            elevenLabsTTSClient.stopPlayback()
        }
        activeDelegatedTaskReturnID = nil
    }

    private func interruptDelegatedTaskReturnForForegroundTurn() {
        // Waiting items remain queued. Once this foreground turn finishes and
        // the user is quiet again, the pump resumes with the same conversation.
        cancelDelegatedTaskReturnProcessing(stopActiveAnnouncement: true)
    }

    private func updateRuntimeVisualPhase(for event: YishuRuntimeLifecycleEvent) {
        visualStateMachine.apply(runtimeEvent: event)
        updateVisualState()
    }

    private func updateTurnVisualPhase(for event: YishuRuntimeTurnEvent) {
        visualStateMachine.apply(turnEvent: event)
        updateVisualState()
    }

    #if DEBUG
    /// Deterministic visual state for installed-app screenshot acceptance.
    /// It is reachable only from a task-specific launch environment variable.
    private func presentPresenceVisualDemoIfRequested() {
        guard let requestedDemo = ProcessInfo.processInfo.environment["YISHU_PRESENCE_VISUAL_DEMO"] else {
            return
        }

        ensureOverlayVisibleForVoiceFeedback()
        if let requestedState = YishuVisualState(rawValue: requestedDemo) {
            visualStateDemoOverride = requestedState
            updateVisualState()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                self?.updateVisualState()
            }
            return
        }

        switch requestedDemo {
        case "response":
            voiceState = .responding
            responseOverlayManager.showOverlayAndBeginStreaming()
            Task { [weak self] in
                let demoResponse = Array("你好，我在听。你说。")
                var accumulatedResponse = ""
                try? await Task.sleep(nanoseconds: 280_000_000)
                for character in demoResponse {
                    accumulatedResponse.append(character)
                    self?.responseOverlayManager.updateStreamingText(accumulatedResponse)
                    try? await Task.sleep(nanoseconds: 72_000_000)
                }
            }
        case "listening":
            responseOverlayManager.hideOverlay()
            isPushToTalkKeyHeld = true
            voiceState = .listening
        default:
            break
        }
    }
    #endif

    /// Called by YishuPresenceView after the orb finishes its pointing
    /// animation and returns to cursor-following mode.
    /// Triggers the onboarding sequence — dismisses the panel and restarts
    /// the overlay so the welcome animation and intro video play.
    func triggerOnboarding() {
        // Post notification so the panel manager can dismiss the panel
        NotificationCenter.default.post(name: .yishuDismissPanel, object: nil)

        // Start is intro / welcome only. Do not mark activation here.
        markIntroSeen()

        ClickyAnalytics.trackOnboardingStarted()

        // Play Besaid theme at 60% volume, fade out after 1m 30s
        startOnboardingMusic()

        // Show the overlay for the first time — isFirstAppearance triggers
        // the welcome animation and onboarding video
        overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
        isOverlayVisible = true
    }

    /// Replays the onboarding experience from the "Watch Onboarding Again"
    /// footer link. Same flow as triggerOnboarding but the cursor overlay
    /// is already visible so we just restart the welcome animation and video.
    func replayOnboarding() {
        NotificationCenter.default.post(name: .yishuDismissPanel, object: nil)
        ClickyAnalytics.trackOnboardingReplayed()
        startOnboardingMusic()
        // Tear down any existing overlays and recreate with isFirstAppearance = true
        overlayWindowManager.hasShownOverlayBefore = false
        overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
        isOverlayVisible = true
    }

    private func stopOnboardingMusic() {
        onboardingMusicFadeTimer?.invalidate()
        onboardingMusicFadeTimer = nil
        onboardingMusicPlayer?.stop()
        onboardingMusicPlayer = nil
    }

    private func startOnboardingMusic() {
        stopOnboardingMusic()
        guard let musicURL = Bundle.main.url(forResource: "ff", withExtension: "mp3") else {
            print("⚠️ 奕枢: ff.mp3 not found in bundle")
            return
        }

        do {
            let player = try AVAudioPlayer(contentsOf: musicURL)
            player.volume = 0.3
            player.play()
            self.onboardingMusicPlayer = player

            // After 1m 30s, fade the music out over 3s
            onboardingMusicFadeTimer = Timer.scheduledTimer(withTimeInterval: 90.0, repeats: false) { [weak self] _ in
                self?.fadeOutOnboardingMusic()
            }
        } catch {
            print("⚠️ 奕枢: Failed to play onboarding music: \(error)")
        }
    }

    private func fadeOutOnboardingMusic() {
        guard let player = onboardingMusicPlayer else { return }

        let fadeSteps = 30
        let fadeDuration: Double = 3.0
        let stepInterval = fadeDuration / Double(fadeSteps)
        let volumeDecrement = player.volume / Float(fadeSteps)
        var stepsRemaining = fadeSteps

        onboardingMusicFadeTimer = Timer.scheduledTimer(withTimeInterval: stepInterval, repeats: true) { [weak self] timer in
            stepsRemaining -= 1
            player.volume -= volumeDecrement

            if stepsRemaining <= 0 {
                timer.invalidate()
                player.stop()
                self?.onboardingMusicPlayer = nil
                self?.onboardingMusicFadeTimer = nil
            }
        }
    }

    func clearDetectedElementLocation() {
        detectedElementScreenLocation = nil
        detectedElementDisplayFrame = nil
        detectedElementBubbleText = nil
    }

    func stop() {
        globalPushToTalkShortcutMonitor.stop()
        buddyDictationManager.cancelCurrentDictation()
        directClickPrewarmTask?.cancel()
        directClickPrewarmTask = nil
        directClickPrewarmCache = nil
        directClickPrewarmTraceID = nil
        overlayWindowManager.hideOverlay()
        transientHideTask?.cancel()
        trailSampleTask?.cancel()
        trailSampleTask = nil
        taskSnapshotRefreshTask?.cancel()
        taskSnapshotRefreshTask = nil
        agentRuntimeRestartTask?.cancel()
        agentRuntimeRestartTask = nil
        cancelAgentRuntimeReadyWatchdog()
        cancelDelegatedTaskReturnProcessing(stopActiveAnnouncement: true)
        delegatedTaskReturnQueues.removeAll()
        timeReminderReturnProcessingTask?.cancel()
        timeReminderReturnProcessingTask = nil
        timeReminderReturnState.clearPending()

        pendingVoiceTurnOrigin = nil
        currentResponseTask?.cancel()
        currentResponseTask = nil
        cancelActiveRuntimeTurn(reason: "application-stopping")
        yishuAgentRuntimeClient.stop()
        agentRuntimeAvailability = .stopped
        voiceProxySupervisor.stop()
        voiceProxyAvailabilityCancellable?.cancel()
        voiceProxyAvailabilityCancellable = nil
        delegatedPresenceCancellable?.cancel()
        delegatedPresenceCancellable = nil
        clearHeldSceneCapture()
        yishuPointerTrailMonitor.stop()
        responseOverlayManager.hideOverlay()
        agentPresenceWindowManager.stop()
        speechSpeedPreviewTask?.cancel()
        speechSpeedPreviewTask = nil
        elevenLabsTTSClient.stopPlayback()
        shortcutTransitionCancellable?.cancel()
        voiceStateCancellable?.cancel()
        accessibilityCheckTimer?.invalidate()
        accessibilityCheckTimer = nil
    }

    func refreshAllPermissions() {
        let previouslyHadAccessibility = hasAccessibilityPermission
        let previouslyHadScreenRecording = hasScreenRecordingPermission
        let previouslyHadMicrophone = hasMicrophonePermission
        let previouslyHadAll = allPermissionsGranted

        let currentlyHasAccessibility = WindowPositionManager.hasAccessibilityPermission()
        hasAccessibilityPermission = currentlyHasAccessibility

        if currentlyHasAccessibility {
            globalPushToTalkShortcutMonitor.start()
        } else {
            globalPushToTalkShortcutMonitor.stop()
        }

        hasScreenRecordingPermission = WindowPositionManager.hasScreenRecordingPermission()

        let micAuthStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        hasMicrophonePermission = micAuthStatus == .authorized

        // Debug: log permission state on changes
        if previouslyHadAccessibility != hasAccessibilityPermission
            || previouslyHadScreenRecording != hasScreenRecordingPermission
            || previouslyHadMicrophone != hasMicrophonePermission {
            print("🔑 Permissions — accessibility: \(hasAccessibilityPermission), screen: \(hasScreenRecordingPermission), mic: \(hasMicrophonePermission), screenContent: \(hasScreenContentPermission)")
        }

        // Track individual permission grants as they happen
        if !previouslyHadAccessibility && hasAccessibilityPermission {
            ClickyAnalytics.trackPermissionGranted(permission: "accessibility")
        }
        if !previouslyHadScreenRecording && hasScreenRecordingPermission {
            ClickyAnalytics.trackPermissionGranted(permission: "screen_recording")
        }
        if !previouslyHadMicrophone && hasMicrophonePermission {
            ClickyAnalytics.trackPermissionGranted(permission: "microphone")
        }
        // Screen content permission is persisted — once the user has approved the
        // SCShareableContent picker, we don't need to re-check it.
        if !hasScreenContentPermission {
            hasScreenContentPermission = UserDefaults.standard.bool(forKey: "hasScreenContentPermission")
        }

        if !previouslyHadAll && allPermissionsGranted {
            ClickyAnalytics.trackAllPermissionsGranted()
        }
    }

    /// Walk remaining permissions in order. macOS still shows one system
    /// dialog at a time; this only sequences the prompts the panel can start.
    func requestPermissionsInGuidedSequence() {
        Task { @MainActor in
            refreshAllPermissions()

            let microphoneStatus: YishuPermissionGuidance.MicrophoneStatus
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized:
                microphoneStatus = .authorized
            case .notDetermined:
                microphoneStatus = .notDetermined
            default:
                microphoneStatus = .denied
            }
            switch YishuPermissionGuidance.nextStep(
                microphone: microphoneStatus,
                accessibilityGranted: hasAccessibilityPermission,
                screenRecordingGranted: hasScreenRecordingPermission,
                screenContentGranted: hasScreenContentPermission
            ) {
            case .microphone:
                if microphoneStatus == .notDetermined {
                    let granted = await withCheckedContinuation { continuation in
                        AVCaptureDevice.requestAccess(for: .audio) { granted in
                            continuation.resume(returning: granted)
                        }
                    }
                    hasMicrophonePermission = granted
                    if granted {
                        requestPermissionsInGuidedSequence()
                    } else {
                        WindowPositionManager.openMicrophoneSettings()
                    }
                } else {
                    WindowPositionManager.openMicrophoneSettings()
                }
            case .accessibility:
                _ = WindowPositionManager.requestAccessibilityPermission()
                try? await Task.sleep(nanoseconds: 700_000_000)
                refreshAllPermissions()
                if hasAccessibilityPermission {
                    requestPermissionsInGuidedSequence()
                }
            case .screenRecording:
                _ = WindowPositionManager.requestScreenRecordingPermission()
            case .screenContent:
                requestScreenContentPermission()
            case .done:
                break
            }
        }
    }

    /// Triggers the macOS screen content picker by performing a dummy
    /// screenshot capture. Once the user approves, we persist the grant
    /// so they're never asked again during onboarding.
    @Published private(set) var isRequestingScreenContent = false

    func requestScreenContentPermission() {
        guard !isRequestingScreenContent else { return }
        isRequestingScreenContent = true
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first else {
                    await MainActor.run { isRequestingScreenContent = false }
                    return
                }
                let filter = SCContentFilter(display: display, excludingWindows: [])
                let config = SCStreamConfiguration()
                config.width = 320
                config.height = 240
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
                // Verify the capture actually returned real content — a 0x0 or
                // fully-empty image means the user denied the prompt.
                let didCapture = image.width > 0 && image.height > 0
                print("🔑 Screen content capture result — width: \(image.width), height: \(image.height), didCapture: \(didCapture)")
                await MainActor.run {
                    isRequestingScreenContent = false
                    guard didCapture else { return }
                    hasScreenContentPermission = true
                    UserDefaults.standard.set(true, forKey: "hasScreenContentPermission")
                    ClickyAnalytics.trackPermissionGranted(permission: "screen_content")

                    if hasSeenIntro && allPermissionsGranted && !isOverlayVisible && isYishuCursorEnabled {
                        overlayWindowManager.hasShownOverlayBefore = true
                        overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
                        isOverlayVisible = true
                    }
                }
            } catch {
                print("⚠️ Screen content permission request failed: \(error)")
                await MainActor.run { isRequestingScreenContent = false }
            }
        }
    }

    // MARK: - Private

    /// Triggers the system microphone prompt if the user has never been asked.
    /// Once granted/denied the status sticks and polling picks it up.
    private func promptForMicrophoneIfNotDetermined() {
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined else { return }
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            Task { @MainActor [weak self] in
                self?.hasMicrophonePermission = granted
            }
        }
    }

    /// Polls all permissions frequently so the UI updates live after the
    /// user grants them in System Settings. Screen Recording is the exception —
    /// macOS requires an app restart for that one to take effect.
    private func startPermissionPolling() {
        accessibilityCheckTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.refreshAllPermissions()
            }
        }
    }

    private func bindVoiceStateObservation() {
        voiceStateCancellable = buddyDictationManager.$isRecordingFromKeyboardShortcut
            .combineLatest(
                buddyDictationManager.$isFinalizingTranscript,
                buddyDictationManager.$isPreparingToRecord
            )
            .receive(on: DispatchQueue.main)
            .sink { [weak self] isRecording, isFinalizing, isPreparing in
                guard let self else { return }
                // Don't override .responding — the AI response pipeline
                // manages that state directly until streaming finishes.
                guard self.voiceState != .responding else { return }

                if isFinalizing {
                    self.turnVisualPhase = .finalizingSpeech
                    self.voiceState = .processing
                } else if isRecording {
                    self.voiceState = .listening
                } else if isPreparing || self.isPushToTalkKeyHeld {
                    // Keep waveform from key-down through session start / hold.
                    self.voiceState = .listening
                } else {
                    self.turnVisualPhase = .idle
                    self.voiceState = .idle
                    // If the user pressed and released the hotkey without
                    // saying anything, no response task runs — schedule the
                    // transient hide here so the overlay doesn't get stuck.
                    // Only do this when no response is in flight, otherwise
                    // the brief idle gap between recording and processing
                    // would prematurely hide the overlay.
                    if self.currentResponseTask == nil {
                        self.scheduleTransientHideIfNeeded()
                    }
                }
            }
    }

    /// Mount (or remount) the cursor overlay so waveform/spinner can show.
    private func ensureOverlayVisibleForVoiceFeedback() {
        if isOverlayVisible, overlayWindowManager.isShowingOverlay() {
            // Already up — still re-order front so it is not buried.
            overlayWindowManager.orderOverlaysFront()
            return
        }
        overlayWindowManager.hasShownOverlayBefore = true
        overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
        isOverlayVisible = true
    }

    private func bindShortcutTransitions() {
        shortcutTransitionCancellable = globalPushToTalkShortcutMonitor
            .shortcutTransitionPublisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] transition in
                self?.handleShortcutTransition(transition)
            }
    }

    private func handleShortcutTransition(_ transition: BuddyPushToTalkShortcut.ShortcutTransition) {
        switch transition {
        case .pressed:
            guard !buddyDictationManager.isDictationInProgress else { return }
            // Don't register push-to-talk while the onboarding video is playing
            guard !showOnboardingVideo else { return }

            // Key-down owns the audio channel synchronously. No async Runtime
            // acknowledgement is allowed to delay stopping a spoken sentence.
            cancelActiveSentenceSpeechPipeline()
            elevenLabsTTSClient.stopPlayback()
            clearMemorySourceNotice()

            // The user takes the floor immediately. Stop only the item already
            // speaking; waiting returns stay queued for the next quiet window.
            interruptDelegatedTaskReturnForForegroundTurn()

            // A new press starts a new trace. Any origin left by an interrupted
            // or silent session must not be attached to this transcript.
            let voiceTurnTraceID = Self.newVoiceTurnTraceID()
            pendingVoiceTurnOrigin = VoiceTurnOrigin(
                traceID: voiceTurnTraceID,
                releaseAt: nil
            )
            let preservingRuntimeTurn = beginBargeInIfEligible(
                voiceTraceID: voiceTurnTraceID
            )
            directClickPrewarmTask?.cancel()
            directClickPrewarmTask = nil
            directClickPrewarmCache = nil
            directClickPrewarmTraceID = voiceTurnTraceID
            didAttemptDirectClickPrewarm = false
            partialTranscriptCount = 0
            firstPartialTranscriptAt = nil
            Self.logVoicePhase(
                turnID: voiceTurnTraceID,
                phase: "ptt_press",
                deltaMS: 0,
                totalMS: 0,
                reason: "shortcut_pressed"
            )
            isPushToTalkKeyHeld = true

            // Cancel any pending transient hide so the overlay stays visible
            transientHideTask?.cancel()
            transientHideTask = nil

            // Always surface the thinking-orb for PTT feedback (waveform/spinner).
            // Previously only restored when cursor preference was OFF — if the
            // preference was ON but overlay never mounted (permission race,
            // multi-space, ad-hoc re-sign), hold-to-talk had no UI at all.
            ensureOverlayVisibleForVoiceFeedback()

            // Immediate state so the waveform appears on key-down, not after
            // the async permission/session start hop.
            voiceState = .listening
            livePartialTranscript = ""

            // Dismiss the menu bar panel so it doesn't cover the screen
            NotificationCenter.default.post(name: .yishuDismissPanel, object: nil)

            // A pure, effect-free Runtime turn stays alive only after its old
            // generation has been synchronously fenced. Every other path keeps
            // the established cancel + fresh ContextFrame behavior.
            if !preservingRuntimeTurn {
                invalidateActiveVoiceTurn()
                currentResponseTask?.cancel()
                currentResponseTask = nil
                cancelActiveRuntimeTurn(reason: "user-interrupted")
            }
            responseOverlayManager.hideOverlay()
            clearDetectedElementLocation()

            // Dismiss the onboarding prompt if it's showing
            if showOnboardingPrompt {
                withAnimation(.easeOut(duration: 0.3)) {
                    onboardingPromptOpacity = 0.0
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    self.showOnboardingPrompt = false
                    self.onboardingPromptText = ""
                }
            }


            ClickyAnalytics.trackPushToTalkStarted()
            startHeldSceneCapture(traceID: voiceTurnTraceID)

            pendingKeyboardShortcutStartTask?.cancel()
            pendingKeyboardShortcutStartTask = Task { [weak self] in
                await buddyDictationManager.startPushToTalkFromKeyboardShortcut(
                    currentDraftText: "",
                    updateDraftText: { [weak self] partialText in
                        guard let self else { return }
                        guard self.voiceState == .listening else { return }
                        self.livePartialTranscript = partialText
                        self.recordShadowPartial(traceID: voiceTurnTraceID)
                        self.startDirectClickPrewarmIfEligible(
                            partialText,
                            traceID: voiceTurnTraceID
                        )
                    },
                    submitDraftText: { [weak self] finalTranscript in
                        guard let self else { return }
                        self.livePartialTranscript = ""
                        let trimmed = finalTranscript
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        if trimmed.isEmpty {
                            // Unclear / blank capture: visible failure only.
                            // No runtime turn, no store write, no TTS success.
                            self.presentUnclearHearingFailure(traceID: voiceTurnTraceID)
                            return
                        }
                        self.lastTranscript = trimmed
                        print("🗣️ 奕枢 received transcript (\(trimmed.count) characters)")
                        ClickyAnalytics.trackUserMessageSent(transcript: trimmed)
                        let origin = self.consumeVoiceTurnOrigin(for: voiceTurnTraceID)
                        self.submitVoiceTranscript(
                            transcript: trimmed,
                            origin: origin
                        )
                    }
                )
            }
        case .released:
            // Cancel the pending start task in case the user released the shortcut
            // before the async startPushToTalk had a chance to begin recording.
            // Without this, a quick press-and-release drops the release event and
            // leaves the waveform overlay stuck on screen indefinitely.
            let releaseAt = DispatchTime.now().uptimeNanoseconds
            let releasedOrigin = pendingVoiceTurnOrigin
            if let releasedOrigin {
                pendingVoiceTurnOrigin = VoiceTurnOrigin(
                    traceID: releasedOrigin.traceID,
                    releaseAt: releaseAt
                )
            }
            ClickyAnalytics.trackPushToTalkReleased()
            isPushToTalkKeyHeld = false
            pendingKeyboardShortcutStartTask?.cancel()
            pendingKeyboardShortcutStartTask = nil
            buddyDictationManager.stopPushToTalkFromKeyboardShortcut()
            armBargeInTranscriptWatchdogIfNeeded()
            Self.logVoicePhase(
                turnID: releasedOrigin?.traceID ?? "unknown",
                phase: "ptt_release",
                deltaMS: 0,
                totalMS: 0,
                reason: releasedOrigin == nil
                    ? "shortcut_released_unknown_origin"
                    : "shortcut_released"
            )
        case .none:
            break
        }
    }

    // MARK: - Companion Prompt

    private static let companionVoiceResponseSystemPrompt = """
    你是「奕枢」，住在用户 macOS 菜单栏旁的中文屏幕伙伴。用户用按住说话（Control+Option）跟你交流，你能看到当前屏幕截图。你的回复会用语音读出来，所以要用口语写，不要书面腔。这是一段连续对话，你要记住之前说过的内容。

    规则：
    - 默认一到两句，直接、信息密度高。用户要求展开、细讲、深入时，再详细说，不限长度。
    - 使用自然中文口语。不要 emoji，不要 markdown，不要列表和编号。
    - 为耳朵写：短句，避免难读的缩写和符号。小数可以说成口语。
    - 问题如果和屏幕有关，点名你看到的具体界面、按钮、文字。
    - 截图无关时，直接回答问题即可。
    - 可帮写代码、写作、常识、 brainstorm。不要念完整大段代码，用口语说明改哪里、为什么。
    - 不要说「简单」「只需要」这类空话。
    - 少用「要不要我继续讲」这种死胡同是非问。说完如果合适，可以补一句值得继续想的方向；答完也可以直接停。
    - 多屏时，标注为 primary focus 的是光标所在屏，优先参考，其他屏有关也要提。

    指点元素：
    你有一个蓝色小三角光标，可以飞到屏幕元素上指给用户看。当用户问怎么操作、找菜单、找按钮、导航界面时，尽量指出具体位置。纯常识问题或与屏幕无关时不要硬指。

    需要指点时，在口播正文之后、回复最末尾追加坐标标签。截图带有像素尺寸，坐标原点是图像左上角，x 向右、y 向下。

    当用户明确要求点击或按下时，坐标标签会被执行层转成真实动作。正文不要说“你自己点”或“我已经点好”，只需给出目标坐标，完成语由执行层根据验证结果生成。

    格式：`[POINT:x,y:标签]`。标签用 1-4 个中文词或英文短词。如果元素在别的屏幕，追加 `:screenN`（N 来自截图标签里的屏幕号）。不需要指点时写 `[POINT:none]`。

    例子：
    - 用户问 Final Cut 怎么调色：先口语说步骤，再 `[POINT:1100,42:调色检查器]`
    - 用户问什么是 HTML：口语解释，再 `[POINT:none]`
    - 元素在第二屏：`[POINT:400,300:终端:screen2]`
    """

    // MARK: - AI Response Pipeline

    private func consumeVoiceTurnOrigin(for traceID: String) -> VoiceTurnOrigin? {
        guard let origin = pendingVoiceTurnOrigin,
              origin.traceID == traceID else {
            return nil
        }
        pendingVoiceTurnOrigin = nil
        return origin
    }

    private static func newVoiceTurnTraceID() -> String {
        let compactUUID = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        return String(compactUUID.prefix(12)).lowercased()
    }

    private func beginBargeInIfEligible(voiceTraceID: String) -> Bool {
        guard let requestId = activeRuntimeRequestId,
              currentResponseTask != nil,
              activeVoiceTurnToken != nil,
              !activeTurnConsumedComputerAction,
              !activeTurnEffectInFlight,
              let currentTranscript = activeRuntimePresentationTranscript,
              YishuBargeInPolicy.allowsSameSessionConversation(currentTranscript),
              let generation = yishuAgentRuntimeClient.activeGeneration(requestId: requestId),
              yishuAgentRuntimeClient.suppressTurnForInterruption(
                requestId: requestId,
                expectedGeneration: generation
              ) else {
            return false
        }

        bargeInInterruptTask?.cancel()
        bargeInSubmissionTask?.cancel()
        let attempt = YishuBargeInAttempt(
            id: UUID(),
            requestId: requestId,
            voiceTraceID: voiceTraceID,
            status: .awaitingAcknowledgement
        )
        activeBargeInAttempt = attempt
        bargeInInterruptTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let status: YishuBargeInStatus
            do {
                let decision = try await self.yishuAgentRuntimeClient.interruptTurn(
                    requestId: requestId,
                    expectedGeneration: generation
                )
                switch decision {
                case let .accepted(interruptedGeneration, nextGeneration)
                    where interruptedGeneration == generation:
                    status = .accepted(nextGeneration: nextGeneration)
                case .accepted, .rejected:
                    status = .rejected
                }
            } catch {
                status = .rejected
            }
            guard var current = self.activeBargeInAttempt,
                  current.id == attempt.id else { return }
            current.status = status
            self.activeBargeInAttempt = current
            if status == .rejected {
                // Keep the attempt token so an already-arrived transcript can
                // still consume exactly one fresh-start route. Only the old,
                // now permanently suppressed Runtime turn is retired here.
                self.cancelInterruptedRuntimeTurnPreservingAttempt(
                    requestId: requestId,
                    reason: "barge-in-interrupt-rejected"
                )
            }
        }
        return true
    }

    private func submitVoiceTranscript(
        transcript: String,
        origin: VoiceTurnOrigin?
    ) {
        bargeInTranscriptWatchdogTask?.cancel()
        bargeInTranscriptWatchdogTask = nil
        guard let attempt = activeBargeInAttempt else {
            runVoiceTurnTask(transcript: transcript, origin: origin)
            return
        }
        bargeInSubmissionTask?.cancel()
        let acknowledgementTask = bargeInInterruptTask
        bargeInSubmissionTask = Task { @MainActor [weak self] in
            guard let self else { return }
            if !YishuBargeInPolicy.allowsSameSessionConversation(transcript) {
                self.fallbackFromBargeIn(
                    attemptID: attempt.id,
                    transcript: transcript,
                    origin: origin,
                    reason: "fresh-context-required"
                )
                return
            }

            await acknowledgementTask?.value
            guard let current = self.activeBargeInAttempt,
                  current.id == attempt.id else { return }
            guard case let .accepted(nextGeneration) = current.status,
                  self.activeRuntimeRequestId == current.requestId,
                  self.currentResponseTask != nil,
                  self.activeVoiceTurnToken != nil,
                  !self.activeTurnEffectInFlight,
                  self.yishuAgentRuntimeClient.hasActiveTurn(requestId: current.requestId) else {
                self.fallbackFromBargeIn(
                    attemptID: attempt.id,
                    transcript: transcript,
                    origin: origin,
                    reason: "interrupt-not-active"
                )
                return
            }

            do {
                try self.yishuAgentRuntimeClient.steerTurn(
                    requestId: current.requestId,
                    message: transcript,
                    nextGeneration: nextGeneration
                )
            } catch {
                self.fallbackFromBargeIn(
                    attemptID: attempt.id,
                    transcript: transcript,
                    origin: origin,
                    reason: "steer-send-failed"
                )
                return
            }

            self.activeRuntimePresentationTranscript = transcript
            self.activeBargeInAttempt = nil
            self.bargeInInterruptTask = nil
            self.bargeInSubmissionTask = nil
            self.turnVisualPhase = .reasoning
            self.voiceState = .processing
            self.ensureOverlayVisibleForVoiceFeedback()
            self.responseOverlayManager.showThinking()
        }
    }

    private func fallbackFromBargeIn(
        attemptID: UUID,
        transcript: String,
        origin: VoiceTurnOrigin?,
        reason: String
    ) {
        guard activeBargeInAttempt?.id == attemptID else { return }
        activeBargeInAttempt = nil
        bargeInInterruptTask = nil
        bargeInSubmissionTask = nil
        invalidateActiveVoiceTurn()
        currentResponseTask?.cancel()
        currentResponseTask = nil
        cancelActiveRuntimeTurn(reason: reason)
        runVoiceTurnTask(transcript: transcript, origin: origin)
    }

    private func invalidateActiveVoiceTurn() {
        activeVoiceTurnToken = nil
        activeTurnEffectInFlight = false
    }

    private func ownsVoiceTurn(_ token: UUID) -> Bool {
        activeVoiceTurnToken == token && !Task.isCancelled
    }

    private func cancelInterruptedRuntimeTurnPreservingAttempt(
        requestId: UUID,
        reason: String
    ) {
        cancelActiveSentenceSpeechPipeline()
        invalidateActiveVoiceTurn()
        currentResponseTask?.cancel()
        currentResponseTask = nil
        guard activeRuntimeRequestId == requestId else { return }
        activeRuntimeRequestId = nil
        activeRuntimePresentationTranscript = nil
        activeTurnEffectInFlight = false
        turnVisualPhase = .idle
        try? yishuAgentRuntimeClient.cancelTurn(requestId: requestId, reason: reason)
    }

    private func armBargeInTranscriptWatchdogIfNeeded() {
        guard let attempt = activeBargeInAttempt else { return }
        bargeInTranscriptWatchdogTask?.cancel()
        bargeInTranscriptWatchdogTask = Task { @MainActor [weak self] in
            do {
                // The slowest shipping provider finalizes in 15 seconds.
                try await Task.sleep(nanoseconds: 17_000_000_000)
            } catch {
                return
            }
            guard let self,
                  self.activeBargeInAttempt?.id == attempt.id else { return }
            self.presentUnclearHearingFailure(traceID: attempt.voiceTraceID)
        }
    }

    private func clearBargeInAttempt() {
        activeBargeInAttempt = nil
        bargeInInterruptTask?.cancel()
        bargeInInterruptTask = nil
        bargeInSubmissionTask?.cancel()
        bargeInSubmissionTask = nil
        bargeInTranscriptWatchdogTask?.cancel()
        bargeInTranscriptWatchdogTask = nil
    }

    /// User held PTT but ASR produced no usable text.
    /// Show a short failure on the cursor overlay; do not write a completed
    /// assistant answer, do not start TTS, do not call the runtime.
    private func presentUnclearHearingFailure(traceID: String) {
        clearHeldSceneCapture()
        clearBargeInAttempt()
        invalidateActiveVoiceTurn()
        currentResponseTask?.cancel()
        currentResponseTask = nil
        cancelActiveRuntimeTurn(reason: "unclear-hearing")
        elevenLabsTTSClient.stopPlayback()
        clearMemorySourceNotice()

        Self.logVoicePhase(
            turnID: traceID,
            phase: "asr_complete",
            deltaMS: 0,
            totalMS: 0,
            reason: "empty_transcript"
        )
        Self.logVoicePhase(
            turnID: traceID,
            phase: "asr_failed",
            deltaMS: 0,
            totalMS: 0,
            reason: "unclear_no_speech"
        )

        ensureOverlayVisibleForVoiceFeedback()
        responseOverlayManager.showStaticMessage("没听清，请再说一次。")
        turnVisualPhase = .idle
        voiceState = .idle
        scheduleTransientHideIfNeeded()
    }

    /// Captures the cursor-grounded ContextFrame, sends it to the Pi runtime,
    /// streams the reply beside the small cursor presence, and hands the final
    /// spoken text to the existing MiniMax-backed TTS client.
    private func runVoiceTurnTask(
        transcript: String,
        origin: VoiceTurnOrigin?
    ) {
        clearBargeInAttempt()
        currentResponseTask?.cancel()
        cancelActiveSentenceSpeechPipeline()
        cancelActiveRuntimeTurn(reason: "superseded")
        elevenLabsTTSClient.stopPlayback()

        let turnToken = UUID()
        activeVoiceTurnToken = turnToken
        activeTurnConsumedComputerAction = false
        activeTurnLastComputerActionResult = nil
        activeTurnLastComputerActionName = nil
        currentResponseTask = Task { [weak self] in
            guard let self else { return }
            let timing = VoiceTurnTiming(origin: origin)
            let partialCount = partialTranscriptCount
            timing.mark(
                "asr_complete",
                reason: "final_transcript_partial_count_\(partialCount)"
            )
            let directIntent = YishuDirectClickResolver.isDirectClickIntent(transcript)
            timing.mark(
                "intent_classified",
                reason: directIntent ? "direct_click" : "general_turn"
            )
            defer {
                if directClickPrewarmTraceID == origin?.traceID {
                    directClickPrewarmTask?.cancel()
                    directClickPrewarmTask = nil
                    directClickPrewarmCache = nil
                    directClickPrewarmTraceID = nil
                }
                if activeVoiceTurnToken == turnToken {
                    activeVoiceTurnToken = nil
                    currentResponseTask = nil
                }
                if !Task.isCancelled && activeVoiceTurnToken == nil {
                    turnVisualPhase = .idle
                    voiceState = .idle
                    scheduleTransientHideIfNeeded()
                }
            }
            turnVisualPhase = directIntent ? .searchingContext : .observingContext
            voiceState = .processing
            ensureOverlayVisibleForVoiceFeedback()
            responseOverlayManager.showThinking()
            if directIntent {
                await waitForDirectClickPrewarm()
            }
            switch await performDirectClickFastPathIfPossible(
                transcript: transcript,
                intentIsDirect: directIntent,
                timing: timing,
                traceID: origin?.traceID,
                turnToken: turnToken
            ) {
            case .handled:
                return
            case let .miss(reason):
                timing.mark("fastpath_miss", reason: reason.rawValue)
                guard !Task.isCancelled else {
                    timing.mark("cancelled", reason: "before_runtime_fallback")
                    return
                }
                timing.mark("runtime_fallback_start", reason: reason.rawValue)
            }
            turnVisualPhase = .observingContext
            let (capturedContext, captureReason) = await resolveHeldScene(
                transcript: transcript,
                traceID: origin?.traceID
            )
            timing.mark(
                "context_capture",
                reason: captureReason,
                sourceDimensions: Self.telemetryDimensions(for: capturedContext.screenCaptures)
            )
            // ContextTrail append happens in Node ProductKernelRuntime on turn.start
            // (screenshot bytes stripped). Background samples use trail.observe.

            guard ownsVoiceTurn(turnToken) else { return }
            do {
                turnVisualPhase = .reasoning
                let response = try await respondThroughYishuRuntime(
                    transcript: transcript,
                    contextFrame: capturedContext.frame,
                    screenCaptures: capturedContext.screenCaptures,
                    timing: timing,
                    turnToken: turnToken
                )
                guard self.ownsVoiceTurn(turnToken) else { throw CancellationError() }
                try await presentVoiceResponse(
                    response.text,
                    transcript: response.presentationTranscript,
                    screenCaptures: response.allowsScreenEffects
                        ? capturedContext.screenCaptures
                        : [],
                    timing: timing,
                    speechAlreadyPresented: response.speechAlreadyPresented,
                    turnToken: turnToken
                )
            } catch is CancellationError {
                clearMemorySourceNotice()
                responseOverlayManager.hideOverlay()
            } catch {
                let failureReason: String
                if let runtimeError = error as? YishuAgentRuntimeClientError {
                    switch runtimeError {
                    case .turnTimedOut:
                        failureReason = "turn_timed_out"
                    case .turnFailed:
                        failureReason = "turn_failed"
                    default:
                        failureReason = "runtime_error"
                    }
                } else {
                    failureReason = "unknown"
                }
                timing.mark("runtime_failed", reason: failureReason)
                if freshStartAfterRejectedSteerIfNeeded(error, turnToken: turnToken) {
                    return
                }
                clearMemorySourceNotice()
                guard ownsVoiceTurn(turnToken) else { return }
                let actionResult = activeVoiceTurnToken == turnToken
                    ? activeTurnLastComputerActionResult
                    : nil
                let actionName = activeVoiceTurnToken == turnToken
                    ? activeTurnLastComputerActionName
                    : nil
                switch Self.runtimeFailureRecoveryRoute(
                    actionResult: actionResult,
                    runtimeIsRunning: yishuAgentRuntimeClient.isRunning
                ) {
                case .useActionReceipt:
                    guard let actionResult else { return }
                    // A direct action was already consumed. Do not spend a
                    // second model turn after Pi failed around its result.
                    activeTurnConsumedComputerAction = true
                    responseOverlayManager.showOverlayAndBeginStreaming()
                    do {
                        try await presentVoiceResponse(
                            Self.directActionConfirmation(
                                for: actionResult,
                                action: actionName
                            ),
                            transcript: transcript,
                            screenCaptures: capturedContext.screenCaptures,
                            timing: timing,
                            turnToken: turnToken
                        )
                    } catch is CancellationError {
                        clearMemorySourceNotice()
                        responseOverlayManager.hideOverlay()
                    } catch {
                        clearMemorySourceNotice()
                        responseOverlayManager.hideOverlay()
                    }
                    return
                case .restartRuntime:
                    // A crashed sidecar must not immediately fork product
                    // behavior into the legacy proxy. Re-enter the same
                    // Runtime/Kernel spine with fresh evidence first.
                    responseOverlayManager.hideOverlay()
                    timing.mark("runtime_restart", reason: "sidecar_not_running")
                    do {
                        let retryContext = await yishuContextFrameCollector.capture(
                            activeWindowOnly: Self.requiresCurrentPageNoteWindow(transcript)
                        )
                        timing.mark(
                            "context_capture",
                            reason: "runtime_restart",
                            sourceDimensions: Self.telemetryDimensions(for: retryContext.screenCaptures)
                        )
                        let response = try await respondThroughYishuRuntime(
                            transcript: transcript,
                            contextFrame: retryContext.frame,
                            screenCaptures: retryContext.screenCaptures,
                            timing: timing,
                            turnToken: turnToken
                        )
                        guard self.ownsVoiceTurn(turnToken) else { throw CancellationError() }
                        timing.mark("runtime_restart_complete", reason: "ok")
                        try await presentVoiceResponse(
                            response.text,
                            transcript: response.presentationTranscript,
                            screenCaptures: response.allowsScreenEffects
                                ? retryContext.screenCaptures
                                : [],
                            timing: timing,
                            speechAlreadyPresented: response.speechAlreadyPresented,
                            turnToken: turnToken
                        )
                        return
                    } catch is CancellationError {
                        clearMemorySourceNotice()
                        responseOverlayManager.hideOverlay()
                        return
                    } catch {
                        if freshStartAfterRejectedSteerIfNeeded(
                            error,
                            turnToken: turnToken
                        ) {
                            return
                        }
                        clearMemorySourceNotice()
                        responseOverlayManager.hideOverlay()
                        timing.mark("runtime_restart_complete", reason: "failed")
                    }
                case .surfaceFailure:
                    break
                }
                await presentRuntimeFailure(turnToken: turnToken, error: error)
            }

        }
    }

    static func rejectedSteerTranscript(from error: Error) -> String? {
        guard let runtimeError = error as? YishuAgentRuntimeClientError,
              case let .turnSteerRejected(message, _) = runtimeError else {
            return nil
        }
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func freshStartAfterRejectedSteerIfNeeded(
        _ error: Error,
        turnToken: UUID
    ) -> Bool {
        guard ownsVoiceTurn(turnToken),
              let transcript = Self.rejectedSteerTranscript(from: error) else {
            return false
        }
        clearMemorySourceNotice()
        responseOverlayManager.hideOverlay()
        // `runVoiceTurnTask` invalidates/cancels the rejected session and takes
        // a new ContextFrame before submitting this transcript exactly once.
        runVoiceTurnTask(transcript: transcript, origin: nil)
        return true
    }

    /// Handles an explicit, visually named click without paying the latency of
    /// a full Pi/vision-model turn. Local Vision OCR resolves the label and the
    /// existing Accessibility actuator performs and verifies the press.
    private func recordShadowPartial(traceID: String) {
        partialTranscriptCount += 1
        let now = DispatchTime.now().uptimeNanoseconds
        if firstPartialTranscriptAt == nil {
            firstPartialTranscriptAt = now
        }
        let totalMS = firstPartialTranscriptAt.map {
            Double(now - $0) / 1_000_000.0
        } ?? 0
        Self.logVoicePhase(
            turnID: traceID,
            phase: "asr_partial",
            deltaMS: 0,
            totalMS: totalMS,
            reason: "asr_partial_count_\(partialTranscriptCount)"
        )
    }

    private func startHeldSceneCapture(traceID: String) {
        heldSceneTask?.cancel()
        heldSceneCache = nil
        let startedAt = Date()
        let capturedAtUptimeNanoseconds = DispatchTime.now().uptimeNanoseconds
        let identity = yishuContextFrameCollector.liveSceneIdentity(
            displayFingerprint: Self.currentDisplayFingerprint()
        )
        heldSceneTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let context = await self.yishuContextFrameCollector.capture(pointerSince: startedAt)
            guard !Task.isCancelled else { return }
            self.heldSceneCache = HeldSceneCache(
                context: context,
                capturedAtUptimeNanoseconds: capturedAtUptimeNanoseconds,
                startedAt: startedAt,
                frontmostProcessIdentifier: identity.frontmostProcessIdentifier,
                displayFingerprint: identity.displayFingerprint,
                activeWindowNumber: identity.activeWindowNumber,
                traceID: traceID
            )
        }
    }

    private func clearHeldSceneCapture() {
        heldSceneTask?.cancel()
        heldSceneTask = nil
        heldSceneCache = nil
    }

    private func resolveHeldScene(
        transcript: String,
        traceID: String?
    ) async -> (YishuCapturedContext, String) {
        if let heldSceneTask {
            await heldSceneTask.value
        }
        let held = heldSceneCache
        let current = yishuContextFrameCollector.liveSceneIdentity(
            displayFingerprint: Self.currentDisplayFingerprint()
        )
        let decision = YishuHeldScenePolicy.decide(
            requiresActiveWindowOnly: Self.requiresCurrentPageNoteWindow(transcript),
            heldTraceID: held?.traceID,
            turnTraceID: traceID,
            heldFrontmost: held?.frontmostProcessIdentifier,
            currentFrontmost: current.frontmostProcessIdentifier,
            heldDisplay: held?.displayFingerprint ?? "",
            currentDisplay: current.displayFingerprint,
            heldWindowNumber: held?.activeWindowNumber,
            currentWindowNumber: current.activeWindowNumber,
            capturedAt: held?.capturedAtUptimeNanoseconds,
            screenshotCapturedAt: held?.context.screenshotCapturedAtUptimeNanoseconds,
            now: DispatchTime.now().uptimeNanoseconds
        )
        defer { clearHeldSceneCapture() }
        switch decision {
        case .reuse:
            if let held {
                let refreshed = yishuContextFrameCollector.refreshLiveAttention(
                    onto: held.context,
                    pointerSince: held.startedAt
                )
                return (refreshed, decision.rawValue)
            }
            let fresh = await yishuContextFrameCollector.capture()
            return (fresh, YishuHeldSceneDecision.recaptureMissingBasis.rawValue)
        case .recaptureActiveWindow:
            let fresh = await yishuContextFrameCollector.capture(
                activeWindowOnly: true,
                pointerSince: held?.startedAt
            )
            return (fresh, decision.rawValue)
        case .recaptureSceneChanged, .recaptureStale, .recaptureMissingBasis:
            let fresh = await yishuContextFrameCollector.capture(
                pointerSince: held?.startedAt
            )
            return (fresh, decision.rawValue)
        }
    }

    private func startDirectClickPrewarmIfEligible(_ partialText: String, traceID: String) {
        guard !didAttemptDirectClickPrewarm,
              YishuDirectClickResolver.isDirectClickIntent(partialText),
              let resolutionKey = YishuDirectClickResolver.resolutionKey(for: partialText) else {
            return
        }

        didAttemptDirectClickPrewarm = true
        directClickPrewarmTraceID = traceID
        directClickPrewarmTask?.cancel()
        directClickPrewarmTask = Task { [weak self] in
            guard let self else { return }
            do {
                // Sample the basis before capture so an app/display switch
                // during ScreenCaptureKit work is detected, not hidden by a
                // post-capture-only snapshot.
                let capturedAtUptimeNanoseconds = DispatchTime.now().uptimeNanoseconds
                let frontmostBeforeCapture = NSWorkspace.shared.frontmostApplication?.processIdentifier
                let displayFingerprintBeforeCapture = Self.currentDisplayFingerprint()
                guard frontmostBeforeCapture != nil,
                      !displayFingerprintBeforeCapture.isEmpty else {
                    return
                }
                let captures = try await CompanionScreenCaptureUtility.captureAllScreensAsJPEG()
                guard !Task.isCancelled else { return }
                let displayFingerprintFromCaptures = Self.displayFingerprint(for: captures)
                let frontmostAfterCapture = NSWorkspace.shared.frontmostApplication?.processIdentifier
                let displayFingerprintAfterCapture = Self.currentDisplayFingerprint()
                guard Self.isValidDirectClickPrewarmCaptureBasis(
                    expectedFrontmostProcessIdentifier: frontmostBeforeCapture,
                    currentFrontmostProcessIdentifier: frontmostAfterCapture,
                    expectedDisplayFingerprint: displayFingerprintBeforeCapture,
                    capturedDisplayFingerprint: displayFingerprintFromCaptures,
                    currentDisplayFingerprint: displayFingerprintAfterCapture
                ), Self.isValidDirectClickPrewarmBasis(
                    capturedAtUptimeNanoseconds: capturedAtUptimeNanoseconds,
                    nowUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds,
                    expectedFrontmostProcessIdentifier: frontmostBeforeCapture,
                    currentFrontmostProcessIdentifier: frontmostAfterCapture,
                    expectedDisplayFingerprint: displayFingerprintBeforeCapture,
                    currentDisplayFingerprint: displayFingerprintAfterCapture
                ) else {
                    return
                }

                let screens = captures.enumerated().map { index, capture in
                    YishuDirectClickScreen(
                        imageData: capture.imageData,
                        screenshotWidthInPixels: capture.screenshotWidthInPixels,
                        screenshotHeightInPixels: capture.screenshotHeightInPixels,
                        screenNumber: index + 1
                    )
                }
                guard let match = await YishuDirectClickResolver.resolve(
                    utterance: partialText,
                    screens: screens
                ), !Task.isCancelled else {
                    return
                }
                let nowAfterOCR = DispatchTime.now().uptimeNanoseconds
                guard Self.isValidDirectClickPrewarmBasis(
                    capturedAtUptimeNanoseconds: capturedAtUptimeNanoseconds,
                    nowUptimeNanoseconds: nowAfterOCR,
                    expectedFrontmostProcessIdentifier: frontmostBeforeCapture,
                    currentFrontmostProcessIdentifier: NSWorkspace.shared.frontmostApplication?.processIdentifier,
                    expectedDisplayFingerprint: displayFingerprintBeforeCapture,
                    currentDisplayFingerprint: Self.currentDisplayFingerprint()
                ) else {
                    return
                }

                let cache = DirectClickPrewarmCache(
                    resolutionKey: resolutionKey,
                    screenCaptures: captures,
                    match: match,
                    capturedAtUptimeNanoseconds: capturedAtUptimeNanoseconds,
                    frontmostProcessIdentifier: frontmostBeforeCapture,
                    displayFingerprint: displayFingerprintBeforeCapture,
                    traceID: traceID
                )
                guard !Task.isCancelled else { return }
                self.directClickPrewarmCache = cache
            } catch {
                // Prewarm is an optional latency optimization. The final
                // direct-click path performs its normal capture/OCR on miss.
            }
        }
    }

    private func waitForDirectClickPrewarm() async {
        guard let directClickPrewarmTask else { return }
        await directClickPrewarmTask.value
    }

    private func consumeValidDirectClickPrewarm(
        transcript: String,
        traceID: String?
    ) -> DirectClickPrewarmCache? {
        defer { directClickPrewarmCache = nil }
        guard let traceID,
              let cache = directClickPrewarmCache,
              cache.traceID == traceID,
              let resolutionKey = YishuDirectClickResolver.resolutionKey(for: transcript),
              resolutionKey == cache.resolutionKey else {
            return nil
        }

        let now = DispatchTime.now().uptimeNanoseconds
        guard Self.isValidDirectClickPrewarmBasis(
            capturedAtUptimeNanoseconds: cache.capturedAtUptimeNanoseconds,
            nowUptimeNanoseconds: now,
            expectedFrontmostProcessIdentifier: cache.frontmostProcessIdentifier,
            currentFrontmostProcessIdentifier: NSWorkspace.shared.frontmostApplication?.processIdentifier,
            expectedDisplayFingerprint: cache.displayFingerprint,
            currentDisplayFingerprint: Self.currentDisplayFingerprint()
        ) else {
            return nil
        }
        return cache
    }

    /// Pure basis check shared by the post-OCR prewarm guard and cache reuse.
    /// It intentionally requires a known frontmost owner and computes age from
    /// the instant the screen capture completed, not from OCR completion.
    static func isValidDirectClickPrewarmBasis(
        capturedAtUptimeNanoseconds: UInt64,
        nowUptimeNanoseconds: UInt64,
        expectedFrontmostProcessIdentifier: pid_t?,
        currentFrontmostProcessIdentifier: pid_t?,
        expectedDisplayFingerprint: String,
        currentDisplayFingerprint: String
    ) -> Bool {
        guard nowUptimeNanoseconds >= capturedAtUptimeNanoseconds,
              nowUptimeNanoseconds - capturedAtUptimeNanoseconds <= 500_000_000,
              let expectedFrontmostProcessIdentifier,
              let currentFrontmostProcessIdentifier,
              expectedFrontmostProcessIdentifier == currentFrontmostProcessIdentifier,
              expectedDisplayFingerprint == currentDisplayFingerprint else {
            return false
        }
        return true
    }

    /// Verifies that the capture itself still represents the pre-capture
    /// frontmost/display basis. This catches a switch during ScreenCaptureKit
    /// before OCR is allowed to populate the prewarm cache.
    static func isValidDirectClickPrewarmCaptureBasis(
        expectedFrontmostProcessIdentifier: pid_t?,
        currentFrontmostProcessIdentifier: pid_t?,
        expectedDisplayFingerprint: String,
        capturedDisplayFingerprint: String,
        currentDisplayFingerprint: String
    ) -> Bool {
        guard let expectedFrontmostProcessIdentifier,
              let currentFrontmostProcessIdentifier,
              expectedFrontmostProcessIdentifier == currentFrontmostProcessIdentifier,
              !expectedDisplayFingerprint.isEmpty,
              expectedDisplayFingerprint == capturedDisplayFingerprint,
              expectedDisplayFingerprint == currentDisplayFingerprint else {
            return false
        }
        return true
    }

    private static func displayFingerprint(for captures: [CompanionScreenCapture]) -> String {
        captures
            .map { capture in
                let frame = capture.displayFrame
                return "\(frame.origin.x),\(frame.origin.y),\(frame.width),\(frame.height)"
            }
            .sorted()
            .joined(separator: ";")
    }

    private static func currentDisplayFingerprint() -> String {
        NSScreen.screens
            .map { screen in
                let frame = screen.frame
                return "\(frame.origin.x),\(frame.origin.y),\(frame.width),\(frame.height)"
            }
            .sorted()
            .joined(separator: ";")
    }

    private func performDirectClickFastPathIfPossible(
        transcript: String,
        intentIsDirect: Bool,
        timing: VoiceTurnTiming,
        traceID: String?,
        turnToken: UUID
    ) async -> DirectClickFastPathOutcome {
        guard intentIsDirect else {
            return .miss(.intentNotDirect)
        }
        guard ownsVoiceTurn(turnToken) else {
            return .miss(.cancelled)
        }

        if let runningApplication = YishuDirectClickResolver.matchingRunningApplication(for: transcript) {
            return await performNamedApplicationClick(
                running: runningApplication,
                applicationURL: nil,
                transcript: transcript,
                timing: timing,
                turnToken: turnToken
            )
        }
        if let applicationURL = YishuDirectClickResolver.launchableApplicationURL(for: transcript) {
            return await performNamedApplicationClick(
                running: nil,
                applicationURL: applicationURL,
                transcript: transcript,
                timing: timing,
                turnToken: turnToken
            )
        }

        let prewarmedCache = consumeValidDirectClickPrewarm(
            transcript: transcript,
            traceID: traceID
        )
        let screenCaptures: [CompanionScreenCapture]
        let match: YishuDirectClickMatch
        if let prewarmedCache {
            screenCaptures = prewarmedCache.screenCaptures
            match = prewarmedCache.match
            timing.mark(
                "prewarm_reuse",
                reason: "target_frame_fresh",
                sourceDimensions: Self.telemetryDimensions(for: screenCaptures)
            )
        } else {
            do {
                screenCaptures = try await CompanionScreenCaptureUtility.captureAllScreensAsJPEG()
            } catch {
                let reason: DirectClickFastPathMissReason = ownsVoiceTurn(turnToken)
                    ? .screenCaptureFailed
                    : .cancelled
                timing.mark("screen_capture", reason: reason.rawValue)
                return .miss(reason)
            }
            guard ownsVoiceTurn(turnToken) else { return .miss(.cancelled) }
            let sourceDimensions = Self.telemetryDimensions(for: screenCaptures)
            timing.mark("screen_capture", reason: "ok", sourceDimensions: sourceDimensions)

            let screens = screenCaptures.enumerated().map { index, capture in
                YishuDirectClickScreen(
                    imageData: capture.imageData,
                    screenshotWidthInPixels: capture.screenshotWidthInPixels,
                    screenshotHeightInPixels: capture.screenshotHeightInPixels,
                    screenNumber: index + 1
                )
            }
            timing.mark("ocr_resolve_start", reason: "started", sourceDimensions: sourceDimensions)
            if let resolvedMatch = await YishuDirectClickResolver.resolve(
                utterance: transcript,
                screens: screens
            ), ownsVoiceTurn(turnToken) {
                match = resolvedMatch
                timing.mark("ocr_resolve", reason: "match", sourceDimensions: sourceDimensions)
            } else if !ownsVoiceTurn(turnToken) {
                timing.mark("ocr_resolve", reason: DirectClickFastPathMissReason.cancelled.rawValue, sourceDimensions: sourceDimensions)
                return .miss(.cancelled)
            } else {
                let reason: DirectClickFastPathMissReason = .ocrNoMatch
                timing.mark("ocr_resolve", reason: reason.rawValue, sourceDimensions: sourceDimensions)
                return .miss(reason)
            }
        }

        let sourceDimensions = Self.telemetryDimensions(for: screenCaptures)
        guard ownsVoiceTurn(turnToken) else { return .miss(.cancelled) }

        let captureFrameID = UUID().uuidString
        let request = YishuComputerActionRequest(
            requestId: UUID(),
            traceId: UUID(),
            actionId: UUID(),
            action: "left_click",
            x: match.x,
            y: match.y,
            screen: match.screenNumber,
            label: match.label,
            intentId: UUID().uuidString,
            attemptId: UUID().uuidString,
            basisFrameId: captureFrameID,
            effectClass: "activate"
        )
        // The OCR target has been consumed once the actuator is invoked. Keep
        // this state through presentation so a missing POINT tag can never
        // downgrade a completed fast-path attempt into a model retry/failure.
        activeTurnConsumedComputerAction = true
        activeTurnEffectInFlight = true
        timing.mark("action_dispatch", reason: "ocr_match", sourceDimensions: sourceDimensions)
        let result = await YishuComputerUseActuator.perform(
            request,
            screenCaptures: screenCaptures,
            authorizationFence: { [weak self] in
                self?.ownsVoiceTurn(turnToken) == true
            }
        )
        guard ownsVoiceTurn(turnToken) else { return .handled(result) }
        activeTurnEffectInFlight = false
        activeTurnLastComputerActionResult = result
        activeTurnLastComputerActionName = request.action
        recordComputerActionResult(result, action: request.action)
        timing.mark(
            "actuator_readback",
            reason: result.code.rawValue,
            sourceDimensions: sourceDimensions,
            receiptID: result.receiptId
        )
        Self.logComputerActionTelemetry(
            route: "ocr_fast_path",
            request: request,
            result: result,
            sourceCapture: screenCaptures.indices.contains(match.screenNumber - 1)
                ? screenCaptures[match.screenNumber - 1]
                : nil
        )

        let confirmation = Self.directActionConfirmation(
            for: result,
            action: request.action
        )
        print(
            "🖱️ 奕枢 direct action handled "
                + "status=\(result.status.rawValue) "
                + "method=\(result.method.rawValue) "
                + "code=\(result.code.rawValue)"
        )
        guard ownsVoiceTurn(turnToken) else { return .handled(result) }
        do {
            try await presentVoiceResponse(
                confirmation,
                transcript: transcript,
                screenCaptures: screenCaptures,
                timing: timing,
                turnToken: turnToken
            )
        } catch is CancellationError {
            responseOverlayManager.hideOverlay()
        } catch {
            // The click already happened. A presentation failure must not send
            // the same action through the slower model path a second time.
        }
        return .handled(result)
    }

    /// Clicking a named app (微信 / WeChat) is an activate/open, not OCR+Grok.
    private func performNamedApplicationClick(
        running: NSRunningApplication?,
        applicationURL: URL?,
        transcript: String,
        timing: VoiceTurnTiming,
        turnToken: UUID
    ) async -> DirectClickFastPathOutcome {
        guard ownsVoiceTurn(turnToken) else { return .miss(.cancelled) }
        timing.mark("app_resolve", reason: "name_match")
        activeTurnConsumedComputerAction = true
        activeTurnEffectInFlight = true
        timing.mark("action_dispatch", reason: "app_name_match")

        let activated: NSRunningApplication?
        if let running {
            running.unhide()
            running.activate(options: [.activateIgnoringOtherApps])
            activated = running
        } else if let applicationURL {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            do {
                activated = try await NSWorkspace.shared.openApplication(
                    at: applicationURL,
                    configuration: configuration
                )
            } catch {
                activated = nil
            }
        } else {
            activated = nil
        }

        guard ownsVoiceTurn(turnToken) else { return .miss(.cancelled) }
        let frontmost = NSWorkspace.shared.frontmostApplication
        let verified = activated != nil
            && frontmost?.processIdentifier == activated?.processIdentifier
        let succeeded = activated != nil
        let result = YishuComputerActionResult(
            succeeded: succeeded,
            verified: verified,
            message: succeeded ? "Activated named application." : "Named application was not activated.",
            evidence: "method=native_command;route=app_name",
            status: verified ? .verified : (succeeded ? .delivered : .failed),
            method: .nativeCommand,
            code: verified ? .verifiedAccessibility : (succeeded ? .axPressUnverified : .runtimeError)
        )
        activeTurnEffectInFlight = false
        activeTurnLastComputerActionResult = result
        activeTurnLastComputerActionName = "left_click"
        recordComputerActionResult(result, action: "left_click")
        timing.mark(
            "actuator_readback",
            reason: result.code.rawValue,
            receiptID: result.receiptId
        )
        Self.logComputerActionTelemetry(
            route: "app_name",
            request: YishuComputerActionRequest(
                requestId: UUID(),
                traceId: UUID(),
                actionId: UUID(),
                action: "left_click",
                x: 0,
                y: 0
            ),
            result: result,
            sourceCapture: nil
        )
        let confirmation = Self.directActionConfirmation(for: result, action: "left_click")
        guard ownsVoiceTurn(turnToken) else { return .handled(result) }
        do {
            try await presentVoiceResponse(
                confirmation,
                transcript: transcript,
                screenCaptures: [],
                timing: timing,
                turnToken: turnToken
            )
        } catch is CancellationError {
            responseOverlayManager.hideOverlay()
        } catch {}
        return .handled(result)
    }

    /// Sample app/window/AX into ContextTrail every ~5s without screenshots.
    private func startContextTrailSampling() {
        trailSampleTask?.cancel()
        trailSampleTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.observeContextTrailSampleIfAllowed()
                try? await Task.sleep(nanoseconds: self.trailSampleIntervalNanoseconds)
            }
        }
    }

    private func observeContextTrailSampleIfAllowed() {
        // Private sessions must not collect the evidence locally and rely on a
        // later Node filter. The trust boundary sits before Swift collection.
        guard sessionScope.kind != .privateSession,
              yishuAgentRuntimeClient.isRunning else { return }
        let sample = yishuContextFrameCollector.captureTrailSample()
        do {
            try yishuAgentRuntimeClient.observeTrail(contextFrame: sample)
        } catch {
            // Runtime may be restarting; next interval retries.
        }
    }

    private func respondThroughYishuRuntime(
        transcript: String,
        contextFrame: YishuContextFrame,
        screenCaptures: [CompanionScreenCapture],
        timing: VoiceTurnTiming? = nil,
        turnToken: UUID
    ) async throws -> YishuRuntimeVoiceResponse {
        guard ownsVoiceTurn(turnToken) else { throw CancellationError() }
        try contextFrame.validate()
        if !yishuAgentRuntimeClient.isRunning {
            runtimeVisualPhase = .connecting
            agentRuntimeAvailability = .starting
            do {
                try yishuAgentRuntimeClient.start()
                armAgentRuntimeReadyWatchdog()
            } catch {
                // A synchronous launch failure is not an active connection
                // attempt. The outer recovery path may retry with fresh evidence.
                runtimeVisualPhase = .idle
                agentRuntimeAvailability = .stopped
                throw error
            }
            startContextTrailSampling()
        }

        let turn = try yishuAgentRuntimeClient.startTurn(
            utterance: transcript,
            contextFrame: contextFrame,
            modelProvider: selectedModelProvider,
            model: selectedModel
        )
        activeRuntimeRequestId = turn.requestId
        activeRuntimePresentationTranscript = transcript
        responseOverlayManager.showOverlayAndBeginStreaming()

        defer {
            if activeRuntimeRequestId == turn.requestId {
                activeRuntimeRequestId = nil
                activeRuntimePresentationTranscript = nil
                activeTurnEffectInFlight = false
            }
        }

        var presentationReducer = YishuRuntimePresentationReducer()
        var usedMemories: [YishuMemoryUsedItem] = []
        var isDirectClickTurn = YishuDirectClickResolver.isDirectClickIntent(transcript)
        var presentationTranscript = transcript
        var didStartStreamingSpeech = false
        var didSpeakSearchCover = false
        var didSpeakAnswer = false
        func makeSentenceSpeechPipeline(for utterance: String) -> YishuSentenceSpeechPipeline? {
            guard YishuSentenceSpeechPolicy.allowsStreaming(for: utterance) else {
                return nil
            }
            let pipeline = YishuSentenceSpeechPipeline(
                speaker: { [weak self] sentence in
                    guard let self, self.ownsVoiceTurn(turnToken) else {
                        throw CancellationError()
                    }
                    let ttsText = Self.speechText(from: sentence)
                    guard !ttsText.isEmpty else { throw CancellationError() }
                    self.stopCoverSpeech()
                    try await self.elevenLabsTTSClient.speakText(
                        ttsText,
                        speed: self.speechSpeed
                    )
                },
                stopPlayback: { [weak self] in
                    self?.elevenLabsTTSClient.stopPlayback()
                }
            )
            activeSentenceSpeechPipeline = pipeline
            return pipeline
        }
        var sentenceSpeechPipeline = makeSentenceSpeechPipeline(for: transcript)
        var lastPresentedText = ""
        defer {
            stopCoverSpeech()
            if let sentenceSpeechPipeline,
               activeSentenceSpeechPipeline === sentenceSpeechPipeline {
                sentenceSpeechPipeline.cancel()
                activeSentenceSpeechPipeline = nil
            }
        }
        // Clear prior turn's memory source so unrelated answers cannot inherit it.
        clearMemorySourceNotice()
        try await withTaskCancellationHandler {
            for try await event in turn.events {
                guard activeRuntimeRequestId == turn.requestId,
                      ownsVoiceTurn(turnToken) else {
                    continue
                }
                let eventGeneration = event.generation
                let presentationAdvance = presentationReducer.advancePresentation(
                    to: eventGeneration
                )
                guard presentationAdvance != .stale else { continue }
                if presentationAdvance == .advanced {
                    sentenceSpeechPipeline?.cancel()
                    if let sentenceSpeechPipeline,
                       activeSentenceSpeechPipeline === sentenceSpeechPipeline {
                        activeSentenceSpeechPipeline = nil
                    }
                    usedMemories = []
                    presentationTranscript = activeRuntimePresentationTranscript ?? transcript
                    isDirectClickTurn = YishuDirectClickResolver.isDirectClickIntent(
                        presentationTranscript
                    )
                    didStartStreamingSpeech = false
                    didSpeakSearchCover = false
                    didSpeakAnswer = false
                    stopCoverSpeech()
                    activeTurnConsumedComputerAction = false
                    activeTurnLastComputerActionResult = nil
                    activeTurnLastComputerActionName = nil
                    activeTurnEffectInFlight = false
                    clearMemorySourceNotice()
                    lastPresentedText = ""
                    responseOverlayManager.showOverlayAndBeginStreaming()
                    sentenceSpeechPipeline = makeSentenceSpeechPipeline(
                        for: presentationTranscript
                    )
                }
                switch event {
                case let .started(generation):
                    guard generation == presentationReducer.generation else { continue }
                    updateTurnVisualPhase(for: event)
                case let .toolStarted(name, generation):
                    guard generation == presentationReducer.generation else { continue }
                    updateTurnVisualPhase(for: event)
                    if beginSearchCoverSpeech(
                        toolName: name,
                        didSpeakCover: didSpeakSearchCover,
                        didSpeakAnswer: didSpeakAnswer,
                        hasVisibleAnswerText: !presentationReducer.accumulatedText
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                            .isEmpty,
                        turnToken: turnToken
                    ) {
                        didSpeakSearchCover = true
                    }
                case .toolCompleted:
                    updateTurnVisualPhase(for: event)
                case let .memoryUsed(items, _):
                    updateTurnVisualPhase(for: event)
                    usedMemories = items
                    applyMemorySourceNotice(Self.formatMemorySourceNotice(items))
                case let .computerActionRequested(request, _):
                    guard activeRuntimeRequestId == turn.requestId,
                          ownsVoiceTurn(turnToken) else {
                        continue
                    }
                    stopCoverSpeech()
                    if let sentenceSpeechPipeline {
                        sentenceSpeechPipeline.cancel()
                        if activeSentenceSpeechPipeline === sentenceSpeechPipeline {
                            activeSentenceSpeechPipeline = nil
                        }
                    }
                    // Consume the runtime action before awaiting the actuator;
                    // the final model text must not replay it via a POINT tag.
                    activeTurnConsumedComputerAction = true
                    activeTurnEffectInFlight = true
                    updateTurnVisualPhase(for: event)
                    timing?.mark(
                        "pi_action_arrival",
                        reason: "computer_action",
                        sourceDimensions: Self.telemetryDimensions(for: screenCaptures)
                    )
                    timing?.mark(
                        "action_dispatch",
                        reason: "pi_runtime",
                        sourceDimensions: Self.telemetryDimensions(for: screenCaptures)
                    )
                    let result = await YishuComputerUseActuator.perform(
                        request,
                        screenCaptures: screenCaptures,
                        numberedTargets: YishuNumberedAccessibility.liveTargets(
                            fallback: contextFrame.numberedTargets
                        ),
                        authorizationFence: { [weak self] in
                            self?.activeRuntimeRequestId == turn.requestId
                                && self?.ownsVoiceTurn(turnToken) == true
                        }
                    )
                    let stillOwned = activeRuntimeRequestId == turn.requestId
                        && ownsVoiceTurn(turnToken)
                    if stillOwned {
                        activeTurnEffectInFlight = false
                        activeTurnLastComputerActionResult = result
                        activeTurnLastComputerActionName = request.action
                        recordComputerActionResult(result, action: request.action)
                    }
                    timing?.mark(
                        "actuator_readback",
                        reason: result.code.rawValue,
                        sourceDimensions: Self.telemetryDimensions(for: screenCaptures),
                        receiptID: result.receiptId
                    )
                    Self.logComputerActionTelemetry(
                        route: "pi_runtime",
                        request: request,
                        result: result,
                        sourceCapture: Self.sourceCapture(for: request, in: screenCaptures)
                    )
                    // Receipt first. Recapture JPEG/AX on this actor blocked the port.
                    try yishuAgentRuntimeClient.completeComputerAction(request, result: result)
                    guard stillOwned else { continue }
                case let .responseDelta(delta, _):
                    updateTurnVisualPhase(for: event)
                    presentationReducer.appendCurrentDelta(delta)
                    // Direct-click turns stay buffered until the action/result
                    // decision is known; this prevents model tool markup from
                    // flashing in the overlay before `presentVoiceResponse`.
                    let presented = Self.scrubToolMarkup(
                        from: presentationReducer.accumulatedText
                    )
                    if !isDirectClickTurn {
                        responseOverlayManager.updateStreamingText(presented)
                    }
                    let speechDelta: String
                    if presented.hasPrefix(lastPresentedText) {
                        speechDelta = String(presented.dropFirst(lastPresentedText.count))
                    } else {
                        speechDelta = ""
                    }
                    lastPresentedText = presented
                    if let sentenceSpeechPipeline,
                       activeSentenceSpeechPipeline === sentenceSpeechPipeline,
                       !activeTurnConsumedComputerAction,
                       sentenceSpeechPipeline.consume(speechDelta) > 0 {
                        didSpeakAnswer = true
                        stopCoverSpeech()
                        if !didStartStreamingSpeech {
                            didStartStreamingSpeech = true
                            voiceState = .responding
                            timing?.mark("tts_start", reason: "streaming_sentence")
                        }
                    }
                case let .completed(text, _, _):
                    updateTurnVisualPhase(for: event)
                    stopCoverSpeech()
                    presentationReducer.completeCurrent(with: text)
                case .cancelled:
                    updateTurnVisualPhase(for: event)
                    throw CancellationError()
                }
            }
        } onCancel: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.cancelActiveSentenceSpeechPipeline()
                guard self.activeRuntimeRequestId == turn.requestId else { return }
                try? self.yishuAgentRuntimeClient.cancelTurn(
                    requestId: turn.requestId,
                    reason: "task-cancelled"
                )
            }
        }

        try Task.checkCancellation()
        let finalText = Self.scrubToolMarkup(
            from: presentationReducer.authoritativeText
        )
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !finalText.isEmpty else {
            clearMemorySourceNotice()
            throw YishuAgentRuntimeClientError.turnFailed
        }
        let pointingParse = Self.parsePointingCoordinates(from: finalText)
        let spokenOverlayText = pointingParse.spokenText
        if !isDirectClickTurn, presentationTranscript == transcript {
            beginObservationalPointing(
                from: pointingParse,
                screenCaptures: screenCaptures,
                isDirectClickTurn: isDirectClickTurn
            )
        }
        // Only keep a source line when this turn actually used memory.
        if usedMemories.isEmpty {
            clearMemorySourceNotice()
        } else {
            applyMemorySourceNotice(Self.formatMemorySourceNotice(usedMemories))
        }
        if !isDirectClickTurn {
            responseOverlayManager.updateStreamingText(spokenOverlayText)
        }
        turnVisualPhase = .shapingOutput
        var speechAlreadyPresented = false
        if let sentenceSpeechPipeline,
           activeSentenceSpeechPipeline === sentenceSpeechPipeline,
           !activeTurnConsumedComputerAction {
            if !didStartStreamingSpeech {
                voiceState = .responding
                timing?.mark("tts_start", reason: "final_sentence")
            }
            speechAlreadyPresented = await sentenceSpeechPipeline.finish(
                authoritativeText: spokenOverlayText
            )
            if activeSentenceSpeechPipeline === sentenceSpeechPipeline {
                activeSentenceSpeechPipeline = nil
            }
            timing?.mark(
                "tts_complete",
                reason: speechAlreadyPresented ? "streaming_ok" : "streaming_skipped"
            )
        }
        return YishuRuntimeVoiceResponse(
            text: finalText,
            speechAlreadyPresented: speechAlreadyPresented,
            presentationTranscript: presentationTranscript,
            allowsScreenEffects: presentationTranscript == transcript
        )
    }

    /// Drop panel + bubble source together. Call on every context boundary.
    func clearMemorySourceNotice() {
        memorySourceNotice = nil
        responseOverlayManager.updateMemorySourceText(nil)
    }

    private func applyMemorySourceNotice(_ notice: String) {
        let trimmed = notice.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            clearMemorySourceNotice()
            return
        }
        memorySourceNotice = trimmed
        responseOverlayManager.updateMemorySourceText(trimmed)
    }

    /// Short user-visible source line: which memory, when saved, and how it was saved.
    static func formatMemorySourceNotice(_ items: [YishuMemoryUsedItem]) -> String {
        YishuMemorySourcePolicy.formatNotice(items)
    }

    /// Pi is the only product brain. A failed Runtime turn is surfaced
    /// honestly instead of silently forking the conversation through a second model loop.
    private func presentRuntimeFailure(turnToken: UUID, error: Error) async {
        guard ownsVoiceTurn(turnToken) else { return }
        let message = Self.spokenRuntimeFailureMessage(for: error)
        turnVisualPhase = .shapingOutput
        voiceState = .responding
        ensureOverlayVisibleForVoiceFeedback()
        responseOverlayManager.showStaticMessage(message, autoHideAfter: 10)
        guard ownsVoiceTurn(turnToken) else { return }
        do {
            try await elevenLabsTTSClient.speakText(message, speed: speechSpeed)
        } catch {
            print("⚠️ 奕枢 Runtime failure notice TTS unavailable")
        }
    }

    static let genericRuntimeFailureMessage = "这轮没有完成。你再说一遍，或者换个说法。"

    static func spokenRuntimeFailureMessage(for error: Error) -> String {
        if let runtimeError = error as? YishuAgentRuntimeClientError,
           let description = runtimeError.errorDescription,
           !description.isEmpty {
            return description
        }
        return genericRuntimeFailureMessage
    }

    private func presentVoiceResponse(
        _ fullResponseText: String,
        transcript: String,
        screenCaptures: [CompanionScreenCapture],
        timing: VoiceTurnTiming? = nil,
        speechAlreadyPresented: Bool = false,
        turnToken: UUID
    ) async throws {
        guard ownsVoiceTurn(turnToken) else { throw CancellationError() }

        // Visual surfaces and history consume the same scrubbed text. TTS
        // derives a separate readable version later so links remain visible
        // without being spelled out aloud.
        let safeResponseText = Self.scrubToolMarkup(from: fullResponseText)
        turnVisualPhase = .shapingOutput
        let parseResult = Self.parsePointingCoordinates(from: safeResponseText)
        let isDirectClickTurn = YishuDirectClickResolver.isDirectClickIntent(transcript)
        var spokenText = parseResult.spokenText

        if Self.shouldUseDirectClickFailure(
            transcript: transcript,
            coordinate: parseResult.coordinate,
            actionConsumed: activeTurnConsumedComputerAction
        ) {
            spokenText = Self.directClickFailureMessage
            detectedElementScreenLocation = nil
            detectedElementDisplayFrame = nil
            voiceState = .responding
        } else if isDirectClickTurn,
                  !activeTurnConsumedComputerAction,
                  let pointCoordinate = parseResult.coordinate {
            activeTurnConsumedComputerAction = true
            activeTurnEffectInFlight = true
            turnVisualPhase = .performingAction
            let request = YishuComputerActionRequest(
                requestId: UUID(),
                traceId: UUID(),
                actionId: UUID(),
                action: "left_click",
                x: Double(pointCoordinate.x),
                y: Double(pointCoordinate.y),
                screen: parseResult.screenNumber,
                label: parseResult.elementLabel
            )
            timing?.mark(
                "action_dispatch",
                reason: "point_tag",
                sourceDimensions: Self.telemetryDimensions(for: screenCaptures)
            )
            let result = await YishuComputerUseActuator.perform(
                request,
                screenCaptures: screenCaptures,
                authorizationFence: { [weak self] in
                    self?.ownsVoiceTurn(turnToken) == true
                }
            )
            guard ownsVoiceTurn(turnToken) else { throw CancellationError() }
            activeTurnEffectInFlight = false
            turnVisualPhase = .confirmingToolResult
            activeTurnLastComputerActionResult = result
            activeTurnLastComputerActionName = request.action
            recordComputerActionResult(result, action: request.action)
            timing?.mark(
                "actuator_readback",
                reason: result.code.rawValue,
                sourceDimensions: Self.telemetryDimensions(for: screenCaptures),
                receiptID: result.receiptId
            )
            Self.logComputerActionTelemetry(
                route: "local_vision",
                request: request,
                result: result,
                sourceCapture: Self.sourceCapture(for: request, in: screenCaptures)
            )
            spokenText = Self.directActionConfirmation(
                for: result,
                action: request.action
            )
            detectedElementScreenLocation = nil
            detectedElementDisplayFrame = nil
            voiceState = .responding
        } else if beginObservationalPointing(
            from: parseResult,
            screenCaptures: screenCaptures,
            isDirectClickTurn: isDirectClickTurn
        ) {
            print("🎯 奕枢 pointing target resolved")
        } else {
            print("🎯 奕枢 response has no pointing target")
        }

        // Runtime/local streaming may have been buffered for a direct click;
        // publish only the scrubbed final state before history and speech.
        guard ownsVoiceTurn(turnToken) else { throw CancellationError() }
        responseOverlayManager.updateStreamingText(spokenText)
        turnVisualPhase = .shapingOutput
        // The spoken answer begins here. Previously this flipped only after
        // playback completed, making the visible state lag behind the voice.
        voiceState = .responding
        timing?.mark(
            "overlay",
            reason: "updated",
            sourceDimensions: Self.telemetryDimensions(for: screenCaptures)
        )

        ClickyAnalytics.trackAIResponseReceived(response: spokenText)

        let ttsText = Self.speechText(from: spokenText)
        switch YishuSpokenReplyBudget.route(
            speechAlreadyPresented: speechAlreadyPresented,
            visibleText: spokenText
        ) {
        case .alreadySpoken:
            break
        case .speakInFull:
            guard !ttsText.isEmpty else {
                timing?.mark("tts_complete", reason: "skipped_empty")
                break
            }
            guard ownsVoiceTurn(turnToken) else { throw CancellationError() }
            stopCoverSpeech()
            timing?.mark("tts_start", reason: "speech")
            do {
                try await elevenLabsTTSClient.speakText(
                    ttsText,
                    speed: speechSpeed
                )
                guard ownsVoiceTurn(turnToken) else { throw CancellationError() }
                turnVisualPhase = .shapingOutput
                voiceState = .responding
                timing?.mark("tts_complete", reason: "ok")
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                guard ownsVoiceTurn(turnToken) else { throw CancellationError() }
                timing?.mark("tts_complete", reason: "error")
                ClickyAnalytics.trackTTSError(error: error.localizedDescription)
                print("⚠️ MiniMax TTS failed")
                speakCreditsErrorFallback()
            }
        case .requestExcerpt:
            guard ownsVoiceTurn(turnToken) else { throw CancellationError() }
            stopCoverSpeech()
            do {
                let excerpt = try await yishuAgentRuntimeClient.excerptSpeech(
                    visibleText: spokenText,
                    provider: selectedModelProvider,
                    model: selectedModel
                )
                let excerptTts = Self.speechText(from: excerpt)
                guard !excerptTts.isEmpty else {
                    timing?.mark("tts_complete", reason: "excerpt_empty")
                    break
                }
                guard ownsVoiceTurn(turnToken) else { throw CancellationError() }
                timing?.mark("tts_start", reason: "excerpt")
                try await elevenLabsTTSClient.speakText(
                    excerptTts,
                    speed: speechSpeed
                )
                guard ownsVoiceTurn(turnToken) else { throw CancellationError() }
                turnVisualPhase = .shapingOutput
                voiceState = .responding
                timing?.mark("tts_complete", reason: "excerpt_ok")
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                // Failure must not fall back to reading the full essay.
                guard ownsVoiceTurn(turnToken) else { throw CancellationError() }
                timing?.mark("tts_complete", reason: "excerpt_failed")
            }
        }
        guard ownsVoiceTurn(turnToken) else { throw CancellationError() }
        responseOverlayManager.finishStreaming()
    }

    /// Keeps citations in the visual response while making the TTS copy
    /// conversational. Link-only/source-only lines are omitted, inline
    /// Markdown links keep their human label, and one short notice replaces
    /// the spoken URLs.
    static func speechText(from presentationText: String) -> String {
        let urlPattern = #"(?i)(?:https?://|www\.)[^\s<>()（）\[\]{}，。！？；、“”‘’]+"#
        guard presentationText.range(of: urlPattern, options: .regularExpression) != nil else {
            return presentationText.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        var readableLines: [String] = []
        for rawLine in presentationText.components(separatedBy: .newlines) {
            var line = replacingMatches(
                in: rawLine,
                pattern: #"(?i)\[([^\]\n]+)\]\(\s*(?:https?://|www\.)[^)\n]+\)"#,
                withTemplate: "$1"
            )
            line = replacingMatches(
                in: line,
                pattern: #"(?i)<\s*(?:https?://|www\.)[^>\s]+\s*>"#
            )
            line = replacingMatches(in: line, pattern: urlPattern)
            line = replacingMatches(
                in: line,
                pattern: #"(?i)[（(]\s*(?:来源(?:链接)?|网址|链接|source)\s*[:：]?\s*[）)]"#
            )
            line = replacingMatches(
                in: line,
                pattern: #"(?i)[ \t（(,，;；-]*(?:来源(?:链接)?|网址|链接|source)\s*[:：]?\s*[）)]?[ \t]*$"#
            )
            line = line.trimmingCharacters(
                in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: ",，;；-"))
            )
            if !line.isEmpty {
                readableLines.append(line)
            }
        }

        readableLines.append("来源链接我放在文字里了。")
        return readableLines.joined(separator: "\n")
    }

    /// Removes model/tool syntax before any user-facing surface consumes the
    /// response. Both complete and still-open blocks are handled because local
    /// Grok and Pi can stream an opening marker before the final chunk arrives.
    static func scrubToolMarkup(from responseText: String) -> String {
        var scrubbed = responseText

        // Fenced tool/code blocks are never a presentation format for the
        // companion. Removing an unclosed fence through end-of-input is
        // important for streaming chunks that stop inside a block.
        scrubbed = scrubToolFencedBlocks(in: scrubbed)

        // Some providers serialize a tool call as
        // `<function=computer_control>...</function>` rather than using an
        // XML element named `computer_control`.
        scrubbed = replacingMatches(
            in: scrubbed,
            pattern: #"(?is)<\s*function\s*=\s*[\"']?computer[ _-]?control[\"']?[^>]*>.*?(?:</\s*function\s*>|$)"#
        )

        let toolNames = #"(?:computer[ _-]?control|computer[ _-]?action|tool[ _-]?call|function[ _-]?call|tool)"#
        // Complete wrapper and self-closing forms.
        scrubbed = replacingMatches(
            in: scrubbed,
            pattern: #"(?is)<\s*\#(toolNames)\b[^>]*?/\s*>"#
        )
        scrubbed = replacingMatches(
            in: scrubbed,
            pattern: #"(?is)<\s*\#(toolNames)\b[^>]*>.*?</\s*\#(toolNames)\s*>"#
        )

        // An opening wrapper with no closing tag consumes the rest of the
        // response. This is the safe branch for a truncated tool call.
        scrubbed = replacingMatches(
            in: scrubbed,
            pattern: #"(?is)<\s*\#(toolNames)\b[^>]*>.*$"#
        )
        scrubbed = replacingMatches(
            in: scrubbed,
            pattern: #"(?is)<\s*\#(toolNames)\b[^>]*$"#
        )

        // Only a named `<parameter>` wrapper is tool syntax. Ordinary HTML/XML
        // such as `<label>表单</label>` or `<x>横坐标</x>` must remain intact.
        let namedParameter = #"parameter\b(?=[^>]*\bname\s*=)[^>]*"#
        scrubbed = replacingMatches(
            in: scrubbed,
            pattern: #"(?is)<\s*\#(namedParameter)\s*/>"#
        )
        scrubbed = replacingMatches(
            in: scrubbed,
            pattern: #"(?is)<\s*\#(namedParameter)>.*?(?:</\s*parameter\s*>|$)"#
        )

        // Strip any orphaned closing/opening tool tags left after a partial
        // stream. POINT tags are deliberately not part of these expressions.
        scrubbed = replacingMatches(
            in: scrubbed,
            pattern: #"(?is)</?\s*\#(toolNames)\b[^>]*>"#
        )
        scrubbed = replacingMatches(
            in: scrubbed,
            pattern: #"(?is)\[\s*(?:tool[ _-]?call|computer[ _-]?control|function[ _-]?call)\b[^\]]*\].*?$"#
        )

        return scrubVisibleMarkup(in: scrubbed)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The overlay paints characters. Emphasis markers are not a visible
    /// format, so they leave before any user-facing surface or spoken copy.
    /// Fenced code and inline backticks stay; a naive tick strip would eat ```.
    private static func scrubVisibleMarkup(in text: String) -> String {
        text.replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "__", with: "")
    }

    private static func replacingMatches(
        in text: String,
        pattern: String,
        withTemplate template: String = ""
    ) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return text
        }
        let range = NSRange(text.startIndex..., in: text)
        return regex.stringByReplacingMatches(
            in: text,
            options: [],
            range: range,
            withTemplate: template
        )
    }

    private static func scrubToolFencedBlocks(in text: String) -> String {
        var output = ""
        var cursor = text.startIndex

        while let opening = text.range(of: "```", range: cursor..<text.endIndex) {
            output += text[cursor..<opening.lowerBound]
            guard let closing = text.range(
                of: "```",
                range: opening.upperBound..<text.endIndex
            ) else {
                let unclosedBlock = String(text[opening.lowerBound...])
                if isToolFence(unclosedBlock) {
                    return output
                }
                return output + unclosedBlock
            }

            let block = String(text[opening.lowerBound..<closing.upperBound])
            if !isToolFence(block) {
                output += block
            }
            cursor = closing.upperBound
        }

        output += text[cursor...]
        return output
    }

    private static func isToolFence(_ block: String) -> Bool {
        let lowercased = block.lowercased()
        let firstLine = lowercased.split(whereSeparator: { $0.isNewline }).first.map(String.init) ?? ""
        if firstLine.contains("```tool")
            || firstLine.contains("```computer")
            || firstLine.contains("```function")
            || firstLine.contains("```parameter") {
            return true
        }

        let toolMarkers = [
            "computer_control",
            "computer-control",
            "computer control",
            "tool_call",
            "tool-call",
            "<tool",
            "<function",
            "function=computer",
            "<parameter",
            "<action>",
            "<x>",
            "<y>",
            "<screen>",
            "<label>",
        ]
        return toolMarkers.contains(where: lowercased.contains)
    }

    static func selectedScreenIndex(
        for oneBasedScreenNumber: Int?,
        captureCount: Int
    ) -> Int? {
        guard let oneBasedScreenNumber,
              oneBasedScreenNumber >= 1,
              oneBasedScreenNumber <= captureCount else {
            return nil
        }
        return oneBasedScreenNumber - 1
    }

    private static func sourceCapture(
        for request: YishuComputerActionRequest,
        in captures: [CompanionScreenCapture]
    ) -> CompanionScreenCapture? {
        if let screenNumber = request.screen {
            guard let index = selectedScreenIndex(
                for: screenNumber,
                captureCount: captures.count
            ) else {
                return nil
            }
            return captures[index]
        }
        return captures.first(where: { $0.isCursorScreen }) ?? captures.first
    }

    private static func telemetryDimensions(
        for captures: [CompanionScreenCapture]
    ) -> String {
        guard !captures.isEmpty else { return "unavailable" }
        return captures.map {
            "\($0.screenshotWidthInPixels)x\($0.screenshotHeightInPixels)"
        }.joined(separator: ",")
    }

    /// Voice-route phase diagnostics intentionally contain only fixed phase
    /// names, durations, screenshot dimensions, and typed receipts. They are
    /// safe to inspect when a turn feels slow without retaining user speech or
    /// screen contents in the log stream.
    fileprivate static func logVoicePhase(
        turnID: String,
        phase: String,
        deltaMS: Double,
        totalMS: Double,
        reason: String,
        sourceDimensions: String? = nil,
        receiptID: String? = nil
    ) {
        let dimensions = sourceDimensions ?? "none"
        let receipt = receiptID.map(safeTelemetryID) ?? "none"
        let message =
            "route=voice "
                + "turn=\(turnID) "
                + "phase=\(phase) "
                + "delta_ms=\(telemetryDuration(deltaMS)) "
                + "total_ms=\(telemetryDuration(totalMS)) "
                + "reason=\(reason) "
                + "source=\(dimensions) "
                + "receipt=\(receipt)"
        computerActionLogger.notice("\(message, privacy: .public)")
    }

    /// Action diagnostics intentionally contain only geometry and typed
    /// receipts. Never add transcript, target labels, or image data here.
    private static func logComputerActionTelemetry(
        route: String,
        request: YishuComputerActionRequest,
        result: YishuComputerActionResult,
        sourceCapture: CompanionScreenCapture?
    ) {
        let frameID = safeTelemetryID(request.basisFrameId)
        let attemptID = safeTelemetryID(result.attemptId)
        let receiptID = safeTelemetryID(result.receiptId)
        let source = sourceCapture.map {
            "\($0.screenshotWidthInPixels)x\($0.screenshotHeightInPixels)"
        } ?? "unavailable"
        let globalPoint = sourceCapture.map {
            YishuComputerUseActuator.globalTopLeftPoint(
                screenshotX: request.x,
                screenshotY: request.y,
                screenCapture: $0
            )
        }
        let global = globalPoint.map {
            "(\(telemetryCoordinate(Double($0.x))),\(telemetryCoordinate(Double($0.y))))"
        } ?? "unavailable"
        let screen = request.screen.map(String.init) ?? "cursor"
        let message =
            "route=\(route) "
                + "frame=\(frameID) "
                + "source=\(source) "
                + "screen=\(screen) "
                + "raw=(\(telemetryCoordinate(request.x)),\(telemetryCoordinate(request.y))) "
                + "global=\(global) "
                + "method=\(result.method.rawValue) "
                + "status=\(result.status.rawValue) "
                + "code=\(result.code.rawValue) "
                + "attempt=\(attemptID) "
                + "receipt=\(receiptID)"
        Self.computerActionLogger.notice("\(message, privacy: .public)")
    }

    private static func safeTelemetryID(_ value: String?) -> String {
        let source = value ?? UUID().uuidString
        let safeScalars = source.unicodeScalars.filter {
            CharacterSet.alphanumerics.contains($0)
        }
        let truncated = String(safeScalars.prefix(12))
        return truncated.isEmpty ? "unknown" : truncated
    }

    private static func telemetryCoordinate(_ value: Double) -> String {
        guard value.isFinite else { return "invalid" }
        return String(format: "%.2f", value)
    }

    private static func telemetryDuration(_ value: Double) -> String {
        guard value.isFinite else { return "invalid" }
        return String(format: "%.1f", value)
    }

    static let directClickFailureMessage = "这次没找到可点击的目标，我没有执行操作。"

    static func shouldUseDirectClickFailure(
        transcript: String,
        coordinate: CGPoint?,
        actionConsumed: Bool
    ) -> Bool {
        YishuDirectClickResolver.isDirectClickIntent(transcript)
            && !actionConsumed
            && coordinate == nil
    }

    static func shouldUseDirectActionResultAfterTurnFailure(
        transcript: String,
        actionResult: YishuComputerActionResult?
    ) -> Bool {
        YishuDirectClickResolver.isDirectClickIntent(transcript)
            && actionResult != nil
    }

    static func runtimeFailureRecoveryRoute(
        actionResult: YishuComputerActionResult?,
        runtimeIsRunning: Bool
    ) -> YishuRuntimeFailureRecoveryRoute {
        // Once an effect has a receipt, never replay the turn automatically.
        // This remains true even when the original utterance was not classified
        // as the narrow direct-click fast path.
        if actionResult != nil {
            return .useActionReceipt
        }
        return runtimeIsRunning ? .surfaceFailure : .restartRuntime
    }

    /// Mirrors the Runtime's intentionally narrow page-to-note boundary only
    /// to choose evidence shape. Runtime remains the authority that permits
    /// the Notes action, so uncertainty here fails closed to normal displays.
    static func requiresCurrentPageNoteWindow(_ transcript: String) -> Bool {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 240,
              text.range(of: "[？?]", options: .regularExpression) == nil,
              text.range(of: "(?:吗|么|能不能|可不可以|是否|要不要)\\s*$", options: .regularExpression) == nil,
              text.range(of: "(?:不要|别|取消|不必|不用|不是|并非)", options: .regularExpression) == nil else {
            return false
        }
        let currentPage = text.range(of: "(?:当前(?:页面|页|窗口)|这个页面)", options: .regularExpression) != nil
        let actionItems = text.range(of: "(?:三件事|三条|3\\s*条|最多\\s*(?:三|3)\\s*条)", options: .regularExpression) != nil
        let organize = text.range(of: "(?:整理|列成|提炼)", options: .regularExpression) != nil
        let note = text.range(of: "(?:备忘录|备忘|notes?)", options: [.regularExpression, .caseInsensitive]) != nil
        return currentPage && actionItems && organize && note
    }

    static func directActionConfirmation(
        for result: YishuComputerActionResult,
        action: String?
    ) -> String {
        if action == "schedule_reminder" {
            switch result.code {
            case .notificationPermissionPending:
                return "还没有设置，请允许后再说一次。"
            case .notificationPermissionDenied:
                return "系统提醒权限没有允许，所以这次没有设置。"
            default:
                if result.status == .verified {
                    if let clockLabel = result.clockLabel,
                       YishuTimeReminderDelivery.isMacClockLabel(clockLabel) {
                        return "已经设好提醒，大约 \(clockLabel)。"
                    }
                    return "已经设好提醒。"
                }
                if result.succeeded || result.status == .unverified {
                    return "提醒可能已经设好，但我没能确认；我不会重复设置。"
                }
                return "这次没有设置提醒。"
            }
        }
        let wording: (verified: String, delivered: String, unverified: String, failed: String)
        switch action {
        case "set_text":
            wording = (
                "填好了。",
                "输入已送达，但内容还没确认。",
                "填入结果不确定，我没有重复操作。",
                "这次没填进去，我没有重复操作。"
            )
        case "finder_history_back":
            wording = (
                "已经返回。",
                "返回操作已送达，但界面还没确认。",
                "返回结果不确定，我没有重复操作。",
                "这次没能返回，我没有重复操作。"
            )
        case "create_note":
            wording = (
                "已新建并确认一条备忘录。",
                "备忘录可能已经新建，但我还没确认；我不会重复创建。",
                "备忘录结果不确定，我不会重复创建。",
                "这次没有新建备忘录。"
            )
        default:
            wording = (
                "点好了。",
                "点击已送达，但界面结果还没确认。",
                "点击结果不确定，我没有重复操作。",
                "这次没点成功，我没有重复操作。"
            )
        }
        switch result.status {
        case .verified:
            return wording.verified
        case .delivered:
            return wording.delivered
        case .unverified:
            return wording.unverified
        case .blocked:
            return wording.failed
        case .failed:
            return wording.failed
        }
    }

    private func cancelActiveRuntimeTurn(reason: String) {
        stopCoverSpeech()
        cancelActiveSentenceSpeechPipeline()
        clearBargeInAttempt()
        guard let requestId = activeRuntimeRequestId else { return }
        activeRuntimeRequestId = nil
        activeRuntimePresentationTranscript = nil
        activeTurnEffectInFlight = false
        turnVisualPhase = .idle
        try? yishuAgentRuntimeClient.cancelTurn(requestId: requestId, reason: reason)
    }

    private func cancelActiveSentenceSpeechPipeline() {
        stopCoverSpeech()
        activeSentenceSpeechPipeline?.cancel()
        activeSentenceSpeechPipeline = nil
    }

    /// Cancel only the cover task. `speakText` cancellation stops that
    /// playback id; do not call `stopPlayback()` here or a later answer
    /// can be killed if it already owns the channel.
    private func stopCoverSpeech() {
        coverSpeechTask?.cancel()
        coverSpeechTask = nil
    }

    /// Product cover for a waiting search. Not an answer. Once per turn.
    @discardableResult
    private func beginSearchCoverSpeech(
        toolName: String,
        didSpeakCover: Bool,
        didSpeakAnswer: Bool,
        hasVisibleAnswerText: Bool,
        turnToken: UUID
    ) -> Bool {
        guard YishuSearchCoverSpeech.shouldSpeak(
            toolName: toolName,
            didSpeakCover: didSpeakCover,
            didSpeakAnswer: didSpeakAnswer,
            hasVisibleAnswerText: hasVisibleAnswerText
        ) else { return false }
        let line = YishuSearchCoverSpeech.line
        if !hasVisibleAnswerText {
            responseOverlayManager.updateStreamingText(line)
        }
        coverSpeechTask?.cancel()
        coverSpeechTask = Task { @MainActor [weak self] in
            guard let self, self.ownsVoiceTurn(turnToken) else { return }
            do {
                try await self.elevenLabsTTSClient.speakText(line, speed: self.speechSpeed)
            } catch {
                // Cover is optional; answer or barge-in may stop it.
            }
        }
        return true
    }

    /// Publish the orb target as soon as coordinates exist so flight overlaps speech.
    @discardableResult
    private func beginObservationalPointing(
        from parseResult: PointingParseResult,
        screenCaptures: [CompanionScreenCapture],
        isDirectClickTurn: Bool
    ) -> Bool {
        guard let pointCoordinate = parseResult.coordinate,
              !(isDirectClickTurn && activeTurnConsumedComputerAction) else {
            return false
        }
        let targetScreenCapture: CompanionScreenCapture?
        if let screenNumber = parseResult.screenNumber,
           let index = Self.selectedScreenIndex(
            for: screenNumber,
            captureCount: screenCaptures.count
           ) {
            targetScreenCapture = screenCaptures[index]
        } else {
            targetScreenCapture = screenCaptures.first(where: { $0.isCursorScreen })
                ?? screenCaptures.first
        }
        guard let targetScreenCapture else { return false }

        detectedElementDisplayFrame = targetScreenCapture.displayFrame
        detectedElementBubbleText = ""
        detectedElementScreenLocation = Self.globalAppKitPoint(
            x: Double(pointCoordinate.x),
            y: Double(pointCoordinate.y),
            screenCapture: targetScreenCapture
        )
        ClickyAnalytics.trackElementPointed(elementLabel: parseResult.elementLabel)
        return true
    }

    private static func globalAppKitPoint(
        x: Double,
        y: Double,
        screenCapture: CompanionScreenCapture
    ) -> CGPoint {
        let screenshotWidth = CGFloat(screenCapture.screenshotWidthInPixels)
        let screenshotHeight = CGFloat(screenCapture.screenshotHeightInPixels)
        let displayWidth = CGFloat(screenCapture.displayWidthInPoints)
        let displayHeight = CGFloat(screenCapture.displayHeightInPoints)
        let displayFrame = screenCapture.displayFrame

        let clampedX = max(0, min(CGFloat(x), screenshotWidth))
        let clampedY = max(0, min(CGFloat(y), screenshotHeight))

        let displayLocalX = clampedX * (displayWidth / screenshotWidth)
        let displayLocalY = clampedY * (displayHeight / screenshotHeight)
        let appKitY = displayHeight - displayLocalY

        return CGPoint(
            x: displayLocalX + displayFrame.origin.x,
            y: appKitY + displayFrame.origin.y
        )
    }

    /// If the cursor is in transient mode (user toggled "显示奕枢光标" off),
    /// waits for TTS playback and any pointing animation to finish, then
    /// fades out the overlay after a 1-second pause. Cancelled automatically
    /// if the user starts another push-to-talk interaction.
    private func scheduleTransientHideIfNeeded() {
        guard !isYishuCursorEnabled && isOverlayVisible else { return }

        transientHideTask?.cancel()
        transientHideTask = Task {
            // Wait for TTS audio to finish playing
            while elevenLabsTTSClient.isPlaying {
                try? await Task.sleep(nanoseconds: 200_000_000)
                guard !Task.isCancelled else { return }
            }

            // Wait for pointing animation to finish (location is cleared
            // when the orb flies back to the cursor)
            while detectedElementScreenLocation != nil {
                try? await Task.sleep(nanoseconds: 200_000_000)
                guard !Task.isCancelled else { return }
            }

            // Pause 1s after everything finishes, then fade out
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled else { return }
            overlayWindowManager.fadeOutAndHideOverlay()
            isOverlayVisible = false
        }
    }

    /// Speaks a hardcoded error message using macOS system TTS when API
    /// credits run out. Uses NSSpeechSynthesizer so it works even when
    /// ElevenLabs is down.
    private func speakCreditsErrorFallback() {
        let utterance = "我这边暂时说不出来了。请检查本地代理是否在跑，以及阶跃看图、转写和语音的额度。"
        let synthesizer = NSSpeechSynthesizer()
        synthesizer.startSpeaking(utterance)
        voiceState = .responding
    }

    // MARK: - Point Tag Parsing

    /// Result of parsing a [POINT:...] tag from the runtime completion.
    struct PointingParseResult {
        /// The response text with the [POINT:...] tag removed — this is what gets spoken.
        let spokenText: String
        /// The parsed pixel coordinate, or nil if Claude said "none" or no tag was found.
        let coordinate: CGPoint?
        /// Short label describing the element (e.g. "run button"), or "none".
        let elementLabel: String?
        /// Which screen the coordinate refers to (1-based), or nil to default to cursor screen.
        let screenNumber: Int?
    }

    /// Parses the last [POINT:x,y:label:screenN] or [POINT:none] tag.
    /// Returns the spoken text (all POINT tags removed) and the optional coordinate.
    static func parsePointingCoordinates(from responseText: String) -> PointingParseResult {
        let pattern = #"\[POINT:\s*(?:none|(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?::([^\]:\s][^\]:]*?))?(?::screen(\d+))?)\]"#
        let fullRange = NSRange(responseText.startIndex..., in: responseText)

        guard let regex = try? NSRegularExpression(pattern: pattern, options: []),
              let match = regex.matches(in: responseText, range: fullRange).last else {
            return PointingParseResult(spokenText: responseText, coordinate: nil, elementLabel: nil, screenNumber: nil)
        }

        let spokenText = regex.stringByReplacingMatches(
            in: responseText,
            options: [],
            range: fullRange,
            withTemplate: ""
        ).trimmingCharacters(in: .whitespacesAndNewlines)

        guard match.numberOfRanges >= 3,
              let xRange = Range(match.range(at: 1), in: responseText),
              let yRange = Range(match.range(at: 2), in: responseText),
              let x = Double(responseText[xRange]),
              let y = Double(responseText[yRange]) else {
            return PointingParseResult(spokenText: spokenText, coordinate: nil, elementLabel: "none", screenNumber: nil)
        }

        var elementLabel: String? = nil
        if match.numberOfRanges >= 4, let labelRange = Range(match.range(at: 3), in: responseText) {
            elementLabel = String(responseText[labelRange]).trimmingCharacters(in: .whitespaces)
        }

        var screenNumber: Int? = nil
        if match.numberOfRanges >= 5, let screenRange = Range(match.range(at: 4), in: responseText) {
            screenNumber = Int(responseText[screenRange])
        }

        return PointingParseResult(
            spokenText: spokenText,
            coordinate: CGPoint(x: x, y: y),
            elementLabel: elementLabel,
            screenNumber: screenNumber
        )
    }

    // MARK: - Onboarding Video

    /// Sets up the onboarding video player, starts playback, and schedules
    /// the demo interaction at 40s. Called by YishuPresenceView when onboarding starts.
    func setupOnboardingVideo() {
        guard let videoURL = URL(string: "https://stream.mux.com/e5jB8UuSrtFABVnTHCR7k3sIsmcUHCyhtLu1tzqLlfs.m3u8") else { return }

        let player = AVPlayer(url: videoURL)
        player.isMuted = false
        player.volume = 0.0
        self.onboardingVideoPlayer = player
        self.showOnboardingVideo = true
        self.onboardingVideoOpacity = 0.0

        // Start playback immediately — the video plays while invisible,
        // then we fade in both the visual and audio over 1s.
        player.play()

        // Wait for SwiftUI to mount the view, then set opacity to 1.
        // The .animation modifier on the view handles the actual animation.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            self.onboardingVideoOpacity = 1.0
            // Fade audio volume from 0 → 1 over 2s to match visual fade
            self.fadeInVideoAudio(player: player, targetVolume: 1.0, duration: 2.0)
        }

        // At 40 seconds into the video, trigger the onboarding demo where
        // Yishu flies to something interesting on screen and comments on it
        let demoTriggerTime = CMTime(seconds: 40, preferredTimescale: 600)
        onboardingDemoTimeObserver = player.addBoundaryTimeObserver(
            forTimes: [NSValue(time: demoTriggerTime)],
            queue: .main
        ) { [weak self] in
            ClickyAnalytics.trackOnboardingDemoTriggered()
            self?.performOnboardingDemoInteraction()
        }

        // Fade out and clean up when the video finishes
        onboardingVideoEndObserver = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification,
            object: player.currentItem,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            ClickyAnalytics.trackOnboardingVideoCompleted()
            self.onboardingVideoOpacity = 0.0
            // Wait for the 2s fade-out animation to complete before tearing down
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                self.tearDownOnboardingVideo()
                // After the video disappears, stream in the prompt to try talking
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    self.startOnboardingPromptStream()
                }
            }
        }
    }

    func tearDownOnboardingVideo() {
        showOnboardingVideo = false
        if let timeObserver = onboardingDemoTimeObserver {
            onboardingVideoPlayer?.removeTimeObserver(timeObserver)
            onboardingDemoTimeObserver = nil
        }
        onboardingVideoPlayer?.pause()
        onboardingVideoPlayer = nil
        if let observer = onboardingVideoEndObserver {
            NotificationCenter.default.removeObserver(observer)
            onboardingVideoEndObserver = nil
        }
    }

    private func startOnboardingPromptStream() {
        let message = "press control + option and introduce yourself"
        onboardingPromptText = ""
        showOnboardingPrompt = true
        onboardingPromptOpacity = 0.0

        withAnimation(.easeIn(duration: 0.4)) {
            onboardingPromptOpacity = 1.0
        }

        var currentIndex = 0
        Timer.scheduledTimer(withTimeInterval: 0.03, repeats: true) { timer in
            guard currentIndex < message.count else {
                timer.invalidate()
                // Auto-dismiss after 10 seconds
                DispatchQueue.main.asyncAfter(deadline: .now() + 10.0) {
                    guard self.showOnboardingPrompt else { return }
                    withAnimation(.easeOut(duration: 0.3)) {
                        self.onboardingPromptOpacity = 0.0
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                        self.showOnboardingPrompt = false
                        self.onboardingPromptText = ""
                    }
                }
                return
            }
            let index = message.index(message.startIndex, offsetBy: currentIndex)
            self.onboardingPromptText.append(message[index])
            currentIndex += 1
        }
    }

    /// Gradually raises an AVPlayer's volume from its current level to the
    /// target over the specified duration, creating a smooth audio fade-in.
    private func fadeInVideoAudio(player: AVPlayer, targetVolume: Float, duration: Double) {
        let steps = 20
        let stepInterval = duration / Double(steps)
        let volumeIncrement = (targetVolume - player.volume) / Float(steps)
        var stepsRemaining = steps

        Timer.scheduledTimer(withTimeInterval: stepInterval, repeats: true) { timer in
            stepsRemaining -= 1
            player.volume += volumeIncrement

            if stepsRemaining <= 0 {
                timer.invalidate()
                player.volume = targetVolume
            }
        }
    }

    // MARK: - Onboarding Demo Interaction

    /// Locally recognizes one reliable, central text target and points at it.
    /// Screenshot bytes never leave the app during onboarding.
    func performOnboardingDemoInteraction() {
        // Don't interrupt a voice turn or another pointing animation.
        guard voiceState == .idle, detectedElementScreenLocation == nil else { return }

        Task {
            do {
                let screenCaptures = try await CompanionScreenCaptureUtility.captureAllScreensAsJPEG()

                guard let cursorScreenCapture = screenCaptures.first(where: { $0.isCursorScreen }) else {
                    print("🎯 Onboarding demo: no cursor screen found")
                    return
                }

                let screen = YishuDirectClickScreen(
                    imageData: cursorScreenCapture.imageData,
                    screenshotWidthInPixels: cursorScreenCapture.screenshotWidthInPixels,
                    screenshotHeightInPixels: cursorScreenCapture.screenshotHeightInPixels,
                    screenNumber: 1
                )
                guard let match = await YishuDirectClickResolver.resolveOnboardingTarget(screen: screen),
                      let bubbleText = Self.onboardingObservationBubble(for: match.label) else {
                    print("🎯 Onboarding demo: no reliable central text found")
                    return
                }

                let screenshotWidth = CGFloat(cursorScreenCapture.screenshotWidthInPixels)
                let screenshotHeight = CGFloat(cursorScreenCapture.screenshotHeightInPixels)
                let displayWidth = CGFloat(cursorScreenCapture.displayWidthInPoints)
                let displayHeight = CGFloat(cursorScreenCapture.displayHeightInPoints)
                let displayFrame = cursorScreenCapture.displayFrame

                let clampedX = max(0, min(CGFloat(match.x), screenshotWidth))
                let clampedY = max(0, min(CGFloat(match.y), screenshotHeight))
                let displayLocalX = clampedX * (displayWidth / screenshotWidth)
                let displayLocalY = clampedY * (displayHeight / screenshotHeight)
                let appKitY = displayHeight - displayLocalY
                let globalLocation = CGPoint(
                    x: displayLocalX + displayFrame.origin.x,
                    y: appKitY + displayFrame.origin.y
                )

                detectedElementBubbleText = bubbleText
                detectedElementScreenLocation = globalLocation
                detectedElementDisplayFrame = displayFrame
                print("🎯 Onboarding demo: local text target selected")
            } catch {
                print("⚠️ Onboarding demo error: \(error)")
            }
        }
    }

    private static func onboardingObservationBubble(for label: String) -> String? {
        let normalized = label
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return nil }
        return "我看见「\(String(normalized.prefix(20)))」了。"
    }
}

/// Pure rules for when the memory source line may appear. Kept testable without
/// spinning up the full CompanionManager graph.
enum YishuMemorySourcePolicy {
    /// Panel shows the line in exactly one slot (personal history section).
    static let panelDisplaySiteCount = 1

    static func noticeAfterConversationOrScopeChange() -> String? { nil }

    static func noticeAfterTurnCancelledOrFailed() -> String? { nil }

    static func noticeAfterSuccessfulTurn(usedMemories: [YishuMemoryUsedItem]) -> String? {
        let text = formatNotice(usedMemories)
        return text.isEmpty ? nil : text
    }

    static func formatNotice(_ items: [YishuMemoryUsedItem]) -> String {
        guard !items.isEmpty else { return "" }
        let lines = items.prefix(3).map { item -> String in
            let sourceLabel = sourceLabel(item.source)
            let when = savedAtLabel(item.capturedAt)
            return "用了记忆「\(item.summary)」· \(when) · \(sourceLabel)"
        }
        return lines.joined(separator: "\n")
    }

    static func sourceLabel(_ source: String) -> String {
        switch source {
        case "conversation":
            return "对话中明确保存"
        case "user_correction":
            return "你的纠正"
        case "observation":
            return "观察"
        case "skill_verify":
            return "技能验证"
        case "system":
            return "系统"
        default:
            return "明确保存"
        }
    }

    static func savedAtLabel(_ iso: String) -> String {
        guard !iso.isEmpty else { return "保存时间未知" }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = formatter.date(from: iso)
        if date == nil {
            formatter.formatOptions = [.withInternetDateTime]
            date = formatter.date(from: iso)
        }
        guard let date else { return "保存于 \(iso)" }
        let display = DateFormatter()
        display.locale = Locale(identifier: "zh_CN")
        display.dateFormat = "M月d日 HH:mm"
        return "保存于 \(display.string(from: date))"
    }
}

/// Documented forget-UI product rules (testable without full manager graph).
enum YishuMemoryForgetUIPolicy {
    /// Cancel confirmation must not call forget or mutate the list/store.
    static let shouldMutateStoreOnCancel = false
    /// While answering, requestForget refuses without writing.
    static let shouldMutateStoreWhenBusy = false
    /// Row drops only after memory.forgotten success.
    static let shouldRemoveRowOnlyAfterStoreSuccess = true
    static let busyRefuseNotice = YishuPersonalNotesCopy.busyForget
}
