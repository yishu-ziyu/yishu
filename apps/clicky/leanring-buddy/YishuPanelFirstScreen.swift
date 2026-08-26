//
//  YishuPanelFirstScreen.swift
//  leanring-buddy
//
//  First-screen copy and activation rules. CompanionManager only stores and
//  calls; the panel only renders. Start is intro, not activation.
//

import Foundation

enum YishuPanelFirstScreenCopy {
    static let greeting = "你好，我是奕枢。"
    static let promise = "奕枢会看懂你正在做的事，记住这个项目。只有验证过，才说完成。"
    static let captureLimit = "不会后台常录。只有你按住快捷键时才会截屏和听麦克风。"
    static let readyToStart = "权限已就绪。点「开始」认识奕枢。"
    static let needPermissionsTitle = "需要权限"
    static let needPermissionsBody = "部分权限被关掉了。请重新授予下面四项，才能继续用奕枢。"
    static let holdToTalkPrefix = "按住"
    static let releaseToSend = "松开就发送"
    static let scopeCaption = "范围"
    static let scopePersonal = "我的"
    static let scopeProject = "项目"
    static let scopePrivate = "不保存"
    static let scopeProjectPlaceholder = "项目名"
    static let scopeApplyProject = "用这个项目"
    static let lastVerifiedCaption = "最近完成"
    static let noVerifiedCompletion = "还没有验证过的完成"
    static let verifiedMark = "已验证"
    static let start = "开始"
    static let replayIntro = "再看一遍引导"

    static let forbiddenHeyClickyFragments = [
        "你说要做什么，奕枢会看当前屏幕，帮你完成并告诉你结果。",
    ]
}

/// Durable first-screen facts. Intro is not activation.
enum YishuActivationPolicy {
    static let introSeenKey = "hasSeenIntro"
    static let onboardingCompletedKey = "hasCompletedOnboarding"
    static let visibleMemoryReadbackKey = "yishu.visibleMemoryReadback.v1"
    static let lastVerifiedSummaryKey = "yishu.lastVerified.summary.v1"

    static func introSeen(in defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: introSeenKey) || defaults.bool(forKey: onboardingCompletedKey)
    }

    static func markIntroSeen(in defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: introSeenKey)
    }

    static func isActivated(in defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: onboardingCompletedKey)
    }

    static func hasVisibleMemoryReadback(in defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: visibleMemoryReadbackKey)
    }

    static func markVisibleMemoryReadback(in defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: visibleMemoryReadbackKey)
    }

    static func shouldShowStartButton(introSeen: Bool, permissionsGranted: Bool) -> Bool {
        permissionsGranted && !introSeen
    }

    static func shouldAutoShowCursor(
        introSeen: Bool,
        permissionsGranted: Bool,
        cursorEnabled: Bool
    ) -> Bool {
        introSeen && permissionsGranted && cursorEnabled
    }

    static func shouldOpenPanelOnLaunch(introSeen: Bool, permissionsGranted: Bool) -> Bool {
        !introSeen || !permissionsGranted
    }

    static func shouldActivate(
        hasVerifiedAction: Bool,
        hasVisibleMemoryReadback: Bool
    ) -> Bool {
        hasVerifiedAction && hasVisibleMemoryReadback
    }

    static func markActivated(in defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: onboardingCompletedKey)
    }
}

struct YishuLastVerifiedSnapshot: Equatable {
    var summary: String

    var line: String {
        let what = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if what.isEmpty {
            return YishuPanelFirstScreenCopy.noVerifiedCompletion
        }
        return "\(what) · \(YishuPanelFirstScreenCopy.verifiedMark)"
    }
}

enum YishuLastVerifiedProjection {
    static func displayLine(_ snapshot: YishuLastVerifiedSnapshot?) -> String {
        guard let snapshot else {
            return YishuPanelFirstScreenCopy.noVerifiedCompletion
        }
        return snapshot.line
    }

    /// Speech, succeeded-but-unverified, and failed receipts never become a
    /// completion. Only `verified == true` may replace the empty state.
    static func updatedSnapshot(
        previous: YishuLastVerifiedSnapshot?,
        result: YishuComputerActionResult,
        what: String
    ) -> YishuLastVerifiedSnapshot? {
        guard result.verified else { return previous }
        let trimmed = what.trimmingCharacters(in: .whitespacesAndNewlines)
        let summary = trimmed.isEmpty ? result.message.trimmingCharacters(in: .whitespacesAndNewlines) : trimmed
        guard !summary.isEmpty else { return previous }
        return YishuLastVerifiedSnapshot(summary: summary)
    }

    static func load(from defaults: UserDefaults = .standard) -> YishuLastVerifiedSnapshot? {
        guard let raw = defaults.string(forKey: YishuActivationPolicy.lastVerifiedSummaryKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            return nil
        }
        return YishuLastVerifiedSnapshot(summary: raw)
    }

    static func store(_ snapshot: YishuLastVerifiedSnapshot, in defaults: UserDefaults = .standard) {
        defaults.set(snapshot.summary, forKey: YishuActivationPolicy.lastVerifiedSummaryKey)
    }
}

@MainActor
extension CompanionManager {
    func markIntroSeen() {
        YishuActivationPolicy.markIntroSeen()
        hasSeenIntro = true
    }

    func markActivated() {
        YishuActivationPolicy.markActivated()
        YishuActivationPolicy.markIntroSeen()
        hasCompletedOnboarding = true
        hasSeenIntro = true
    }

    func markVisibleMemoryReadback() {
        YishuActivationPolicy.markVisibleMemoryReadback()
        considerActivation()
    }

    func recordComputerActionResult(
        _ result: YishuComputerActionResult,
        action: String?
    ) {
        let what = Self.directActionConfirmation(for: result, action: action)
        guard let snapshot = YishuLastVerifiedProjection.updatedSnapshot(
            previous: lastVerifiedSnapshot,
            result: result,
            what: what
        ) else {
            return
        }
        lastVerifiedSnapshot = snapshot
        YishuLastVerifiedProjection.store(snapshot)
        considerActivation()
    }

    func considerActivation() {
        guard YishuActivationPolicy.shouldActivate(
            hasVerifiedAction: lastVerifiedSnapshot != nil,
            hasVisibleMemoryReadback: YishuActivationPolicy.hasVisibleMemoryReadback()
        ) else {
            return
        }
        markActivated()
    }
}
