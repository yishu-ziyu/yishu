import Foundation

enum YishuModelRoutingMode: String, CaseIterable, Codable, Identifiable {
    case auto
    case realtimeConversation = "realtime_conversation"
    case screenCollaboration = "screen_collaboration"
    case deepTask = "deep_task"
    case fixedModel = "fixed_model"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .auto:
            return "自动"
        case .realtimeConversation:
            return "实时交流"
        case .screenCollaboration:
            return "屏幕协作"
        case .deepTask:
            return "深度任务"
        case .fixedModel:
            return "固定模型"
        }
    }

    var helperText: String {
        switch self {
        case .auto:
            return "普通对话和屏幕协作自动切换；深度任务可手动选择。"
        case .realtimeConversation:
            return "配置低延迟对话使用的模型。"
        case .screenCollaboration:
            return "配置看屏和使用工具时的模型。"
        case .deepTask:
            return "配置需要更多思考时的模型。"
        case .fixedModel:
            return "所有请求都使用同一个模型。"
        }
    }

    var profile: YishuModelRoutingProfile? {
        switch self {
        case .realtimeConversation:
            return .realtimeConversation
        case .screenCollaboration:
            return .screenCollaboration
        case .deepTask:
            return .deepTask
        case .auto, .fixedModel:
            return nil
        }
    }
}

enum YishuModelRoutingProfile: String, CaseIterable {
    case realtimeConversation
    case screenCollaboration
    case deepTask

    var mode: YishuModelRoutingMode {
        switch self {
        case .realtimeConversation:
            return .realtimeConversation
        case .screenCollaboration:
            return .screenCollaboration
        case .deepTask:
            return .deepTask
        }
    }
}

struct YishuModelProfileAssignments: Encodable, Equatable {
    var realtimeConversation: YishuModelPreference
    var screenCollaboration: YishuModelPreference
    var deepTask: YishuModelPreference

    subscript(profile: YishuModelRoutingProfile) -> YishuModelPreference {
        get {
            switch profile {
            case .realtimeConversation:
                return realtimeConversation
            case .screenCollaboration:
                return screenCollaboration
            case .deepTask:
                return deepTask
            }
        }
        set {
            switch profile {
            case .realtimeConversation:
                realtimeConversation = newValue
            case .screenCollaboration:
                screenCollaboration = newValue
            case .deepTask:
                deepTask = newValue
            }
        }
    }
}

struct YishuModelRouting: Encodable, Equatable {
    let mode: YishuModelRoutingMode
    let profiles: YishuModelProfileAssignments?
    let preference: YishuModelPreference?

    static func profiled(
        mode: YishuModelRoutingMode,
        profiles: YishuModelProfileAssignments
    ) -> YishuModelRouting {
        precondition(mode != .fixedModel, "Fixed routing uses one preference")
        return YishuModelRouting(mode: mode, profiles: profiles, preference: nil)
    }

    static func fixed(preference: YishuModelPreference) -> YishuModelRouting {
        YishuModelRouting(mode: .fixedModel, profiles: nil, preference: preference)
    }

    var allPreferences: [YishuModelPreference] {
        if let preference {
            return [preference]
        }
        guard let profiles else { return [] }
        return YishuModelRoutingProfile.allCases.map { profiles[$0] }
    }
}

enum YishuModelRoutingDefaults {
    static let modeKey = "clicky.modelRouting.mode.v1"
    static let legacyUserPickedKey = "clicky.chatModel.userPicked.v1"
    static let legacySelectedModelKey = "selectedClaudeModel"
    static let legacySelectedProviderKey = "selectedModelProvider"

    static func providerKey(for profile: YishuModelRoutingProfile) -> String {
        "clicky.modelRouting.\(profile.rawValue).provider.v1"
    }

    static func modelKey(for profile: YishuModelRoutingProfile) -> String {
        "clicky.modelRouting.\(profile.rawValue).model.v1"
    }

    static func persistFixed(_ preference: YishuModelPreference, in defaults: UserDefaults) {
        defaults.set(preference.provider, forKey: legacySelectedProviderKey)
        defaults.set(preference.model, forKey: legacySelectedModelKey)
        defaults.set(true, forKey: legacyUserPickedKey)
    }
}

enum YishuModelRoutingBootstrap {
    static let fixedPreference: YishuModelPreference = {
        let defaults = UserDefaults.standard
        let resolved = YishuConversationModelCatalog.resolvedSelection(
            storedModel: defaults.string(forKey: YishuModelRoutingDefaults.legacySelectedModelKey),
            storedProvider: defaults.string(forKey: YishuModelRoutingDefaults.legacySelectedProviderKey)
        )
        let preference = YishuModelPreference(provider: resolved.provider, model: resolved.model)
        defaults.set(preference.provider, forKey: YishuModelRoutingDefaults.legacySelectedProviderKey)
        defaults.set(preference.model, forKey: YishuModelRoutingDefaults.legacySelectedModelKey)
        return preference
    }()

    static let settings = YishuModelRoutingSettings.load(
        from: .standard,
        fixedPreference: fixedPreference
    )
}

struct YishuModelRoutingSettings: Equatable {
    private(set) var mode: YishuModelRoutingMode
    private(set) var profiles: YishuModelProfileAssignments

    static func load(
        from defaults: UserDefaults,
        fixedPreference: YishuModelPreference
    ) -> YishuModelRoutingSettings {
        let storedMode = defaults.string(forKey: YishuModelRoutingDefaults.modeKey)
            .flatMap(YishuModelRoutingMode.init(rawValue:))
        let mode: YishuModelRoutingMode
        if let storedMode {
            mode = storedMode
        } else if defaults.bool(forKey: YishuModelRoutingDefaults.legacyUserPickedKey) {
            mode = .fixedModel
        } else {
            mode = .auto
        }
        defaults.set(mode.rawValue, forKey: YishuModelRoutingDefaults.modeKey)

        var loaded: [YishuModelRoutingProfile: YishuModelPreference] = [:]
        for profile in YishuModelRoutingProfile.allCases {
            let provider = normalizedStoredValue(
                defaults.string(forKey: YishuModelRoutingDefaults.providerKey(for: profile))
            )
            let model = normalizedStoredValue(
                defaults.string(forKey: YishuModelRoutingDefaults.modelKey(for: profile))
            )
            let preference: YishuModelPreference
            if let provider, let model {
                preference = YishuModelPreference(provider: provider, model: model)
            } else {
                preference = fixedPreference
            }
            loaded[profile] = preference
            persist(preference, profile: profile, in: defaults)
        }

        return YishuModelRoutingSettings(
            mode: mode,
            profiles: YishuModelProfileAssignments(
                realtimeConversation: loaded[.realtimeConversation] ?? fixedPreference,
                screenCollaboration: loaded[.screenCollaboration] ?? fixedPreference,
                deepTask: loaded[.deepTask] ?? fixedPreference
            )
        )
    }

    mutating func selectMode(_ mode: YishuModelRoutingMode, in defaults: UserDefaults) {
        self.mode = mode
        defaults.set(mode.rawValue, forKey: YishuModelRoutingDefaults.modeKey)
    }

    @discardableResult
    mutating func assign(
        _ preference: YishuModelPreference,
        to profile: YishuModelRoutingProfile,
        in defaults: UserDefaults
    ) -> Bool {
        let provider = Self.normalizedStoredValue(preference.provider)
        let model = Self.normalizedStoredValue(preference.model)
        guard let provider, let model else { return false }
        let normalized = YishuModelPreference(provider: provider, model: model)
        profiles[profile] = normalized
        Self.persist(normalized, profile: profile, in: defaults)
        return true
    }

    func configuredPreference(
        fixedPreference: YishuModelPreference
    ) -> YishuModelPreference? {
        if let profile = mode.profile {
            return profiles[profile]
        }
        return mode == .fixedModel ? fixedPreference : nil
    }

    func wireValue(fixedPreference: YishuModelPreference) -> YishuModelRouting {
        mode == .fixedModel
            ? .fixed(preference: fixedPreference)
            : .profiled(mode: mode, profiles: profiles)
    }

    private static func persist(
        _ preference: YishuModelPreference,
        profile: YishuModelRoutingProfile,
        in defaults: UserDefaults
    ) {
        defaults.set(
            preference.provider,
            forKey: YishuModelRoutingDefaults.providerKey(for: profile)
        )
        defaults.set(
            preference.model,
            forKey: YishuModelRoutingDefaults.modelKey(for: profile)
        )
    }

    private static func normalizedStoredValue(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 120 else { return nil }
        return trimmed
    }
}

struct YishuResolvedModelRoute: Equatable {
    let routingMode: YishuModelRoutingMode
    let resolvedRoute: YishuModelRoutingMode
    let provider: String
    let model: String

    static func decode(_ payload: [String: Any]) -> YishuResolvedModelRoute? {
        guard let routingModeRaw = boundedString(payload["routingMode"], maximum: 40),
              let routingMode = YishuModelRoutingMode(rawValue: routingModeRaw),
              let resolvedRouteRaw = boundedString(payload["resolvedRoute"], maximum: 40),
              let resolvedRoute = YishuModelRoutingMode(rawValue: resolvedRouteRaw),
              resolvedRoute != .auto,
              let provider = boundedString(payload["provider"], maximum: 120),
              let model = boundedString(payload["model"], maximum: 120) else {
            return nil
        }
        return YishuResolvedModelRoute(
            routingMode: routingMode,
            resolvedRoute: resolvedRoute,
            provider: provider,
            model: model
        )
    }

    private static func boundedString(_ value: Any?, maximum: Int) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              trimmed.count <= maximum,
              !trimmed.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            return nil
        }
        return trimmed
    }
}

enum YishuModelRoutePresentation {
    static func line(
        for route: YishuResolvedModelRoute?,
        availableModels: [YishuConversationModelOption],
        isProductActionTurn: Bool
    ) -> String? {
        guard !isProductActionTurn, let route else { return nil }
        let modelLabel = availableModels.first {
            $0.provider == route.provider && $0.model == route.model
        }?.label ?? route.model

        if route.routingMode == .auto {
            return [
                route.routingMode.displayName,
                route.resolvedRoute.displayName,
                modelLabel,
            ].joined(separator: " · ")
        }
        if route.routingMode == route.resolvedRoute {
            return [route.routingMode.displayName, modelLabel].joined(separator: " · ")
        }
        return [
            route.routingMode.displayName,
            route.resolvedRoute.displayName,
            modelLabel,
        ].joined(separator: " · ")
    }
}
