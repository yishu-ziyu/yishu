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

/// Typed facts the Clicky shell already owns. The router keeps precedence and
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

enum YishuVisualStateRouter {
    static func route(_ inputs: YishuVisualStateInputs) -> YishuVisualState {
        if inputs.voiceState == .listening {
            return .listening
        }

        if inputs.voiceState == .responding {
            return .shaping
        }

        if inputs.delegatedPresence.hasActiveWork {
            return .weaving
        }

        switch inputs.voiceState {
        case .listening:
            return .listening
        case .responding:
            return .shaping
        case .processing:
            return routeTurnPhase(inputs.turnPhase)
        case .idle:
            break
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
            return .connecting
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
        let activeCount = tasks.filter { $0.status == .running }.count
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
