import Foundation

enum YishuModelConfigMigrationError: LocalizedError, Equatable {
    case invalidConfiguration
    case providerNotFound
    case inlineCredentialConflict
    case credentialConflict
    case credentialStoreFailed
    case readbackMismatch
    case concurrentModification
    case atomicWriteFailed
    case invalidEnvironmentName
    case noLegacyCredentials

    var errorDescription: String? {
        switch self {
        case .inlineCredentialConflict:
            return "本机模型配置同时包含新旧凭据引用。"
        case .credentialConflict:
            return "本机凭据已存在且内容不同，配置未改动。"
        case .credentialStoreFailed:
            return "本机凭据保存失败，配置未改动。"
        case .readbackMismatch:
            return "本机凭据校验失败，配置未改动。"
        case .concurrentModification:
            return "本机模型配置在迁移期间发生变化，配置未改动。"
        case .atomicWriteFailed:
            return "本机模型配置写入失败，原配置已保留。"
        case .noLegacyCredentials:
            return "没有需要迁移的旧式凭据。"
        default:
            return "本机模型配置无效。"
        }
    }
}

enum YishuModelConfigMigration {
    typealias Store = (_ account: String, _ secret: String, _ providerId: String) throws -> String
    typealias Read = (_ reference: String) throws -> String
    typealias Current = () throws -> Data
    typealias Writer = (_ data: Data) throws -> Void

    static let defaultAPIKeyEnvironment = "YISHU_LOCAL_MODEL_API_KEY"

    static func migratedData(
        from originalData: Data,
        providerId: String? = nil,
        storeCredential: @escaping Store,
        readCredential: @escaping Read,
        apiKeyEnvironment: String? = nil
    ) throws -> Data {
        let root = try parseRoot(originalData)
        guard let providers = root["providers"] as? [[String: Any]], !providers.isEmpty else {
            throw YishuModelConfigMigrationError.invalidConfiguration
        }
        let indices = providers.indices.filter {
            providerId == nil || providers[$0]["id"] as? String == providerId
        }
        guard providerId == nil || indices.count == 1 else {
            throw YishuModelConfigMigrationError.providerNotFound
        }
        var targets: [(Int, String, String, String)] = []
        var names = Set<String>()
        for index in indices {
            let provider = providers[index]
            guard let id = provider["id"] as? String, !id.isEmpty else {
                throw YishuModelConfigMigrationError.invalidConfiguration
            }
            guard let secret = provider["apiKey"] as? String, !secret.isEmpty else { continue }
            if let reference = provider["credentialRef"] as? String, !reference.isEmpty {
                throw YishuModelConfigMigrationError.inlineCredentialConflict
            }
            let name = try environmentName(provider: provider, id: id, override: apiKeyEnvironment)
            guard names.insert(name).inserted else {
                throw YishuModelConfigMigrationError.invalidEnvironmentName
            }
            targets.append((index, id, secret, name))
        }
        guard !targets.isEmpty else { throw YishuModelConfigMigrationError.noLegacyCredentials }

        var replacements: [(Int, String, String)] = []
        for (index, id, secret, name) in targets {
            let reference: String
            do {
                reference = try storeCredential(id, secret, id)
            } catch let error as KeychainCredentialBrokerError {
                if error == .itemAlreadyExists {
                    throw YishuModelConfigMigrationError.credentialConflict
                }
                throw YishuModelConfigMigrationError.credentialStoreFailed
            } catch {
                throw YishuModelConfigMigrationError.credentialStoreFailed
            }
            guard !reference.isEmpty else {
                throw YishuModelConfigMigrationError.credentialStoreFailed
            }
            do {
                guard try readCredential(reference) == secret else {
                    throw YishuModelConfigMigrationError.readbackMismatch
                }
            } catch let error as YishuModelConfigMigrationError {
                throw error
            } catch {
                throw YishuModelConfigMigrationError.credentialStoreFailed
            }
            replacements.append((index, reference, name))
        }

        var outputProviders = providers
        for (index, reference, name) in replacements {
            outputProviders[index]["credentialRef"] = reference
            outputProviders[index]["apiKeyEnv"] = name
            outputProviders[index].removeValue(forKey: "apiKey")
        }
        var output = root
        output["providers"] = outputProviders
        do {
            return try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
        } catch {
            throw YishuModelConfigMigrationError.invalidConfiguration
        }
    }

    @discardableResult
    static func migrateAndWrite(
        originalData: Data,
        currentData: @escaping Current,
        storeCredential: @escaping Store,
        readCredential: @escaping Read,
        writeAtomically: @escaping Writer,
        providerId: String? = nil,
        apiKeyEnvironment: String? = nil
    ) throws -> Data {
        let output = try migratedData(
            from: originalData,
            providerId: providerId,
            storeCredential: storeCredential,
            readCredential: readCredential,
            apiKeyEnvironment: apiKeyEnvironment
        )
        do {
            guard try currentData() == originalData else {
                throw YishuModelConfigMigrationError.concurrentModification
            }
        } catch let error as YishuModelConfigMigrationError {
            throw error
        } catch {
            throw YishuModelConfigMigrationError.concurrentModification
        }
        do {
            try writeAtomically(output)
        } catch let error as YishuModelConfigMigrationError {
            throw error
        } catch {
            throw YishuModelConfigMigrationError.atomicWriteFailed
        }
        return output
    }

    static func writeAtomically(
        _ data: Data,
        to destination: URL,
        fileManager: FileManager = .default
    ) throws {
        let directory = destination.deletingLastPathComponent()
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let temporary = directory.appendingPathComponent(
            ".\(destination.lastPathComponent).\(UUID().uuidString).tmp"
        )
        defer { try? fileManager.removeItem(at: temporary) }
        try data.write(to: temporary, options: [.atomic])
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        if fileManager.fileExists(atPath: destination.path) {
            _ = try fileManager.replaceItemAt(
                destination,
                withItemAt: temporary,
                backupItemName: nil,
                options: .usingNewMetadataOnly
            )
        } else {
            try fileManager.moveItem(at: temporary, to: destination)
        }
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
    }

    static func migrateDefaultConfiguration() throws {
        let destination = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent("Yishu", isDirectory: true)
            .appendingPathComponent("model-config.json", isDirectory: false)
        let original = try Data(contentsOf: destination, options: [.mappedIfSafe])
        _ = try migrateAndWrite(
            originalData: original,
            currentData: { try Data(contentsOf: destination, options: [.mappedIfSafe]) },
            storeCredential: { account, secret, providerId in
                try KeychainCredentialBroker.storeIfAbsent(
                    account: account,
                    secret: secret,
                    providerId: providerId
                )
            },
            readCredential: { try KeychainCredentialBroker.read(reference: $0) },
            writeAtomically: { try writeAtomically($0, to: destination) }
        )
    }

    private static func parseRoot(_ data: Data) throws -> [String: Any] {
        do {
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let defaultProvider = root["defaultProvider"] as? String,
                  let providers = root["providers"] as? [[String: Any]],
                  !providers.isEmpty,
                  providers.contains(where: { $0["id"] as? String == defaultProvider }) else {
                throw YishuModelConfigMigrationError.invalidConfiguration
            }
            return root
        } catch let error as YishuModelConfigMigrationError {
            throw error
        } catch {
            throw YishuModelConfigMigrationError.invalidConfiguration
        }
    }

    private static func environmentName(
        provider: [String: Any],
        id: String,
        override: String?
    ) throws -> String {
        let providerToken = id.uppercased().map {
            $0.isLetter || $0.isNumber ? String($0) : "_"
        }.joined()
        let generated = "YISHU_\(providerToken)_API_KEY"
        let name = override ?? provider["apiKeyEnv"] as? String
            ?? (id == "yishu-local-grok" ? defaultAPIKeyEnvironment : generated)
        guard isSafeEnvironmentName(name) else {
            throw YishuModelConfigMigrationError.invalidEnvironmentName
        }
        return name
    }

    private static func isSafeEnvironmentName(_ name: String) -> Bool {
        guard let first = name.unicodeScalars.first,
              first.value == 0x5F || (0x41...0x5A).contains(first.value) else { return false }
        return name.unicodeScalars.dropFirst().allSatisfy {
            (0x41...0x5A).contains($0.value)
                || (0x30...0x39).contains($0.value)
                || $0.value == 0x5F
        }
    }
}
