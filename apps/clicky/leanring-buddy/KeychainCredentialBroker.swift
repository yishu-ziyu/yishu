import Foundation
import Security
enum KeychainCredentialBrokerError: LocalizedError, Equatable {
    case invalidReference
    case invalidProvider
    case invalidAccount
    case invalidSecret
    case itemAlreadyExists
    case credentialMissing
    case storageUnavailable
    case providerMismatch
    var errorDescription: String? {
        switch self {
        case .invalidReference, .invalidProvider, .invalidAccount, .providerMismatch:
            return "本机凭据配置无效。"
        case .invalidSecret:
            return "本机凭据为空。"
        case .itemAlreadyExists:
            return "本机凭据已存在且内容不同。"
        case .credentialMissing, .storageUnavailable:
            return "本机凭据不可用。"
        }
    }
}
enum KeychainCredentialBroker {
    static let servicePrefix = "com.yishu.credentials."
    private struct Reference {
        let service: String
        let account: String
        var string: String { "keychain://\(service)/\(account)" }
    }
    private static let mutationLock = NSLock()
    @discardableResult
    static func storeIfAbsent(
        account: String,
        secret: String,
        providerId: String
    ) throws -> String {
        let reference = try makeReference(account: account, providerId: providerId)
        guard !secret.isEmpty else { throw KeychainCredentialBrokerError.invalidSecret }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: reference.service,
            kSecAttrAccount as String: reference.account,
            kSecValueData as String: Data(secret.utf8),
        ]
        mutationLock.lock()
        defer { mutationLock.unlock() }
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem {
            guard (try? readParsed(reference)) == secret else {
                throw KeychainCredentialBrokerError.itemAlreadyExists
            }
            return reference.string
        }
        guard status == errSecSuccess else {
            throw KeychainCredentialBrokerError.storageUnavailable
        }
        return reference.string
    }
    static func read(reference: String) throws -> String {
        try readParsed(parseReference(reference))
    }
    static func validate(reference: String, expectedProviderId: String) throws {
        let parsed = try parseReference(reference)
        guard parsed.service == service(for: expectedProviderId) else {
            throw KeychainCredentialBrokerError.providerMismatch
        }
    }
    static func read(reference: String, expectedProviderId: String) throws -> String {
        try validate(reference: reference, expectedProviderId: expectedProviderId)
        return try read(reference: reference)
    }
    static func reference(account: String, providerId: String) throws -> String {
        try makeReference(account: account, providerId: providerId).string
    }
    private static func service(for providerId: String) -> String {
        servicePrefix + providerId
    }
    private static func makeReference(account: String, providerId: String) throws -> Reference {
        guard isSafePart(providerId) else { throw KeychainCredentialBrokerError.invalidProvider }
        guard isSafePart(account) else { throw KeychainCredentialBrokerError.invalidAccount }
        return Reference(service: service(for: providerId), account: account)
    }
    private static func parseReference(_ value: String) throws -> Reference {
        let prefix = "keychain://"
        guard value.hasPrefix(prefix) else { throw KeychainCredentialBrokerError.invalidReference }
        let parts = String(value.dropFirst(prefix.count))
            .split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2 else { throw KeychainCredentialBrokerError.invalidReference }
        let reference = Reference(service: String(parts[0]), account: String(parts[1]))
        guard reference.service.hasPrefix(servicePrefix),
              isSafePart(String(reference.service.dropFirst(servicePrefix.count))),
              isSafePart(reference.account) else {
            throw KeychainCredentialBrokerError.invalidReference
        }
        return reference
    }
    private static func isSafePart(_ value: String) -> Bool {
        !value.isEmpty && value.unicodeScalars.allSatisfy {
            $0.value >= 0x21 && $0.value <= 0x7E && $0.value != 0x2F
        }
    }
    private static func readParsed(_ reference: Reference) throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: reference.service,
            kSecAttrAccount as String: reference.account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            throw KeychainCredentialBrokerError.credentialMissing
        }
        guard status == errSecSuccess,
              let data = item as? Data,
              let secret = String(data: data, encoding: .utf8),
              !secret.isEmpty else {
            throw KeychainCredentialBrokerError.storageUnavailable
        }
        return secret
    }
}
