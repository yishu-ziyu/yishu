import Foundation

@MainActor
extension CompanionManager {
    var modelRoutingMode: YishuModelRoutingMode { modelRoutingSettings.mode }

    var selectedModelLabel: String {
        modelDisplayLine(for: fixedModelPreference)
    }

    var modelRoutingHeaderLabel: String {
        guard let preference = configuredRoutingModelPreference else {
            return modelRoutingMode.displayName
        }
        let modelLabel = availableConversationModels.first {
            $0.provider == preference.provider && $0.model == preference.model
        }?.label ?? preference.model
        return "\(modelRoutingMode.displayName) · \(modelLabel)"
    }

    var configuredRoutingModelPreference: YishuModelPreference? {
        modelRoutingSettings.configuredPreference(fixedPreference: fixedModelPreference)
    }

    var configuredRoutingModelProvider: String {
        configuredRoutingModelPreference?.provider ?? selectedModelProvider
    }

    var configuredRoutingModel: String {
        configuredRoutingModelPreference?.model ?? selectedModel
    }

    func modelRoutingSummary(for profile: YishuModelRoutingProfile) -> String {
        "\(profile.mode.displayName) · \(modelDisplayLine(for: modelRoutingSettings.profiles[profile]))"
    }

    func setModelRoutingMode(_ mode: YishuModelRoutingMode) {
        var settings = modelRoutingSettings
        settings.selectMode(mode, in: .standard)
        modelRoutingSettings = settings
    }

    func setSelectedModel(_ option: YishuConversationModelOption) {
        guard availableConversationModels.contains(option), modelRoutingMode != .auto else { return }
        let preference = YishuModelPreference(provider: option.provider, model: option.model)
        if let profile = modelRoutingMode.profile {
            var settings = modelRoutingSettings
            guard settings.assign(preference, to: profile, in: .standard) else { return }
            modelRoutingSettings = settings
        } else {
            selectedModelProvider = option.provider
            selectedModel = option.model
            YishuModelRoutingDefaults.persistFixed(preference, in: .standard)
        }
        print("🧠 奕枢 model route → \(modelRoutingMode.rawValue)")
    }

    var runtimeModelRouting: YishuModelRouting {
        modelRoutingSettings.wireValue(fixedPreference: fixedModelPreference)
    }

    func presentResolvedModelRoute(
        _ route: YishuResolvedModelRoute?,
        isProductActionTurn: Bool
    ) {
        responseOverlayManager.updateRoutingMetadataText(
            YishuModelRoutePresentation.line(
                for: route,
                availableModels: availableConversationModels,
                isProductActionTurn: isProductActionTurn
            )
        )
    }

    private var fixedModelPreference: YishuModelPreference {
        YishuModelPreference(provider: selectedModelProvider, model: selectedModel)
    }

    private func modelDisplayLine(for preference: YishuModelPreference) -> String {
        guard let option = availableConversationModels.first(where: {
            $0.provider == preference.provider && $0.model == preference.model
        }) else {
            return "\(preference.model) · 需登录"
        }
        return YishuAccountSurfaceCopy.selectedLine(label: option.label, source: option.sourceLabel)
    }
}
