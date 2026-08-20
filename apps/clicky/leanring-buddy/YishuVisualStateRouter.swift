import Foundation

/// Product visual states backed by the official thinking-orbs vocabulary.
/// This is UI-facing state, not raw protocol text.
enum YishuVisualState: String, CaseIterable, Equatable {
    case breathing
    case listening
    case connecting
    case searching
    case solving
    case working
    case composing
    case weaving
    case shaping
}

extension YishuVisualState {
    var orbState: YishuBreathingOrbState {
        switch self {
        case .breathing: return .breathing
        case .listening: return .listening
        case .connecting: return .connecting
        case .searching: return .searching
        case .solving: return .solving
        case .working: return .working
        case .composing: return .composing
        case .weaving: return .weaving
        case .shaping: return .shaping
        }
    }
}

/// Typed facts the Yishu shell already owns. The router keeps precedence and
/// mapping testable without inspecting localized status text or protocol strings.
struct YishuVisualStateInputs: Equatable {
    var voiceState: CompanionVoiceState = .idle
    var runtimePhase: YishuRuntimeVisualPhase = .idle
    var turnPhase: YishuTurnVisualPhase = .idle
    var delegatedPresence: YishuDelegatedPresenceVisualPhase = .idle

    init(
        voiceState: CompanionVoiceState = .idle,
        runtimePhase: YishuRuntimeVisualPhase = .idle,
        turnPhase: YishuTurnVisualPhase = .idle,
        delegatedPresence: YishuDelegatedPresenceVisualPhase = .idle
    ) {
        self.voiceState = voiceState
        self.runtimePhase = runtimePhase
        self.turnPhase = turnPhase
        self.delegatedPresence = delegatedPresence
    }
}

enum YishuRuntimeVisualPhase: Equatable {
    case idle
    case connecting
}

enum YishuTurnVisualPhase: Equatable {
    case idle
    case finalizingSpeech
    case observingContext
    case searchingContext
    case reasoning
    case usingTool
    case performingAction
    case confirmingToolResult
    case composingResponse
    case shapingOutput
}

enum YishuDelegatedPresenceVisualPhase: Equatable {
    case idle
    case activeWorkerCount(Int)

    var hasActiveWork: Bool {
        switch self {
        case .idle:
            return false
        case let .activeWorkerCount(count):
            return count > 0
        }
    }
}

/// Stateful adapter between the shell's typed lifecycle events and the pure
/// visual router. CompanionManager uses this same type that tests exercise, so
/// event propagation is not verified through a separate test-only mapping.
struct YishuVisualStateMachine: Equatable {
    private(set) var runtimePhase: YishuRuntimeVisualPhase = .idle
    private(set) var turnPhase: YishuTurnVisualPhase = .idle

    mutating func setRuntimePhase(_ phase: YishuRuntimeVisualPhase) {
        runtimePhase = phase
    }

    mutating func apply(runtimeEvent: YishuRuntimeLifecycleEvent) {
        runtimePhase = YishuVisualStateRouter.route(runtimeEvent: runtimeEvent)
    }

    mutating func setTurnPhase(_ phase: YishuTurnVisualPhase) {
        turnPhase = phase
    }

    mutating func apply(turnEvent: YishuRuntimeTurnEvent) {
        turnPhase = YishuVisualStateRouter.route(turnEvent: turnEvent)
    }

    func visualState(
        voiceState: CompanionVoiceState,
        delegatedTasks: [YishuDelegatedTaskPresenceEvent]
    ) -> YishuVisualState {
        YishuVisualStateRouter.route(YishuVisualStateInputs(
            voiceState: voiceState,
            runtimePhase: runtimePhase,
            turnPhase: turnPhase,
            delegatedPresence: YishuVisualStateRouter.route(delegatedTasks: delegatedTasks)
        ))
    }
}

enum YishuVisualStateRouter {
    static func route(_ inputs: YishuVisualStateInputs) -> YishuVisualState {
        switch inputs.voiceState {
        case .listening:
            return .listening
        case .responding:
            return .shaping
        case .processing:
            // A foreground turn is the interaction the user is currently
            // watching. Background workers must not mask its searching,
            // reasoning, tool, composing, or shaping phase.
            return routeTurnPhase(inputs.turnPhase)
        case .idle:
            break
        }

        if inputs.delegatedPresence.hasActiveWork {
            return .weaving
        }

        if inputs.runtimePhase == .connecting {
            return .connecting
        }

        return routeTurnPhase(inputs.turnPhase)
    }

    static func route(voiceState: CompanionVoiceState) -> YishuVisualState {
        route(YishuVisualStateInputs(voiceState: voiceState))
    }

    static func route(runtimeEvent event: YishuRuntimeLifecycleEvent) -> YishuRuntimeVisualPhase {
        switch event {
        case .ready:
            return .idle
        case .stopped:
            return .idle
        }
    }

    static func route(turnEvent event: YishuRuntimeTurnEvent) -> YishuTurnVisualPhase {
        switch event {
        case .started:
            return .reasoning
        case .responseDelta:
            return .composingResponse
        case .toolStarted:
            return .usingTool
        case .toolCompleted:
            return .confirmingToolResult
        case .computerActionRequested:
            return .performingAction
        case .memoryUsed:
            return .searchingContext
        case .completed:
            return .shapingOutput
        case .cancelled:
            return .idle
        }
    }

    static func route(delegatedTasks tasks: [YishuDelegatedTaskPresenceEvent]) -> YishuDelegatedPresenceVisualPhase {
        let activeCount = tasks.filter { $0.status == .pending || $0.status == .running }.count
        return activeCount > 0 ? .activeWorkerCount(activeCount) : .idle
    }

    private static func routeTurnPhase(_ turnPhase: YishuTurnVisualPhase) -> YishuVisualState {
        switch turnPhase {
        case .idle:
            return .breathing
        case .finalizingSpeech:
            return .composing
        case .observingContext, .searchingContext:
            return .searching
        case .reasoning:
            return .solving
        case .usingTool, .performingAction, .confirmingToolResult:
            return .working
        case .composingResponse:
            return .composing
        case .shapingOutput:
            return .shaping
        }
    }
}
