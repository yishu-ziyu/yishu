import Foundation
import Security

enum KeychainCredentialBroker {
    static let servicePrefix = "com.yishu.credentials."

    static func store(account: String, secret: String, providerId: String) throws -> String {
        let service = servicePrefix + providerId
        let payload = Data(secret.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: payload,
        ]
        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return "keychain://\(service)/\(account)"
    }

    static func read(reference: String) throws -> String {
        guard reference.hasPrefix("keychain://") else {
            throw NSError(domain: "YishuKeychain", code: 1)
        }
        let body = String(reference.dropFirst("keychain://".count))
        let parts = body.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { throw NSError(domain: "YishuKeychain", code: 2) }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: parts[0],
            kSecAttrAccount as String: parts[1],
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data, let secret = String(data: data, encoding: .utf8) else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return secret
    }

    static func delete(reference: String) throws {
        guard reference.hasPrefix("keychain://") else { return }
        let body = String(reference.dropFirst("keychain://".count))
        let parts = body.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: parts[0],
            kSecAttrAccount as String: parts[1],
        ]
        SecItemDelete(query as CFDictionary)
    }
}
