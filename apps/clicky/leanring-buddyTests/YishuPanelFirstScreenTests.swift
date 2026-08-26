//
//  YishuPanelFirstScreenTests.swift
//  leanring-buddyTests
//
//  First-screen copy, intro vs activation, and last-verified projection.
//

import Foundation
import Testing
@testable import Clicky

struct YishuPanelFirstScreenTests {
    @Test func promiseReplacesHeyClickyCopy() {
        #expect(YishuPanelFirstScreenCopy.promise.contains("看懂"))
        #expect(YishuPanelFirstScreenCopy.promise.contains("记住这个项目"))
        #expect(YishuPanelFirstScreenCopy.promise.contains("验证"))
        #expect(YishuPanelFirstScreenCopy.promise.contains("完成"))
        #expect(!YishuPanelFirstScreenCopy.promise.contains("Runtime"))
        #expect(!YishuPanelFirstScreenCopy.promise.contains("Pi"))
        for fragment in YishuPanelFirstScreenCopy.forbiddenHeyClickyFragments {
            #expect(YishuPanelFirstScreenCopy.promise != fragment)
            #expect(!YishuPanelFirstScreenCopy.promise.contains("帮你完成并告诉你结果"))
            #expect(fragment.contains("帮你完成并告诉你结果"))
        }
    }

    @Test func startIsIntroNotActivation() {
        let suiteName = "yishu.panel.first.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            Issue.record("failed to create suite")
            return
        }
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(YishuActivationPolicy.introSeen(in: defaults) == false)
        #expect(YishuActivationPolicy.isActivated(in: defaults) == false)
        #expect(
            YishuActivationPolicy.shouldShowStartButton(
                introSeen: false,
                permissionsGranted: true
            )
        )
        #expect(
            !YishuActivationPolicy.shouldShowStartButton(
                introSeen: true,
                permissionsGranted: true
            )
        )
        #expect(
            !YishuActivationPolicy.shouldShowStartButton(
                introSeen: false,
                permissionsGranted: false
            )
        )

        YishuActivationPolicy.markIntroSeen(in: defaults)
        #expect(YishuActivationPolicy.introSeen(in: defaults))
        #expect(YishuActivationPolicy.isActivated(in: defaults) == false)
        #expect(
            !YishuActivationPolicy.shouldActivate(
                hasVerifiedAction: false,
                hasVisibleMemoryReadback: false
            )
        )
    }

    @Test func legacyOnboardingKeyCountsAsIntroSeenWithoutBeingActivationEvidence() {
        let suiteName = "yishu.panel.legacy.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            Issue.record("failed to create suite")
            return
        }
        defer { defaults.removePersistentDomain(forName: suiteName) }

        defaults.set(true, forKey: YishuActivationPolicy.onboardingCompletedKey)
        #expect(YishuActivationPolicy.introSeen(in: defaults))
        #expect(YishuActivationPolicy.isActivated(in: defaults))
        #expect(
            YishuActivationPolicy.shouldAutoShowCursor(
                introSeen: YishuActivationPolicy.introSeen(in: defaults),
                permissionsGranted: true,
                cursorEnabled: true
            )
        )
        #expect(
            !YishuActivationPolicy.shouldOpenPanelOnLaunch(
                introSeen: true,
                permissionsGranted: true
            )
        )
    }

    @Test func cursorAutoShowUsesIntroSeenNotActivation() {
        #expect(
            YishuActivationPolicy.shouldAutoShowCursor(
                introSeen: true,
                permissionsGranted: true,
                cursorEnabled: true
            )
        )
        #expect(
            !YishuActivationPolicy.shouldAutoShowCursor(
                introSeen: false,
                permissionsGranted: true,
                cursorEnabled: true
            )
        )
        #expect(
            !YishuActivationPolicy.shouldAutoShowCursor(
                introSeen: true,
                permissionsGranted: false,
                cursorEnabled: true
            )
        )
        #expect(
            !YishuActivationPolicy.shouldAutoShowCursor(
                introSeen: true,
                permissionsGranted: true,
                cursorEnabled: false
            )
        )
        #expect(
            YishuActivationPolicy.shouldOpenPanelOnLaunch(
                introSeen: false,
                permissionsGranted: true
            )
        )
        #expect(
            YishuActivationPolicy.shouldOpenPanelOnLaunch(
                introSeen: true,
                permissionsGranted: false
            )
        )
    }

    @Test func activationRequiresVerifiedActionAndVisibleMemoryReadback() {
        #expect(
            !YishuActivationPolicy.shouldActivate(
                hasVerifiedAction: true,
                hasVisibleMemoryReadback: false
            )
        )
        #expect(
            !YishuActivationPolicy.shouldActivate(
                hasVerifiedAction: false,
                hasVisibleMemoryReadback: true
            )
        )
        #expect(
            YishuActivationPolicy.shouldActivate(
                hasVerifiedAction: true,
                hasVisibleMemoryReadback: true
            )
        )

        let suiteName = "yishu.panel.activate.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            Issue.record("failed to create suite")
            return
        }
        defer { defaults.removePersistentDomain(forName: suiteName) }

        YishuActivationPolicy.markVisibleMemoryReadback(in: defaults)
        #expect(YishuActivationPolicy.hasVisibleMemoryReadback(in: defaults))
        #expect(YishuActivationPolicy.isActivated(in: defaults) == false)
        YishuActivationPolicy.markActivated(in: defaults)
        #expect(YishuActivationPolicy.isActivated(in: defaults))
    }

    @Test func lastVerifiedIgnoresSpeechAndUnverifiedReceipts() {
        let spoken = "完成了"
        let unverified = YishuComputerActionResult(
            succeeded: true,
            verified: false,
            message: spoken,
            evidence: "speech-is-not-verification"
        )
        let failed = YishuComputerActionResult(
            succeeded: false,
            verified: false,
            message: "这次没点成功，我没有重复操作。",
            evidence: nil
        )

        #expect(unverified.verified == false)
        #expect(
            YishuLastVerifiedProjection.updatedSnapshot(
                previous: nil,
                result: unverified,
                what: spoken
            ) == nil
        )
        #expect(
            YishuLastVerifiedProjection.updatedSnapshot(
                previous: nil,
                result: failed,
                what: failed.message
            ) == nil
        )
        #expect(
            YishuLastVerifiedProjection.displayLine(nil)
                == YishuPanelFirstScreenCopy.noVerifiedCompletion
        )
    }

    @Test func lastVerifiedRecordsOnlyVerifiedResults() {
        let suiteName = "yishu.panel.verified.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            Issue.record("failed to create suite")
            return
        }
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(YishuLastVerifiedProjection.load(from: defaults) == nil)

        let unverified = YishuComputerActionResult(
            succeeded: true,
            verified: false,
            message: "点击已送达，但界面结果还没确认。",
            evidence: nil
        )
        let previous = YishuLastVerifiedProjection.updatedSnapshot(
            previous: YishuLastVerifiedProjection.load(from: defaults),
            result: unverified,
            what: unverified.message
        )
        #expect(previous == nil)

        let verified = YishuComputerActionResult(
            succeeded: true,
            verified: true,
            message: "点好了。",
            evidence: "method=ax_press",
            status: .verified
        )
        let snapshot = YishuLastVerifiedProjection.updatedSnapshot(
            previous: previous,
            result: verified,
            what: "点好了。"
        )
        #expect(snapshot?.summary == "点好了。")
        #expect(snapshot?.line == "点好了。 · 已验证")
        #expect(YishuLastVerifiedProjection.displayLine(snapshot) == "点好了。 · 已验证")

        if let snapshot {
            YishuLastVerifiedProjection.store(snapshot, in: defaults)
        }
        #expect(YishuLastVerifiedProjection.load(from: defaults)?.summary == "点好了。")

        let laterUnverified = YishuLastVerifiedProjection.updatedSnapshot(
            previous: snapshot,
            result: unverified,
            what: "点好了。"
        )
        #expect(laterUnverified == snapshot)
    }

    @Test func scopeCopyIsTheThreeFirstScreenLabels() {
        #expect(YishuPanelFirstScreenCopy.scopePersonal == "我的")
        #expect(YishuPanelFirstScreenCopy.scopeProject == "项目")
        #expect(YishuPanelFirstScreenCopy.scopePrivate == "不保存")
    }
}
