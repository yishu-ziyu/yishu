import Foundation
import Testing
@testable import Clicky

struct YishuCredentialMigrationTests {
    private let legacySecret = "fixture-secret-never-printed"

    @Test func runtimeInjectsOnlyDeclaredCredentialEnvironment() throws {
        let configuration = YishuLocalModelConfiguration(
            defaultProvider: "yishu-local-grok",
            providers: [
                YishuLocalModelProviderConfiguration(
                    id: "yishu-local-grok",
                    credentialRef: "keychain://com.yishu.credentials.yishu-local-grok/account",
                    apiKeyEnv: "YISHU_LOCAL_MODEL_API_KEY"
                ),
                YishuLocalModelProviderConfiguration(
                    id: "second",
                    apiKeyEnv: "SECOND_API_KEY"
                ),
            ]
        )
        let base = YishuVoiceProxySupervisor.minimumChildEnvironment(from: [
            "HOME": "/tmp/yishu-home",
            "PATH": "/usr/bin",
            "LANG": "zh_CN.UTF-8",
            "UNRELATED_API_KEY": "ambient-secret",
            "SSH_AUTH_SOCK": "/tmp/agent.sock",
        ])

        var readArguments: [(String, String)] = []
        let resolved = try YishuRuntimeCredentialEnvironment.resolve(
            configuration: configuration,
            readCredential: { reference, providerId in
                readArguments.append((reference, providerId))
                return "fixture-key"
            }
        )
        var childEnvironment = base
        for (name, value) in resolved {
            childEnvironment[name] = value
        }

        #expect(childEnvironment["YISHU_LOCAL_MODEL_API_KEY"] == "fixture-key")
        #expect(childEnvironment["SECOND_API_KEY"] == nil)
        #expect(childEnvironment["UNRELATED_API_KEY"] == nil)
        #expect(childEnvironment["SSH_AUTH_SOCK"] == nil)
        #expect(readArguments.count == 1)
        #expect(readArguments.first?.1 == "yishu-local-grok")
    }

    @Test func runtimeRejectsUnsupportedMissingAndMismatchedReferences() {
        let unsupported = YishuLocalModelConfiguration(
            defaultProvider: "local",
            providers: [
                YishuLocalModelProviderConfiguration(
                    id: "local",
                    credentialRef: "file:///tmp/secret",
                    apiKeyEnv: "LOCAL_API_KEY"
                ),
            ]
        )
        do {
            _ = try YishuRuntimeCredentialEnvironment.resolve(
                configuration: unsupported,
                readCredential: { _, _ in legacySecret }
            )
            Issue.record("unsupported references must fail closed")
        } catch let error as YishuRuntimeCredentialResolutionError {
            #expect(error == .unsupportedReference)
            #expect(error.localizedDescription.contains(legacySecret) == false)
        } catch {
            Issue.record("unexpected error: \(error)")
        }

        let missingEnvironment = YishuLocalModelConfiguration(
            defaultProvider: "local",
            providers: [
                YishuLocalModelProviderConfiguration(
                    id: "local",
                    credentialRef: "keychain://com.yishu.credentials.local/account"
                ),
            ]
        )
        #expect(throws: YishuRuntimeCredentialResolutionError.missingEnvironmentName) {
            _ = try YishuRuntimeCredentialEnvironment.resolve(
                configuration: missingEnvironment,
                readCredential: { _, _ in legacySecret }
            )
        }

        let mismatch = YishuLocalModelConfiguration(
            defaultProvider: "local",
            providers: [
                YishuLocalModelProviderConfiguration(
                    id: "local",
                    credentialRef: "keychain://com.yishu.credentials.other/account",
                    apiKeyEnv: "LOCAL_API_KEY"
                ),
            ]
        )
        #expect(throws: YishuRuntimeCredentialResolutionError.providerMismatch) {
            _ = try YishuRuntimeCredentialEnvironment.resolve(
                configuration: mismatch,
                readCredential: { _, _ in legacySecret }
            )
        }
    }

    @MainActor
    @Test func productionDefaultWithoutReferenceDoesNotReadOrInjectASecret() throws {
        let configuration = YishuLocalModelConfiguration(
            defaultProvider: "yishu-local-grok",
            providers: [
                YishuLocalModelProviderConfiguration(
                    id: "yishu-local-grok",
                    apiKey: legacySecret,
                    apiKeyEnv: "YISHU_LOCAL_MODEL_API_KEY"
                ),
            ]
        )
        var readerCalled = false
        var environment = ["PATH": "/usr/bin"]
        try YishuRuntimeCredentialEnvironment.apply(
            configuration: configuration,
            to: &environment,
            readCredential: { _, _ in
                readerCalled = true
                return legacySecret
            }
        )
        #expect(environment == ["PATH": "/usr/bin"])
        #expect(!readerCalled)
    }

    @Test func atomicWriterReplacesConfigWithPrivatePermissions() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("yishu-credential-test-\(UUID().uuidString)", isDirectory: true)
        let destination = directory.appendingPathComponent("model-config.json")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("legacy".utf8).write(to: destination)

        let replacement = Data("{\"credentialRef\":\"fixture\"}".utf8)
        try YishuModelConfigMigration.writeAtomically(replacement, to: destination)

        #expect(try Data(contentsOf: destination) == replacement)
        let attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }

    @Test func migrationRedactsInlineSecretOnlyAfterVerifiedStore() throws {
        var stored: [(String, String, String)] = []
        var writerCalls = 0
        let original = legacyConfigData()
        let migrated = try YishuModelConfigMigration.migrateAndWrite(
            originalData: original,
            currentData: { original },
            storeCredential: { account, secret, providerId in
                stored.append((account, secret, providerId))
                return "keychain://com.yishu.credentials.\(providerId)/\(account)"
            },
            readCredential: { _ in legacySecret },
            writeAtomically: { data in
                writerCalls += 1
                // The writer sees the redacted replacement, never the inline key.
                // The assertion intentionally inspects bytes only in memory.
                // (The fixture secret is never logged or sent over a protocol.)
                // swift-testing assertions may run synchronously here.
                //
                // Keep this closure free of any real file I/O.
                #expect(String(decoding: data, as: UTF8.self).contains(legacySecret) == false)
            }
        )

        let text = String(decoding: migrated, as: UTF8.self)
        #expect(!text.contains("apiKey\""))
        #expect(!text.contains(legacySecret))
        #expect(text.contains("credentialRef"))
        #expect(text.contains("apiKeyEnv"))
        #expect(stored.count == 1)
        #expect(stored.first?.0 == "yishu-local-grok")
        #expect(stored.first?.1 == legacySecret)
        #expect(stored.first?.2 == "yishu-local-grok")
        #expect(writerCalls == 1)
    }

    @Test func migrationStoreConflictLeavesOriginalAndDoesNotRewrite() {
        let original = legacyConfigData()
        var writerCalls = 0
        do {
            _ = try YishuModelConfigMigration.migrateAndWrite(
                originalData: original,
                currentData: { original },
                storeCredential: { _, _, _ in
                    throw KeychainCredentialBrokerError.itemAlreadyExists
                },
                readCredential: { _ in legacySecret },
                writeAtomically: { _ in writerCalls += 1 }
            )
            Issue.record("credential conflict must fail")
        } catch let error as YishuModelConfigMigrationError {
            #expect(error == .credentialConflict)
            #expect(error.localizedDescription.contains(legacySecret) == false)
        } catch {
            Issue.record("unexpected error: \(error)")
        }
        #expect(writerCalls == 0)
        #expect(String(decoding: original, as: UTF8.self).contains(legacySecret))
    }

    @Test func migrationStoreFailureLeavesOriginalAndDoesNotRewrite() {
        let original = legacyConfigData()
        var writerCalls = 0
        do {
            _ = try YishuModelConfigMigration.migrateAndWrite(
                originalData: original,
                currentData: { original },
                storeCredential: { _, _, _ in throw TestCredentialFailure.failed },
                readCredential: { _ in legacySecret },
                writeAtomically: { _ in writerCalls += 1 }
            )
            Issue.record("storage failure must fail")
        } catch let error as YishuModelConfigMigrationError {
            #expect(error == .credentialStoreFailed)
        } catch {
            Issue.record("unexpected error: \(error)")
        }
        #expect(writerCalls == 0)
        #expect(String(decoding: original, as: UTF8.self).contains(legacySecret))
    }

    @Test func migrationReadbackMismatchLeavesOriginalAndDoesNotRewrite() {
        let original = legacyConfigData()
        var writerCalls = 0
        do {
            _ = try YishuModelConfigMigration.migrateAndWrite(
                originalData: original,
                currentData: { original },
                storeCredential: { _, _, _ in "keychain://com.yishu.credentials.yishu-local-grok/yishu-local-grok" },
                readCredential: { _ in "different-fixture-secret" },
                writeAtomically: { _ in writerCalls += 1 }
            )
            Issue.record("readback mismatch must fail")
        } catch let error as YishuModelConfigMigrationError {
            #expect(error == .readbackMismatch)
        } catch {
            Issue.record("unexpected error: \(error)")
        }
        #expect(writerCalls == 0)
        #expect(String(decoding: original, as: UTF8.self).contains(legacySecret))
    }

    @Test func migrationConcurrentChangeAndAtomicWriteFailurePreserveSource() {
        let original = legacyConfigData()
        let changed = Data("{\"changed\":true}".utf8)
        var writerCalls = 0
        do {
            _ = try YishuModelConfigMigration.migrateAndWrite(
                originalData: original,
                currentData: { changed },
                storeCredential: { _, _, providerId in
                    "keychain://com.yishu.credentials.\(providerId)/\(providerId)"
                },
                readCredential: { _ in legacySecret },
                writeAtomically: { _ in writerCalls += 1 }
            )
            Issue.record("concurrent config changes must fail")
        } catch let error as YishuModelConfigMigrationError {
            #expect(error == .concurrentModification)
        } catch {
            Issue.record("unexpected error: \(error)")
        }
        #expect(writerCalls == 0)

        do {
            _ = try YishuModelConfigMigration.migrateAndWrite(
                originalData: original,
                currentData: { original },
                storeCredential: { _, _, providerId in
                    "keychain://com.yishu.credentials.\(providerId)/\(providerId)"
                },
                readCredential: { _ in legacySecret },
                writeAtomically: { _ in throw TestCredentialFailure.failed }
            )
            Issue.record("atomic writer failure must fail")
        } catch let error as YishuModelConfigMigrationError {
            #expect(error == .atomicWriteFailed)
        } catch {
            Issue.record("unexpected error: \(error)")
        }
        #expect(String(decoding: original, as: UTF8.self).contains(legacySecret))
    }

    @Test func keychainReferenceValidationNeverTouchesTheKeychainForMismatch() {
        #expect(throws: KeychainCredentialBrokerError.providerMismatch) {
            try KeychainCredentialBroker.validate(
                reference: "keychain://com.yishu.credentials.other/account",
                expectedProviderId: "local"
            )
        }
        #expect(throws: KeychainCredentialBrokerError.invalidReference) {
            try KeychainCredentialBroker.validate(
                reference: "https://example.invalid/credential",
                expectedProviderId: "local"
            )
        }
    }

    private func legacyConfigData() -> Data {
        Data(
            """
            {
              "defaultProvider": "yishu-local-grok",
              "providers": [
                {
                  "id": "yishu-local-grok",
                  "name": "fixture",
                  "baseUrl": "http://127.0.0.1:8317/v1",
                  "apiKey": "\(legacySecret)",
                  "models": ["grok-4.6"]
                }
              ]
            }
            """.utf8
        )
    }
}

private enum TestCredentialFailure: Error {
    case failed
}
