//
//  YishuVoiceProxySupervisorTests.swift
//  leanring-buddyTests
//
//  Status copy and readiness rules for the local 8787 voice proxy.
//  Process-policy tests stay pure: no real 8787 launch from unit tests.
//

import Foundation
import Testing
@testable import Clicky

struct YishuVoiceProxySupervisorTests {
    @Test func onlyReadyReportsOnlineChip() {
        #expect(YishuVoiceProxyAvailability.ready.statusChip == "在线")
        #expect(YishuVoiceProxyAvailability.starting.statusChip != "在线")
        #expect(YishuVoiceProxyAvailability.portBusy.statusChip != "在线")
        #expect(YishuVoiceProxyAvailability.missingBundle.statusChip != "在线")
        #expect(YishuVoiceProxyAvailability.missingNode.statusChip != "在线")
        #expect(
            YishuVoiceProxyAvailability.missingCredentials(pathHint: "/tmp/x")
                .statusChip != "在线"
        )
        #expect(
            YishuVoiceProxyAvailability.launchFailed(summary: "x").statusChip != "在线"
        )
        #expect(
            YishuVoiceProxyAvailability.unhealthy(summary: "x").statusChip != "在线"
        )
        #expect(YishuVoiceProxyAvailability.stopped.statusChip != "在线")
    }

    @Test func recoveryMessagesStayActionableAndSecretFree() {
        let missing = YishuVoiceProxyAvailability.missingCredentials(
            pathHint: "/Users/demo/Library/Application Support/Yishu/Worker/.dev.vars"
        )
        #expect(missing.recoveryMessage.contains("重试"))
        #expect(missing.recoveryMessage.contains("Yishu/Worker/.dev.vars"))
        #expect(!missing.recoveryMessage.lowercased().contains("api_key"))
        #expect(!missing.recoveryMessage.contains("sk-"))

        let busy = YishuVoiceProxyAvailability.portBusy
        #expect(busy.recoveryMessage.contains("8787"))
        #expect(busy.recoveryMessage.contains("重试"))
        #expect(busy.statusChip == "语音不可用")
    }

    @Test func preferredCredentialsPathIsOutsideAppBundle() {
        let url = YishuVoiceProxySupervisor.preferredCredentialsURL()
        #expect(url.path.contains("Application Support/Yishu/Worker"))
        #expect(url.lastPathComponent == ".dev.vars")
        #expect(!url.path.contains(".app/Contents"))
    }

    @Test func readyFlagMatchesIsReady() {
        #expect(YishuVoiceProxyAvailability.ready.isReady)
        #expect(!YishuVoiceProxyAvailability.starting.isReady)
        #expect(!YishuVoiceProxyAvailability.stopped.isReady)
    }

    @Test func processPolicyRecognizesYishuVoiceProxyOnly() {
        let buildOrphan =
            "/Users/me/.build/clicky-derived-data/Build/Products/Debug/Clicky.app/"
            + "Contents/Resources/YishuRuntime/bin/node "
            + "/Users/me/.build/clicky-derived-data/Build/Products/Debug/Clicky.app/"
            + "Contents/Resources/YishuVoiceProxy/local-server.mjs"
        let formal =
            "/Applications/Clicky.app/Contents/Resources/YishuRuntime/bin/node "
            + "/Applications/Clicky.app/Contents/Resources/YishuVoiceProxy/local-server.mjs"
        let worker =
            "/opt/homebrew/bin/node /Users/me/Documents/repo/apps/clicky/worker/local-server.mjs"
        let foreign = "/usr/local/bin/node /tmp/other-service.mjs"
        let empty = "   "

        #expect(YishuVoiceProxyProcessPolicy.isYishuVoiceProxyCommandLine(buildOrphan))
        #expect(YishuVoiceProxyProcessPolicy.isYishuVoiceProxyCommandLine(formal))
        #expect(YishuVoiceProxyProcessPolicy.isYishuVoiceProxyCommandLine(worker))
        #expect(!YishuVoiceProxyProcessPolicy.isYishuVoiceProxyCommandLine(foreign))
        #expect(!YishuVoiceProxyProcessPolicy.isYishuVoiceProxyCommandLine(empty))

        let preferred =
            "/Applications/Clicky.app/Contents/Resources/YishuVoiceProxy/local-server.mjs"
        #expect(
            YishuVoiceProxyProcessPolicy.disposition(
                commandLine: formal,
                preferredEntryPath: preferred
            ) == .preferred
        )
        #expect(
            YishuVoiceProxyProcessPolicy.disposition(
                commandLine: foreign,
                preferredEntryPath: preferred
            ) == .foreign
        )
        #expect(
            YishuVoiceProxyProcessPolicy.disposition(
                commandLine: empty,
                preferredEntryPath: preferred
            ) == .unknown
        )
        #expect(YishuVoiceProxyProcessPolicy.looksLikeBuildProductPath(buildOrphan))
        #expect(!YishuVoiceProxyProcessPolicy.looksLikeBuildProductPath(formal))
    }

    @Test func onlyTrueOrphansAreReclaimableLiveParentIsPreserved() {
        let preferred =
            "/Applications/Clicky.app/Contents/Resources/YishuVoiceProxy/local-server.mjs"
        let buildProxy =
            "/Users/me/.build/clicky-derived-data/Build/Products/Debug/Clicky.app/"
            + "Contents/Resources/YishuRuntime/bin/node "
            + "/Users/me/.build/clicky-derived-data/Build/Products/Debug/Clicky.app/"
            + "Contents/Resources/YishuVoiceProxy/local-server.mjs"
        let shellWorker =
            "/opt/homebrew/bin/node /Users/me/repo/apps/clicky/worker/local-server.mjs"
        let formal =
            "/Applications/Clicky.app/Contents/Resources/YishuRuntime/bin/node "
            + preferred
        let selfPID: Int32 = 9001
        let otherClickyPID: Int32 = 8002

        let orphanPPID1 = YishuVoiceProxyParentFacts(parentPID: 1, parentIsAlive: true)
        let deadParent = YishuVoiceProxyParentFacts(parentPID: 4242, parentIsAlive: false)
        let liveShell = YishuVoiceProxyParentFacts(parentPID: 5555, parentIsAlive: true)
        let ownedBySelf = YishuVoiceProxyParentFacts(parentPID: selfPID, parentIsAlive: true)
        let ownedByOtherClicky = YishuVoiceProxyParentFacts(
            parentPID: otherClickyPID,
            parentIsAlive: true
        )
        let unknownParent = YishuVoiceProxyParentFacts.unknown()
        let parentPIDZero = YishuVoiceProxyParentFacts(
            parentPID: 0,
            parentIsAlive: true,
            parentKnown: true
        )

        #expect(orphanPPID1.isOrphanedFromParent)
        #expect(deadParent.isOrphanedFromParent)
        #expect(!liveShell.isOrphanedFromParent)
        #expect(!unknownParent.isOrphanedFromParent)
        #expect(!unknownParent.parentKnown)
        #expect(!parentPIDZero.isOrphanedFromParent)

        // Build path alone is NOT enough — without parent facts, refuse kill.
        #expect(
            YishuVoiceProxyProcessPolicy.disposition(
                commandLine: buildProxy,
                preferredEntryPath: preferred,
                parent: nil
            ) == .liveParentOwned
        )
        #expect(
            !YishuVoiceProxyProcessPolicy.isSafeToReclaim(
                YishuVoiceProxyProcessPolicy.disposition(
                    commandLine: buildProxy,
                    preferredEntryPath: preferred,
                    parent: nil
                )
            )
        )

        // True orphans: PPID=1 or dead parent.
        #expect(
            YishuVoiceProxyProcessPolicy.disposition(
                commandLine: buildProxy,
                preferredEntryPath: preferred,
                parent: orphanPPID1
            ) == .reclaimableOrphan
        )
        #expect(
            YishuVoiceProxyProcessPolicy.disposition(
                commandLine: buildProxy,
                preferredEntryPath: preferred,
                parent: deadParent
            ) == .reclaimableOrphan
        )
        #expect(
            YishuVoiceProxyProcessPolicy.isSafeToReclaim(
                YishuVoiceProxyProcessPolicy.disposition(
                    commandLine: buildProxy,
                    preferredEntryPath: preferred,
                    parent: orphanPPID1
                )
            )
        )

        // Active shell worker must stay (port busy, no kill).
        #expect(
            YishuVoiceProxyProcessPolicy.disposition(
                commandLine: shellWorker,
                preferredEntryPath: preferred,
                parent: liveShell
            ) == .liveParentOwned
        )
        #expect(
            !YishuVoiceProxyProcessPolicy.isSafeToReclaim(
                YishuVoiceProxyProcessPolicy.disposition(
                    commandLine: shellWorker,
                    preferredEntryPath: preferred,
                    parent: liveShell
                )
            )
        )

        // Preferred path + this process as parent → owned (.preferred).
        #expect(
            YishuVoiceProxyProcessPolicy.disposition(
                commandLine: formal,
                preferredEntryPath: preferred,
                parent: ownedBySelf,
                currentProcessPID: selfPID
            ) == .preferred
        )
        #expect(
            YishuVoiceProxyProcessPolicy.isOwnedByCurrentProcess(
                disposition: .preferred,
                parent: ownedBySelf,
                currentProcessPID: selfPID
            )
        )
        #expect(
            !YishuVoiceProxyProcessPolicy.isSafeToReclaim(
                YishuVoiceProxyProcessPolicy.disposition(
                    commandLine: formal,
                    preferredEntryPath: preferred,
                    parent: ownedBySelf,
                    currentProcessPID: selfPID
                )
            )
        )

        // Preferred path + other live Clicky parent → portBusy, no adopt, no kill.
        #expect(
            YishuVoiceProxyProcessPolicy.disposition(
                commandLine: formal,
                preferredEntryPath: preferred,
                parent: ownedByOtherClicky,
                currentProcessPID: selfPID
            ) == .liveParentOwned
        )
        #expect(
            !YishuVoiceProxyProcessPolicy.isSafeToReclaim(
                YishuVoiceProxyProcessPolicy.disposition(
                    commandLine: formal,
                    preferredEntryPath: preferred,
                    parent: ownedByOtherClicky,
                    currentProcessPID: selfPID
                )
            )
        )
        #expect(
            !YishuVoiceProxyProcessPolicy.isOwnedByCurrentProcess(
                disposition: .liveParentOwned,
                parent: ownedByOtherClicky,
                currentProcessPID: selfPID
            )
        )

        // Preferred path orphan → reclaimable (path alone was never ownership).
        #expect(
            YishuVoiceProxyProcessPolicy.disposition(
                commandLine: formal,
                preferredEntryPath: preferred,
                parent: orphanPPID1,
                currentProcessPID: selfPID
            ) == .reclaimableOrphan
        )
        #expect(
            YishuVoiceProxyProcessPolicy.isSafeToReclaim(
                YishuVoiceProxyProcessPolicy.disposition(
                    commandLine: formal,
                    preferredEntryPath: preferred,
                    parent: orphanPPID1,
                    currentProcessPID: selfPID
                )
            )
        )

        // Unknown PPID → fail closed, never orphan, never owned.
        #expect(
            YishuVoiceProxyProcessPolicy.disposition(
                commandLine: formal,
                preferredEntryPath: preferred,
                parent: unknownParent,
                currentProcessPID: selfPID
            ) == .liveParentOwned
        )
        #expect(
            YishuVoiceProxyProcessPolicy.disposition(
                commandLine: buildProxy,
                preferredEntryPath: preferred,
                parent: unknownParent,
                currentProcessPID: selfPID
            ) == .liveParentOwned
        )
        #expect(
            !YishuVoiceProxyProcessPolicy.isSafeToReclaim(
                YishuVoiceProxyProcessPolicy.disposition(
                    commandLine: buildProxy,
                    preferredEntryPath: preferred,
                    parent: unknownParent,
                    currentProcessPID: selfPID
                )
            )
        )
        #expect(
            !YishuVoiceProxyProcessPolicy.isSafeToReclaim(
                YishuVoiceProxyProcessPolicy.disposition(
                    commandLine: buildProxy,
                    preferredEntryPath: preferred,
                    parent: parentPIDZero,
                    currentProcessPID: selfPID
                )
            )
        )
    }

    @Test func unitTestEnvironmentSkipsRealProxyLifecycle() {
        // XCTest always sets configuration path; policy must keep unit tests off 8787.
        #expect(YishuVoiceProxySupervisor.shouldSkipRealProxyLifecycle)
    }
}
