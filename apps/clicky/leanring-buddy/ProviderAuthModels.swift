//
//  ProviderAuthModels.swift
//  leanring-buddy
//
//  Product-owned, token-free models for the Pi OAuth bridge. OAuth material
//  never crosses the stdio boundary and is not represented here.
//

import CoreFoundation
import Foundation

enum YishuAuthProvider: String, CaseIterable, Identifiable {
    case openAICodex = "openai-codex"
    case xAI = "xai"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .openAICodex:
            return "ChatGPT / Codex 订阅"
        case .xAI:
            return "xAI 订阅"
        }
    }

    var shortName: String {
        switch self {
        case .openAICodex:
            return "ChatGPT / Codex"
        case .xAI:
            return "xAI"
        }
    }

    var symbolName: String {
        switch self {
        case .openAICodex:
            return "person.crop.circle.badge.checkmark"
        case .xAI:
            return "sparkles"
        }
    }
}

struct YishuAuthModel: Identifiable, Equatable {
    let provider: YishuAuthProvider
    let id: String
    let name: String
}

struct YishuConversationModelOption: Identifiable, Equatable {
    let provider: String
    let model: String
    let label: String
    let sourceLabel: String

    var id: String { "\(provider):\(model)" }
}

enum YishuConversationModelCatalog {
    static let localProvider = "yishu-local-grok"
    static let localSourceLabel = YishuAccountSurfaceCopy.localGrokSource
    static let defaultModel = "MiniMax-M3"

    static let localModels: [YishuConversationModelOption] = [
        .init(provider: localProvider, model: "MiniMax-M3", label: "MiniMax M3", sourceLabel: localSourceLabel),
        .init(provider: localProvider, model: "grok-4.5", label: "Grok 4.5", sourceLabel: localSourceLabel),
        .init(provider: localProvider, model: "grok-4.6", label: "Grok 4.6", sourceLabel: localSourceLabel),
        .init(provider: localProvider, model: "grok-4.3", label: "Grok 4.3", sourceLabel: localSourceLabel),
        .init(provider: localProvider, model: "grok-4.20-0309-reasoning", label: "Grok 4.20 Reasoning", sourceLabel: localSourceLabel),
        .init(provider: localProvider, model: "grok-4.20-0309-non-reasoning", label: "Grok 4.20 Fast", sourceLabel: localSourceLabel),
        .init(provider: localProvider, model: "grok-4.20-multi-agent-0309", label: "Grok 4.20 Multi-Agent", sourceLabel: localSourceLabel),
        .init(provider: localProvider, model: "grok-3-mini", label: "Grok 3 Mini", sourceLabel: localSourceLabel),
        .init(provider: localProvider, model: "grok-3-mini-fast", label: "Grok 3 Mini Fast", sourceLabel: localSourceLabel),
        .init(provider: localProvider, model: "grok-composer-2.5-fast", label: "Grok Composer 2.5 Fast", sourceLabel: localSourceLabel),
        .init(provider: localProvider, model: "grok-build-0.1", label: "Grok Build 0.1", sourceLabel: localSourceLabel),
    ]

    static func available(authModels: [YishuAuthModel]) -> [YishuConversationModelOption] {
        localModels + authModels.map { model in
            YishuConversationModelOption(
                provider: model.provider.rawValue,
                model: model.id,
                label: model.name,
                sourceLabel: model.provider == .openAICodex
                    ? YishuAccountSurfaceCopy.chatgptSource
                    : YishuAccountSurfaceCopy.xaiSource
            )
        }
    }

    static func sections(
        authModels: [YishuAuthModel]
    ) -> [(title: String, models: [YishuConversationModelOption])] {
        var order: [String] = []
        var buckets: [String: [YishuConversationModelOption]] = [:]
        for option in available(authModels: authModels) {
            if buckets[option.sourceLabel] == nil {
                order.append(option.sourceLabel)
                buckets[option.sourceLabel] = []
            }
            buckets[option.sourceLabel, default: []].append(option)
        }
        return order.map { title in (title, buckets[title] ?? []) }
    }

    /// Default-visible local brains. The rest stay behind "更多本机模型".
    static let featuredLocalModelIDs: Set<String> = [defaultModel]

    static func isDefaultVisibleLocal(
        _ option: YishuConversationModelOption,
        selectedModel: String,
        selectedProvider: String
    ) -> Bool {
        featuredLocalModelIDs.contains(option.model)
            || (selectedProvider == localProvider && option.model == selectedModel)
    }

    static func featuredLocalModels(
        selectedModel: String,
        selectedProvider: String
    ) -> [YishuConversationModelOption] {
        localModels.filter {
            isDefaultVisibleLocal($0, selectedModel: selectedModel, selectedProvider: selectedProvider)
        }
    }

    static func moreLocalModels(
        selectedModel: String,
        selectedProvider: String
    ) -> [YishuConversationModelOption] {
        localModels.filter {
            !isDefaultVisibleLocal($0, selectedModel: selectedModel, selectedProvider: selectedProvider)
        }
    }

    static func authSections(
        authModels: [YishuAuthModel]
    ) -> [(title: String, models: [YishuConversationModelOption])] {
        sections(authModels: authModels).filter { $0.title != localSourceLabel }
    }

    /// Local Grok 4.5 was the previous product default. Replace it with 4.6.
    /// Leave ChatGPT / xAI selections and any other explicit local pick alone.
    static func resolvedSelection(
        storedModel: String?,
        storedProvider: String?
    ) -> (provider: String, model: String) {
        let supportedProviders = Set([
            localProvider,
            YishuAuthProvider.openAICodex.rawValue,
            YishuAuthProvider.xAI.rawValue,
        ])
        let provider = storedProvider.flatMap { supportedProviders.contains($0) ? $0 : nil }
            ?? localProvider
        let candidate = storedModel?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let model = (candidate?.isEmpty == false) ? candidate! : defaultModel
        if provider == localProvider, model == "grok-4.6" || model == "grok-4.5" {
            return (localProvider, defaultModel)
        }
        return (provider, model)
    }
}

enum YishuAccountSurfaceCopy {
    static let localGrokSource = "本机 Grok"
    static let chatgptSource = "ChatGPT"
    static let xaiSource = "xAI"

    static func selectedLine(label: String, source: String) -> String {
        "\(label) · \(source)"
    }

    static func headerSummary(
        chatGPTStatus: YishuAuthPublicStatus?,
        chatGPTLoading: Bool,
        xAIStatus: YishuAuthPublicStatus?,
        xAILoading: Bool
    ) -> String {
        [
            partyLine(name: chatgptSource, status: chatGPTStatus, isLoading: chatGPTLoading),
            partyLine(name: xaiSource, status: xAIStatus, isLoading: xAILoading),
        ].joined(separator: " · ")
    }

    static func partyLine(
        name: String,
        status: YishuAuthPublicStatus?,
        isLoading: Bool
    ) -> String {
        if isLoading, status == nil {
            return "\(name) 正在检查"
        }
        if status?.requiresRelogin == true {
            return "\(name) 需要重新登录"
        }
        let configured = status?.configured == true && status?.requiresRelogin != true
        if configured {
            if let accountLabel = status?.accountLabel, !accountLabel.isEmpty {
                return "\(name) \(accountLabel)"
            }
            return "\(name) 这台 Mac 上的订阅"
        }
        return "\(name) 未登录"
    }

    static func rowBadge(status: YishuAuthPublicStatus?) -> String {
        if let accountLabel = status?.accountLabel, !accountLabel.isEmpty {
            return accountLabel
        }
        return "这台 Mac 上的订阅"
    }
}

struct YishuAuthPublicStatus: Equatable {
    let provider: YishuAuthProvider
    let configured: Bool
    let authType: String
    let models: [YishuAuthModel]
    let requiresRelogin: Bool
    let isExperimental: Bool
    let accountLabel: String?

    var statusLabel: String {
        if requiresRelogin {
            return "需要重新登录"
        }
        if !configured {
            return "未登录"
        }
        if let accountLabel, !accountLabel.isEmpty {
            return "这台 Mac 上的 \(accountLabel)"
        }
        return "这台 Mac 上的订阅"
    }
}

enum YishuAuthPromptKind: Equatable {
    case text(placeholder: String?)
    case secret(placeholder: String?)
    case select(options: [YishuAuthPromptOption])
    case manualCode(placeholder: String?)
}

struct YishuAuthPromptOption: Identifiable, Equatable {
    let id: String
    let label: String
    let description: String?
}

struct YishuAuthPrompt: Identifiable, Equatable {
    let provider: YishuAuthProvider
    let id: String
    let message: String
    let kind: YishuAuthPromptKind
}

struct YishuAuthInfo: Equatable {
    let provider: YishuAuthProvider
    let message: String
    let links: [YishuAuthLink]
}

struct YishuAuthLink: Identifiable, Equatable {
    let url: URL
    let label: String
    var id: String { url.absoluteString + "|" + label }
}

struct YishuAuthURL: Equatable {
    let provider: YishuAuthProvider
    let url: URL
    let instructions: String?
}

struct YishuAuthDeviceCode: Equatable {
    let provider: YishuAuthProvider
    let userCode: String
    let verificationURI: URL
    let intervalSeconds: Int?
    let expiresInSeconds: Int?
}

struct YishuAuthProgress: Equatable {
    let provider: YishuAuthProvider
    let message: String
}

struct YishuAuthFailure: Equatable {
    let provider: YishuAuthProvider
    let code: String
    let message: String
}

/// This enum is the only auth event surface SwiftUI consumes. Raw provider
/// OAuth events and credential material stay inside the Pi/provider adapter.
enum YishuAuthEvent: Equatable {
    case status(YishuAuthPublicStatus)
    case prompt(YishuAuthPrompt)
    case info(YishuAuthInfo)
    case url(YishuAuthURL)
    case deviceCode(YishuAuthDeviceCode)
    case progress(YishuAuthProgress)
    case completed(YishuAuthPublicStatus)
    case failed(YishuAuthFailure)
    case loggedOut(YishuAuthPublicStatus)

    static let supportedTypes: Set<String> = [
        "auth.status",
        "auth.prompt",
        "auth.info",
        "auth.url",
        "auth.device_code",
        "auth.progress",
        "auth.completed",
        "auth.failed",
        "auth.logged_out",
    ]

    var provider: YishuAuthProvider? {
        switch self {
        case let .status(status), let .completed(status), let .loggedOut(status):
            return status.provider
        case let .prompt(prompt):
            return prompt.provider
        case let .info(info):
            return info.provider
        case let .url(url):
            return url.provider
        case let .deviceCode(code):
            return code.provider
        case let .progress(progress):
            return progress.provider
        case let .failed(failure):
            return failure.provider
        }
    }

    /// Decode a payload after its envelope has been validated. Every payload
    /// parser is strict: required fields, enum values, lengths, model/option
    /// caps, and HTTPS-only URLs are checked before a UI event is produced.
    static func decode(type: String, payload: [String: Any]) -> YishuAuthEvent? {
        switch type {
        case "auth.status":
            guard let status = YishuAuthPublicStatus(payload: payload) else { return nil }
            return .status(status)
        case "auth.prompt":
            guard let prompt = YishuAuthPrompt(payload: payload) else { return nil }
            return .prompt(prompt)
        case "auth.info":
            guard let info = YishuAuthInfo(payload: payload) else { return nil }
            return .info(info)
        case "auth.url":
            guard let url = YishuAuthURL(payload: payload) else { return nil }
            return .url(url)
        case "auth.device_code":
            guard let code = YishuAuthDeviceCode(payload: payload) else { return nil }
            return .deviceCode(code)
        case "auth.progress":
            guard let progress = YishuAuthProgress(payload: payload) else { return nil }
            return .progress(progress)
        case "auth.completed":
            guard let status = YishuAuthPublicStatus(payload: payload) else { return nil }
            return .completed(status)
        case "auth.failed":
            guard let failure = YishuAuthFailure(payload: payload) else { return nil }
            return .failed(failure)
        case "auth.logged_out":
            guard let status = YishuAuthPublicStatus(payload: payload) else { return nil }
            return .loggedOut(status)
        default:
            return nil
        }
    }

    /// Validate the complete runtime event envelope, not merely its payload.
    /// A nil result is intentionally non-diagnostic: malformed auth input must
    /// never echo a provider message, prompt, URL, or secret into logs/UI.
    static func decodeEnvelope(_ raw: [String: Any]) -> YishuAuthEnvelope? {
        let requiredKeys: Set<String> = [
            "schemaVersion", "type", "eventId", "requestId", "traceId", "occurredAt", "payload",
        ]
        guard Set(raw.keys) == requiredKeys,
              YishuAuthPayloadRules.isProtocolVersion(raw["schemaVersion"]),
              let type = raw["type"] as? String,
              supportedTypes.contains(type),
              let eventID = YishuAuthPayloadRules.uuidString(raw["eventId"]),
              let requestID = YishuAuthPayloadRules.uuidString(raw["requestId"]),
              let traceID = YishuAuthPayloadRules.uuidString(raw["traceId"]),
              let occurredAt = YishuAuthPayloadRules.iso8601Date(raw["occurredAt"]),
              let payload = raw["payload"] as? [String: Any],
              let event = decode(type: type, payload: payload) else {
            return nil
        }

        return YishuAuthEnvelope(
            type: type,
            eventID: eventID,
            requestID: requestID,
            traceID: traceID,
            occurredAt: occurredAt,
            event: event
        )
    }
}

struct YishuAuthEnvelope {
    let type: String
    let eventID: UUID
    let requestID: UUID
    let traceID: UUID
    let occurredAt: Date
    let event: YishuAuthEvent
}

private enum YishuAuthPayloadRules {
    static func hasOnlyKeys(
        _ payload: [String: Any],
        required: Set<String>,
        optional: Set<String> = []
    ) -> Bool {
        let keys = Set(payload.keys)
        return required.isSubset(of: keys) && keys.isSubset(of: required.union(optional))
    }

    static func requiredString(_ value: Any?, maxLength: Int) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= maxLength else { return nil }
        return trimmed
    }

    static func optionalString(_ value: Any?, maxLength: Int) -> String?? {
        guard let value else { return .some(nil) }
        guard let value = value as? String, value.count <= maxLength else { return nil }
        return .some(value)
    }

    static func uuidString(_ value: Any?) -> UUID? {
        guard let raw = requiredString(value, maxLength: 36),
              let uuid = UUID(uuidString: raw) else {
            return nil
        }
        return uuid
    }

    static func isProtocolVersion(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else {
            return false
        }
        let doubleValue = number.doubleValue
        return doubleValue.isFinite
            && doubleValue.rounded() == doubleValue
            && Int(doubleValue) == 1
    }

    static func bool(_ value: Any?) -> Bool? {
        guard let value else { return nil }
        guard !(value is NSNumber) || CFGetTypeID(value as! NSNumber) == CFBooleanGetTypeID() else {
            return nil
        }
        return value as? Bool
    }

    static func optionalBool(_ value: Any?) -> Bool?? {
        guard let value else { return .some(nil) }
        guard let parsed = bool(value) else { return nil }
        return .some(parsed)
    }

    static func positiveInt(_ value: Any?, max: Int = 86_400) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else {
            return nil
        }
        let doubleValue = number.doubleValue
        guard doubleValue.isFinite,
              doubleValue.rounded() == doubleValue,
              doubleValue > 0,
              doubleValue <= Double(max) else {
            return nil
        }
        return Int(doubleValue)
    }

    static func dictionaryArray(_ value: Any?, maxCount: Int) -> [[String: Any]]? {
        guard let array = value as? [Any], array.count <= maxCount else { return nil }
        let dictionaries = array.compactMap { $0 as? [String: Any] }
        guard dictionaries.count == array.count else { return nil }
        return dictionaries
    }

    static func httpsURL(_ value: Any?) -> URL? {
        guard let raw = requiredString(value, maxLength: 2_048),
              let url = URL(string: raw),
              url.scheme?.lowercased() == "https",
              url.host != nil else {
            return nil
        }
        return url
    }

    static func iso8601Date(_ value: Any?) -> Date? {
        guard let raw = requiredString(value, maxLength: 80) else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: raw) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: raw)
    }
}

private extension YishuAuthProvider {
    init?(payloadValue: Any?) {
        guard let raw = YishuAuthPayloadRules.requiredString(payloadValue, maxLength: 32) else {
            return nil
        }
        self.init(rawValue: raw)
    }
}

private extension YishuAuthPublicStatus {
    init?(payload: [String: Any]) {
        guard YishuAuthPayloadRules.hasOnlyKeys(
            payload,
            required: ["provider", "configured", "authType", "models"],
            optional: ["requiresRelogin", "experimental", "accountLabel"]
        ),
              let provider = YishuAuthProvider(payloadValue: payload["provider"]),
              let configured = YishuAuthPayloadRules.bool(payload["configured"]),
              let authType = YishuAuthPayloadRules.requiredString(payload["authType"], maxLength: 16),
              authType == "oauth",
              let rawModels = YishuAuthPayloadRules.dictionaryArray(payload["models"], maxCount: 16) else {
            return nil
        }

        var models: [YishuAuthModel] = []
        for rawModel in rawModels {
            guard YishuAuthPayloadRules.hasOnlyKeys(
                rawModel,
                required: ["provider", "id", "name"]
            ),
                  let modelProvider = YishuAuthProvider(payloadValue: rawModel["provider"]),
                  modelProvider == provider,
                  let id = YishuAuthPayloadRules.requiredString(rawModel["id"], maxLength: 160),
                  let name = YishuAuthPayloadRules.requiredString(rawModel["name"], maxLength: 200) else {
                return nil
            }
            models.append(YishuAuthModel(provider: modelProvider, id: id, name: name))
        }

        let requiresRelogin: Bool
        if let rawRequiresRelogin = payload["requiresRelogin"] {
            guard let parsed = YishuAuthPayloadRules.bool(rawRequiresRelogin) else { return nil }
            requiresRelogin = parsed
        } else {
            requiresRelogin = false
        }

        let isExperimental: Bool
        if let rawExperimental = payload["experimental"] {
            guard let experimental = YishuAuthPayloadRules.requiredString(rawExperimental, maxLength: 80),
                  experimental == "experimental_local_subscription" else {
                return nil
            }
            isExperimental = true
        } else {
            isExperimental = false
        }

        let accountLabel: String?
        if let rawAccountLabel = payload["accountLabel"] {
            guard let parsed = YishuAuthPayloadRules.requiredString(rawAccountLabel, maxLength: 120) else {
                return nil
            }
            accountLabel = parsed
        } else {
            accountLabel = nil
        }

        self.init(
            provider: provider,
            configured: configured,
            authType: authType,
            models: models,
            requiresRelogin: requiresRelogin,
            isExperimental: isExperimental,
            accountLabel: accountLabel
        )
    }
}

private extension YishuAuthPrompt {
    init?(payload: [String: Any]) {
        guard YishuAuthPayloadRules.hasOnlyKeys(
            payload,
            required: ["provider", "promptId", "prompt"]
        ),
              let provider = YishuAuthProvider(payloadValue: payload["provider"]),
              let promptID = YishuAuthPayloadRules.requiredString(payload["promptId"], maxLength: 36),
              UUID(uuidString: promptID) != nil,
              let promptObject = payload["prompt"] as? [String: Any],
              let type = YishuAuthPayloadRules.requiredString(promptObject["type"], maxLength: 20),
              let message = YishuAuthPayloadRules.requiredString(promptObject["message"], maxLength: 500) else {
            return nil
        }

        let placeholder = YishuAuthPayloadRules.optionalString(promptObject["placeholder"], maxLength: 200)
        let kind: YishuAuthPromptKind
        switch type {
        case "text":
            guard YishuAuthPayloadRules.hasOnlyKeys(
                promptObject,
                required: ["type", "message"],
                optional: ["placeholder"]
            ), let placeholder else { return nil }
            kind = .text(placeholder: placeholder)
        case "secret":
            guard YishuAuthPayloadRules.hasOnlyKeys(
                promptObject,
                required: ["type", "message"],
                optional: ["placeholder"]
            ), let placeholder else { return nil }
            kind = .secret(placeholder: placeholder)
        case "manual_code":
            guard YishuAuthPayloadRules.hasOnlyKeys(
                promptObject,
                required: ["type", "message"],
                optional: ["placeholder"]
            ), let placeholder else { return nil }
            kind = .manualCode(placeholder: placeholder)
        case "select":
            guard YishuAuthPayloadRules.hasOnlyKeys(
                promptObject,
                required: ["type", "message", "options"]
            ),
                  let rawOptions = YishuAuthPayloadRules.dictionaryArray(promptObject["options"], maxCount: 16) else {
                return nil
            }

            var options: [YishuAuthPromptOption] = []
            for rawOption in rawOptions {
                guard YishuAuthPayloadRules.hasOnlyKeys(
                    rawOption,
                    required: ["id", "label"],
                    optional: ["description"]
                ),
                      let id = YishuAuthPayloadRules.requiredString(rawOption["id"], maxLength: 120),
                      let label = YishuAuthPayloadRules.requiredString(rawOption["label"], maxLength: 200),
                      let description = YishuAuthPayloadRules.optionalString(rawOption["description"], maxLength: 500) else {
                    return nil
                }
                options.append(YishuAuthPromptOption(id: id, label: label, description: description))
            }
            kind = .select(options: options)
        default:
            return nil
        }

        self.init(provider: provider, id: promptID, message: message, kind: kind)
    }
}

private extension YishuAuthInfo {
    init?(payload: [String: Any]) {
        guard YishuAuthPayloadRules.hasOnlyKeys(
            payload,
            required: ["provider", "message"],
            optional: ["links"]
        ),
              let provider = YishuAuthProvider(payloadValue: payload["provider"]),
              let message = YishuAuthPayloadRules.requiredString(payload["message"], maxLength: 500) else {
            return nil
        }

        var links: [YishuAuthLink] = []
        if let rawLinks = payload["links"] {
            guard let dictionaries = YishuAuthPayloadRules.dictionaryArray(rawLinks, maxCount: 4) else {
                return nil
            }
            for rawLink in dictionaries {
                guard YishuAuthPayloadRules.hasOnlyKeys(
                    rawLink,
                    required: ["url"],
                    optional: ["label"]
                ),
                      let url = YishuAuthPayloadRules.httpsURL(rawLink["url"]),
                      let label = YishuAuthPayloadRules.optionalString(rawLink["label"], maxLength: 200) else {
                    return nil
                }
                links.append(YishuAuthLink(url: url, label: label ?? "打开链接"))
            }
        }
        self.init(provider: provider, message: message, links: links)
    }
}

private extension YishuAuthURL {
    init?(payload: [String: Any]) {
        guard YishuAuthPayloadRules.hasOnlyKeys(
            payload,
            required: ["provider", "url"],
            optional: ["instructions"]
        ),
              let provider = YishuAuthProvider(payloadValue: payload["provider"]),
              let url = YishuAuthPayloadRules.httpsURL(payload["url"]),
              let instructions = YishuAuthPayloadRules.optionalString(payload["instructions"], maxLength: 500) else {
            return nil
        }
        self.init(provider: provider, url: url, instructions: instructions)
    }
}

private extension YishuAuthDeviceCode {
    init?(payload: [String: Any]) {
        guard YishuAuthPayloadRules.hasOnlyKeys(
            payload,
            required: ["provider", "userCode", "verificationUri"],
            optional: ["intervalSeconds", "expiresInSeconds"]
        ),
              let provider = YishuAuthProvider(payloadValue: payload["provider"]),
              let userCode = YishuAuthPayloadRules.requiredString(payload["userCode"], maxLength: 200),
              let verificationURI = YishuAuthPayloadRules.httpsURL(payload["verificationUri"]) else {
            return nil
        }

        let intervalSeconds: Int?
        if let raw = payload["intervalSeconds"] {
            guard let value = YishuAuthPayloadRules.positiveInt(raw) else { return nil }
            intervalSeconds = value
        } else {
            intervalSeconds = nil
        }
        let expiresInSeconds: Int?
        if let raw = payload["expiresInSeconds"] {
            guard let value = YishuAuthPayloadRules.positiveInt(raw) else { return nil }
            expiresInSeconds = value
        } else {
            expiresInSeconds = nil
        }

        self.init(
            provider: provider,
            userCode: userCode,
            verificationURI: verificationURI,
            intervalSeconds: intervalSeconds,
            expiresInSeconds: expiresInSeconds
        )
    }
}

private extension YishuAuthProgress {
    init?(payload: [String: Any]) {
        guard YishuAuthPayloadRules.hasOnlyKeys(payload, required: ["provider", "message"]),
              let provider = YishuAuthProvider(payloadValue: payload["provider"]),
              let message = YishuAuthPayloadRules.requiredString(payload["message"], maxLength: 500) else {
            return nil
        }
        self.init(provider: provider, message: message)
    }
}

private extension YishuAuthFailure {
    init?(payload: [String: Any]) {
        guard YishuAuthPayloadRules.hasOnlyKeys(payload, required: ["provider", "code", "message"]),
              let provider = YishuAuthProvider(payloadValue: payload["provider"]),
              let code = YishuAuthPayloadRules.requiredString(payload["code"], maxLength: 32),
              ["cancelled", "invalid_request", "oauth_failed", "storage_failed", "relogin_required", "unavailable"].contains(code),
              let message = YishuAuthPayloadRules.requiredString(payload["message"], maxLength: 500) else {
            return nil
        }
        self.init(provider: provider, code: code, message: message)
    }
}
