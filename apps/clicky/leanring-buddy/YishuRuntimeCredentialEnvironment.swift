import Foundation

struct YishuLocalModelConfiguration: Decodable, Equatable {
    let defaultProvider: String
    let providers: [YishuLocalModelProviderConfiguration]

    static func decode(data: Data) throws -> Self {
        try JSONDecoder().decode(Self.self, from: data)
    }
}

struct YishuLocalModelProviderConfiguration: Decodable, Equatable {
    let id: String
    let credentialRef: String?
    let apiKey: String?
    let apiKeyEnv: String?

    init(id: String, credentialRef: String? = nil, apiKey: String? = nil, apiKeyEnv: String? = nil) {
        self.id = id
        self.credentialRef = credentialRef
        self.apiKey = apiKey
        self.apiKeyEnv = apiKeyEnv
    }
}

enum YishuRuntimeCredentialResolutionError: LocalizedError, Equatable {
    case invalidConfiguration
    case inlineSecretUnsupported
    case unsupportedReference
    case missingEnvironmentName
    case invalidEnvironmentName
    case duplicateEnvironmentName
    case credentialUnavailable
    case providerMismatch

    var errorDescription: String? {
        switch self {
        case .inlineSecretUnsupported:
            return "本机模型配置同时包含新旧凭据。"
        case .credentialUnavailable:
            return "本机模型凭据不可用。"
        default:
            return "本机模型凭据配置无效。"
        }
    }
}

enum YishuRuntimeCredentialEnvironment {
    typealias CredentialReader = (_ reference: String, _ providerId: String) throws -> String

    private static let protectedNames: Set<String> = [
        "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
        "YISHU_RUNTIME_MODE", "YISHU_PRODUCT_KERNEL", "YISHU_STORE_BACKEND",
        "YISHU_STORE_DIR", "YISHU_USER_NAME", "YISHU_AUTH_WATCHDOG_MS",
        "YISHU_VOICE_PROXY_TOKEN", "NO_COLOR",
    ]

    static func resolve(
        configuration: YishuLocalModelConfiguration,
        readCredential: @escaping CredentialReader
    ) throws -> [String: String] {
        guard !configuration.defaultProvider.isEmpty,
              configuration.providers.contains(where: { $0.id == configuration.defaultProvider }),
              Set(configuration.providers.map(\.id)).count == configuration.providers.count else {
            throw YishuRuntimeCredentialResolutionError.invalidConfiguration
        }
        var result: [String: String] = [:]
        for provider in configuration.providers {
            guard !provider.id.isEmpty else {
                throw YishuRuntimeCredentialResolutionError.invalidConfiguration
            }
            let hasInlineKey = provider.apiKey?.isEmpty == false
            if let name = provider.apiKeyEnv, !isSafeEnvironmentName(name) {
                throw YishuRuntimeCredentialResolutionError.invalidEnvironmentName
            }
            guard let reference = provider.credentialRef else {
                // During migration the Node runtime continues to own the
                // legacy field. Swift neither copies nor logs that value.
                continue
            }
            if hasInlineKey {
                throw YishuRuntimeCredentialResolutionError.inlineSecretUnsupported
            }
            guard !reference.isEmpty else {
                throw YishuRuntimeCredentialResolutionError.unsupportedReference
            }
            guard let name = provider.apiKeyEnv, !name.isEmpty else {
                throw YishuRuntimeCredentialResolutionError.missingEnvironmentName
            }
            do {
                try KeychainCredentialBroker.validate(reference: reference, expectedProviderId: provider.id)
            } catch KeychainCredentialBrokerError.providerMismatch {
                throw YishuRuntimeCredentialResolutionError.providerMismatch
            } catch {
                throw YishuRuntimeCredentialResolutionError.unsupportedReference
            }
            let key: String
            do {
                key = try readCredential(reference, provider.id)
            } catch {
                throw YishuRuntimeCredentialResolutionError.credentialUnavailable
            }
            guard !key.isEmpty else {
                throw YishuRuntimeCredentialResolutionError.credentialUnavailable
            }
            guard result[name] == nil else {
                throw YishuRuntimeCredentialResolutionError.duplicateEnvironmentName
            }
            result[name] = key
        }
        return result
    }

    static func apply(
        configuration: YishuLocalModelConfiguration,
        to environment: inout [String: String],
        readCredential: @escaping CredentialReader
    ) throws {
        for (name, value) in try resolve(configuration: configuration, readCredential: readCredential) {
            environment[name] = value
        }
    }

    /// Resolve references only at the signed Clicky to Runtime launch boundary.
    static func applyDefaultConfiguration(
        to environment: inout [String: String],
        fileManager: FileManager = .default
    ) throws {
        guard let support = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else { return }
        let configURL = support
            .appendingPathComponent("Yishu", isDirectory: true)
            .appendingPathComponent("model-config.json", isDirectory: false)
        guard fileManager.fileExists(atPath: configURL.path) else { return }
        let configuration = try YishuLocalModelConfiguration.decode(
            data: Data(contentsOf: configURL, options: [.mappedIfSafe])
        )
        try apply(
            configuration: configuration,
            to: &environment,
            readCredential: { reference, providerId in
                try KeychainCredentialBroker.read(
                    reference: reference,
                    expectedProviderId: providerId
                )
            }
        )
    }

    private static func isSafeEnvironmentName(_ name: String) -> Bool {
        guard !protectedNames.contains(name),
              let first = name.unicodeScalars.first,
              first.value == 0x5F || (0x41...0x5A).contains(first.value) else { return false }
        return name.unicodeScalars.dropFirst().allSatisfy {
            (0x41...0x5A).contains($0.value)
                || (0x30...0x39).contains($0.value)
                || $0.value == 0x5F
        }
    }
}
