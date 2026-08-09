//
//  CompanionPanelView.swift
//  leanring-buddy
//
//  The SwiftUI content hosted inside the menu bar panel. Shows the companion
//  voice status, push-to-talk shortcut, and quick settings. Designed to feel
//  like Loom's recording panel — dark, rounded, minimal, and special.
//

import AVFoundation
import SwiftUI

struct CompanionPanelView: View {
    @ObservedObject var companionManager: CompanionManager
    @ObservedObject private var accountViewModel: ProviderAccountsViewModel

    init(companionManager: CompanionManager) {
        _companionManager = ObservedObject(wrappedValue: companionManager)
        _accountViewModel = ObservedObject(
            wrappedValue: companionManager.providerAccountsViewModel
        )
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                panelHeader
                Divider()
                    .background(DS.Colors.borderSubtle)
                    .padding(.horizontal, 16)

                permissionsCopySection
                    .padding(.top, 16)
                    .padding(.horizontal, 16)

                if !companionManager.voiceProxyAvailability.isReady {
                    voiceProxyStatusSection
                        .padding(.top, 12)
                        .padding(.horizontal, 16)
                }

                if !companionManager.allPermissionsGranted {
                    Spacer()
                        .frame(height: 16)

                    settingsSection
                        .padding(.horizontal, 16)
                }

                if !companionManager.hasCompletedOnboarding && companionManager.allPermissionsGranted {
                    Spacer()
                        .frame(height: 16)

                    startButton
                        .padding(.horizontal, 16)
                }

                // Control panel is always available once permissions are ready
                // (model switch must not depend on onboarding state).
                if companionManager.allPermissionsGranted {
                    Spacer()
                        .frame(height: 16)

                    controlPanelSection
                        .padding(.horizontal, 16)
                }

                Spacer()
                    .frame(height: 12)

                Divider()
                    .background(DS.Colors.borderSubtle)
                    .padding(.horizontal, 16)

                footerSection
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
            }
        }
        .frame(width: 360)
        .frame(maxHeight: 640)
        .background(panelBackground)
    }

    // MARK: - Header

    private var panelHeader: some View {
        HStack {
            HStack(spacing: 8) {
                // Animated status dot
                Circle()
                    .fill(statusDotColor)
                    .frame(width: 8, height: 8)
                    .shadow(color: statusDotColor.opacity(0.6), radius: 4)

                Text("奕枢")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(DS.Colors.textPrimary)
            }

            Spacer()

            Text(statusText)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(DS.Colors.textTertiary)

            Button(action: {
                NotificationCenter.default.post(name: .clickyDismissPanel, object: nil)
            }) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(DS.Colors.textTertiary)
                    .frame(width: 20, height: 20)
                    .background(
                        Circle()
                            .fill(Color.white.opacity(0.08))
                    )
            }
            .buttonStyle(.plain)
            .pointerCursor()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    // MARK: - Permissions Copy

    @ViewBuilder
    private var permissionsCopySection: some View {
        if companionManager.hasCompletedOnboarding && companionManager.allPermissionsGranted {
            Text("按住 Control + Option 说话，松开发送。")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(DS.Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if companionManager.allPermissionsGranted {
            Text("权限已就绪。点「开始」认识奕枢。")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(DS.Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if companionManager.hasCompletedOnboarding {
            VStack(alignment: .leading, spacing: 6) {
                Text("需要权限")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(DS.Colors.textSecondary)

                Text("部分权限被关掉了。请重新授予下面四项，才能继续用奕枢。")
                    .font(.system(size: 11))
                    .foregroundColor(DS.Colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text("你好，我是奕枢。")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(DS.Colors.textSecondary)

                Text("你说要做什么，奕枢会看当前屏幕，帮你完成并告诉你结果。")
                    .font(.system(size: 11))
                    .foregroundColor(DS.Colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)

                Text("不会后台常录。只有你按住快捷键时才会截屏和听麦克风。")
                    .font(.system(size: 11))
                    .foregroundColor(Color(red: 0.9, green: 0.4, blue: 0.4))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Email + Start Button

    @ViewBuilder
    private var startButton: some View {
        if !companionManager.hasCompletedOnboarding && companionManager.allPermissionsGranted {
            Button(action: {
                companionManager.triggerOnboarding()
            }) {
                Text("开始")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(DS.Colors.textOnAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: DS.CornerRadius.large, style: .continuous)
                            .fill(DS.Colors.accent)
                    )
            }
            .buttonStyle(.plain)
            .pointerCursor()
        }
    }

    // MARK: - Permissions

    private var settingsSection: some View {
        VStack(spacing: 2) {
            Text("权限")
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundColor(DS.Colors.textTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, 6)

            microphonePermissionRow

            accessibilityPermissionRow

            screenRecordingPermissionRow

            if companionManager.hasScreenRecordingPermission {
                screenContentPermissionRow
            }

        }
    }

    private var accessibilityPermissionRow: some View {
        let isGranted = companionManager.hasAccessibilityPermission
        return HStack {
            HStack(spacing: 8) {
                Image(systemName: "hand.raised")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isGranted ? DS.Colors.textTertiary : DS.Colors.warning)
                    .frame(width: 16)

                Text("辅助功能")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
            }

            Spacer()

            if isGranted {
                HStack(spacing: 4) {
                    Circle()
                        .fill(DS.Colors.success)
                        .frame(width: 6, height: 6)
                    Text("已授权")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(DS.Colors.success)
                }
            } else {
                HStack(spacing: 6) {
                    Button(action: {
                        WindowPositionManager.requestAccessibilityPermission()
                    }) {
                        Text("授权")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(DS.Colors.textOnAccent)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(
                                Capsule()
                                    .fill(DS.Colors.accent)
                            )
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()

                    Button(action: {
                        WindowPositionManager.revealAppInFinder()
                        WindowPositionManager.openAccessibilitySettings()
                    }) {
                        Text("定位 App")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(DS.Colors.textSecondary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(
                                Capsule()
                                    .stroke(DS.Colors.borderSubtle, lineWidth: 0.8)
                            )
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                }
            }
        }
        .padding(.vertical, 6)
    }

    private var screenRecordingPermissionRow: some View {
        let isGranted = companionManager.hasScreenRecordingPermission
        return HStack {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.dashed.badge.record")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isGranted ? DS.Colors.textTertiary : DS.Colors.warning)
                    .frame(width: 16)

                VStack(alignment: .leading, spacing: 1) {
                    Text("屏幕录制")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(DS.Colors.textSecondary)

                    Text(isGranted
                         ? "仅在你按快捷键时截屏"
                         : "授权后请退出再打开 App")
                        .font(.system(size: 10))
                        .foregroundColor(DS.Colors.textTertiary)
                }
            }

            Spacer()

            if isGranted {
                HStack(spacing: 4) {
                    Circle()
                        .fill(DS.Colors.success)
                        .frame(width: 6, height: 6)
                    Text("已授权")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(DS.Colors.success)
                }
            } else {
                Button(action: {
                    WindowPositionManager.requestScreenRecordingPermission()
                }) {
                    Text("授权")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textOnAccent)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(DS.Colors.accent)
                        )
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
        }
        .padding(.vertical, 6)
    }

    private var screenContentPermissionRow: some View {
        let isGranted = companionManager.hasScreenContentPermission
        return HStack {
            HStack(spacing: 8) {
                Image(systemName: "eye")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isGranted ? DS.Colors.textTertiary : DS.Colors.warning)
                    .frame(width: 16)

                Text("屏幕内容")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
            }

            Spacer()

            if isGranted {
                HStack(spacing: 4) {
                    Circle()
                        .fill(DS.Colors.success)
                        .frame(width: 6, height: 6)
                    Text("已授权")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(DS.Colors.success)
                }
            } else {
                Button(action: {
                    companionManager.requestScreenContentPermission()
                }) {
                    Text("授权")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textOnAccent)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(DS.Colors.accent)
                        )
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
        }
        .padding(.vertical, 6)
    }

    private var microphonePermissionRow: some View {
        let isGranted = companionManager.hasMicrophonePermission
        return HStack {
            HStack(spacing: 8) {
                Image(systemName: "mic")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isGranted ? DS.Colors.textTertiary : DS.Colors.warning)
                    .frame(width: 16)

                Text("麦克风")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
            }

            Spacer()

            if isGranted {
                HStack(spacing: 4) {
                    Circle()
                        .fill(DS.Colors.success)
                        .frame(width: 6, height: 6)
                    Text("已授权")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(DS.Colors.success)
                }
            } else {
                Button(action: {
                    let status = AVCaptureDevice.authorizationStatus(for: .audio)
                    if status == .notDetermined {
                        AVCaptureDevice.requestAccess(for: .audio) { _ in }
                    } else {
                        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                }) {
                    Text("授权")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textOnAccent)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(DS.Colors.accent)
                        )
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
        }
        .padding(.vertical, 6)
    }

    private func permissionRow(
        label: String,
        iconName: String,
        isGranted: Bool,
        settingsURL: String
    ) -> some View {
        HStack {
            HStack(spacing: 8) {
                Image(systemName: iconName)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isGranted ? DS.Colors.textTertiary : DS.Colors.warning)
                    .frame(width: 16)

                Text(label)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
            }

            Spacer()

            if isGranted {
                HStack(spacing: 4) {
                    Circle()
                        .fill(DS.Colors.success)
                        .frame(width: 6, height: 6)
                    Text("已授权")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(DS.Colors.success)
                }
            } else {
                Button(action: {
                    if let url = URL(string: settingsURL) {
                        NSWorkspace.shared.open(url)
                    }
                }) {
                    Text("授权")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textOnAccent)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(DS.Colors.accent)
                        )
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
        }
        .padding(.vertical, 6)
    }


    // MARK: - Conversation + Settings

    @State private var isAdvancedSettingsExpanded = false
    @State private var isModelListExpanded = false

    private var controlPanelSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            sessionScopeSection
            showClickyCursorToggleRow

            Button(action: {
                withAnimation(.easeOut(duration: 0.15)) {
                    isAdvancedSettingsExpanded.toggle()
                }
            }) {
                HStack(spacing: 8) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(DS.Colors.textTertiary)
                        .frame(width: 16)
                    Text("设置")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(DS.Colors.textSecondary)
                    Spacer()
                    Image(systemName: isAdvancedSettingsExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(DS.Colors.textTertiary)
                }
            }
            .buttonStyle(.plain)
            .pointerCursor()

            if isAdvancedSettingsExpanded {
                speechSpeedSection
                ProviderAccountsView(viewModel: accountViewModel)
                chatModelPickerSection
                speechToTextProviderRow
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.white.opacity(0.04))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(DS.Colors.borderSubtle, lineWidth: 1)
                )
        )
    }

    private var speechSpeedSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "speaker.wave.2")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .frame(width: 16)

                Text("说话速度")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)

                Spacer()

                Text(YishuSpeechSpeed.displayLabel(for: companionManager.speechSpeed))
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                    .foregroundColor(DS.Colors.accent)
                    .monospacedDigit()
            }

            Slider(
                value: Binding(
                    get: { companionManager.speechSpeed },
                    set: { companionManager.setSpeechSpeed($0) }
                ),
                in: YishuSpeechSpeed.minimumValue...YishuSpeechSpeed.maximumValue,
                step: 0.1
            )
            .tint(DS.Colors.blue400)

            HStack {
                Text("慢")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                Spacer()
                Text("正常 1.0")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                Spacer()
                Text("快")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
            }

            HStack(spacing: 8) {
                Button(action: {
                    companionManager.previewSpeechSpeed()
                }) {
                    Text("试听")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textOnAccent)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 5)
                        .background(
                            Capsule().fill(DS.Colors.accent)
                        )
                }
                .buttonStyle(.plain)
                .pointerCursor()

                Button(action: {
                    companionManager.stopSpeechPlayback()
                }) {
                    Text("停止")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textSecondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 5)
                        .background(
                            Capsule().stroke(DS.Colors.borderSubtle, lineWidth: 0.8)
                        )
                }
                .buttonStyle(.plain)
                .pointerCursor()

                Spacer()

                Button(action: {
                    companionManager.resetSpeechSpeedToDefault()
                }) {
                    Text("恢复正常")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textSecondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(
                            Capsule().stroke(DS.Colors.borderSubtle, lineWidth: 0.8)
                        )
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .opacity(
                    abs(companionManager.speechSpeed - YishuSpeechSpeed.defaultValue) < 0.05
                        ? 0.45
                        : 1
                )
                .disabled(
                    abs(companionManager.speechSpeed - YishuSpeechSpeed.defaultValue) < 0.05
                )
            }

            Text("修改后下次口播立即生效，无需重启。")
                .font(.system(size: 10))
                .foregroundColor(DS.Colors.textTertiary)
        }
        .padding(.top, 4)
    }

    private var sessionScopeSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "person.crop.rectangle.stack")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .frame(width: 16)

                Text("这次对话保存在哪里？")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)

                Spacer()

                Text(companionManager.sessionScopeLabel)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(DS.Colors.accent)
            }

            HStack(spacing: 6) {
                sessionScopeButton("我的", kind: .personal)
                sessionScopeButton("这个项目", kind: .project)
                sessionScopeButton("不保存", kind: .privateSession)
            }

            // Memory source is shown once under personal history (not here).
            // Duplicating it under scope + history was Codex rejection PROOF-1b.

            TextField("项目名称", text: $companionManager.projectScopeDraft)
                .textFieldStyle(.plain)
                .font(.system(size: 11))
                .foregroundColor(DS.Colors.textPrimary)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(Color.white.opacity(0.05))
                        .overlay(
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .stroke(DS.Colors.borderSubtle, lineWidth: 1)
                        )
                )

            Text(companionManager.sessionScopeNotice ?? sessionScopeExplanation)
                .font(.system(size: 10))
                .foregroundColor(
                    companionManager.sessionScope.kind == .privateSession
                        ? DS.Colors.warning
                        : DS.Colors.textTertiary
                )
                .fixedSize(horizontal: false, vertical: true)

            if companionManager.sessionScope.kind == .personal {
                personalMemorySection
                personalHistorySection
            }
        }
        .padding(.vertical, 2)
    }

    private var personalMemorySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "brain.head.profile")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .frame(width: 16)

                Text("已保存的记忆")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)

                Spacer()

                Button(action: {
                    companionManager.refreshPersonalMemories()
                }) {
                    Text(companionManager.personalMemoryLoading ? "刷新中…" : "刷新")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textSecondary)
                }
                .buttonStyle(.plain)
                .disabled(companionManager.personalMemoryLoading)
                .pointerCursor()
            }

            if let notice = companionManager.memoryNotice {
                Text(notice)
                    .font(.system(size: 10))
                    .foregroundColor(DS.Colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            memoryForgetConfirmOverlay

            if companionManager.personalMemoryLoading && companionManager.personalMemoryItems.isEmpty {
                Text("正在读取记忆…")
                    .font(.system(size: 11))
                    .foregroundColor(DS.Colors.textTertiary)
            } else if companionManager.personalMemoryEmpty {
                Text("还没有明确保存的个人记忆。对奕枢说「记住…」后再回来看。")
                    .font(.system(size: 11))
                    .foregroundColor(DS.Colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(spacing: 6) {
                    ForEach(companionManager.personalMemoryItems) { item in
                        personalMemoryRow(item)
                    }
                }
            }
        }
        .padding(.top, 4)
        .onAppear {
            if companionManager.sessionScope.kind == .personal {
                companionManager.refreshPersonalMemories()
            }
        }
    }

    private func personalMemoryRow(_ item: YishuMemoryListItem) -> some View {
        let canMutate = companionManager.canChangeConversation
            && !companionManager.memoryForgetInFlight
        return HStack(alignment: .top, spacing: 6) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(item.summary)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(DS.Colors.textPrimary)
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    Text(Self.historyRelativeTime(item.capturedAt))
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(DS.Colors.textTertiary)
                        .monospacedDigit()
                }
                Text("来源 · \(item.sourceLabel)")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.white.opacity(0.04))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(DS.Colors.borderSubtle, lineWidth: 1)
                    )
            )

            Button(action: {
                companionManager.requestForgetPersonalMemory(item)
            }) {
                Image(systemName: "eye.slash")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(
                        canMutate ? DS.Colors.textTertiary : DS.Colors.textTertiary.opacity(0.45)
                    )
                    .frame(width: 28, height: 28)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.white.opacity(0.04))
                    )
            }
            .buttonStyle(.plain)
            .disabled(!canMutate)
            .help(canMutate ? "忘记这条记忆" : "请等当前回答结束后再忘记")
            .pointerCursor()
        }
    }

    private var memoryForgetConfirmOverlay: some View {
        Group {
            if let candidate = companionManager.memoryForgetCandidate {
                VStack(alignment: .leading, spacing: 10) {
                    Text("忘记这条记忆？")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(DS.Colors.textPrimary)
                    Text("将忘记「\(candidate.summary)」。确认后立即从列表消失，之后的新对话也不会再召回。")
                        .font(.system(size: 11))
                        .foregroundColor(DS.Colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Button(action: {
                            companionManager.cancelForgetPersonalMemory()
                        }) {
                            Text("取消")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(DS.Colors.textSecondary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(
                                    Capsule().fill(Color.white.opacity(0.08))
                                )
                        }
                        .buttonStyle(.plain)
                        .disabled(companionManager.memoryForgetInFlight)
                        .pointerCursor()

                        Button(action: {
                            companionManager.confirmForgetPersonalMemory()
                        }) {
                            Text(companionManager.memoryForgetInFlight ? "忘记中…" : "确认忘记")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(DS.Colors.textOnAccent)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(
                                    Capsule().fill(DS.Colors.accent)
                                )
                        }
                        .buttonStyle(.plain)
                        .disabled(companionManager.memoryForgetInFlight)
                        .pointerCursor()
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.black.opacity(0.55))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .stroke(DS.Colors.borderSubtle, lineWidth: 1)
                        )
                )
                .padding(.top, 4)
            }
        }
    }

    private var personalHistorySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .frame(width: 16)

                Text("历史对话")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)

                Spacer()

                Button(action: {
                    companionManager.refreshPersonalHistory()
                }) {
                    Text(companionManager.personalHistoryLoading ? "刷新中…" : "刷新")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textSecondary)
                }
                .buttonStyle(.plain)
                .disabled(companionManager.personalHistoryLoading)
                .pointerCursor()

                Button(action: {
                    companionManager.beginNewPersonalConversation()
                }) {
                    Text("新建对话")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(
                            companionManager.canChangeConversation
                                ? DS.Colors.textOnAccent
                                : DS.Colors.textTertiary
                        )
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(
                            Capsule().fill(
                                companionManager.canChangeConversation
                                    ? DS.Colors.accent
                                    : Color.white.opacity(0.08)
                            )
                        )
                }
                .buttonStyle(.plain)
                .disabled(!companionManager.canChangeConversation)
                .opacity(companionManager.canChangeConversation ? 1 : 0.55)
                .pointerCursor()
            }

            if let notice = companionManager.historyNotice {
                Text(notice)
                    .font(.system(size: 10))
                    .foregroundColor(DS.Colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let memoryNotice = companionManager.memorySourceNotice,
               !memoryNotice.isEmpty {
                Text(memoryNotice)
                    .font(.system(size: 10))
                    .foregroundColor(DS.Colors.blue400)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
            }

            historyDeleteConfirmOverlay

            if companionManager.personalHistoryLoading && companionManager.personalHistoryItems.isEmpty {
                Text("正在读取历史…")
                    .font(.system(size: 11))
                    .foregroundColor(DS.Colors.textTertiary)
            } else if companionManager.personalHistoryEmpty {
                Text("还没有保存的个人对话。说几句再回来看。")
                    .font(.system(size: 11))
                    .foregroundColor(DS.Colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(spacing: 6) {
                    ForEach(companionManager.personalHistoryItems) { item in
                        personalHistoryRow(item)
                    }
                }
            }
        }
        .padding(.top, 4)
        .onAppear {
            if companionManager.sessionScope.kind == .personal {
                companionManager.refreshPersonalHistory()
            }
        }
    }

    private func personalHistoryRow(_ item: YishuHistoryListItem) -> some View {
        let isCurrent = companionManager.currentConversationId == item.id
        let canMutate = companionManager.canChangeConversation
            && !companionManager.historyDeleteInFlight
        return HStack(alignment: .top, spacing: 6) {
            Button(action: {
                companionManager.continuePersonalHistory(item)
            }) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(item.title)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(DS.Colors.textPrimary)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(Self.historyRelativeTime(item.updatedAt))
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(DS.Colors.textTertiary)
                            .monospacedDigit()
                    }
                    if !item.summary.isEmpty {
                        Text(item.summary)
                            .font(.system(size: 11))
                            .foregroundColor(DS.Colors.textSecondary)
                            .lineLimit(2)
                    }
                    if isCurrent {
                        Text("当前对话")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(DS.Colors.accent)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(isCurrent ? Color.white.opacity(0.08) : Color.white.opacity(0.04))
                        .overlay(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .stroke(
                                    isCurrent ? DS.Colors.accent.opacity(0.45) : DS.Colors.borderSubtle,
                                    lineWidth: 1
                                )
                        )
                )
            }
            .buttonStyle(.plain)
            .disabled(!canMutate)
            .opacity(canMutate ? 1 : 0.55)
            .pointerCursor()

            Button(action: {
                companionManager.requestDeletePersonalHistory(item)
            }) {
                Image(systemName: "trash")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(
                        canMutate ? DS.Colors.textTertiary : DS.Colors.textTertiary.opacity(0.45)
                    )
                    .frame(width: 28, height: 28)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.white.opacity(0.04))
                    )
            }
            .buttonStyle(.plain)
            .disabled(!canMutate)
            .help(canMutate ? "删除这段对话" : "请等当前回答结束后再删除")
            .pointerCursor()
        }
    }

    private var historyDeleteConfirmOverlay: some View {
        Group {
            if let candidate = companionManager.historyDeleteCandidate {
                VStack(alignment: .leading, spacing: 10) {
                    Text("删除这段对话？")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(DS.Colors.textPrimary)
                    Text("将删除「\(candidate.title)」。列表里不再出现，也不能再继续。")
                        .font(.system(size: 11))
                        .foregroundColor(DS.Colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Button(action: {
                            companionManager.cancelDeletePersonalHistory()
                        }) {
                            Text("取消")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(DS.Colors.textSecondary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(
                                    Capsule().fill(Color.white.opacity(0.08))
                                )
                        }
                        .buttonStyle(.plain)
                        .disabled(companionManager.historyDeleteInFlight)
                        .pointerCursor()

                        Button(action: {
                            companionManager.confirmDeletePersonalHistory()
                        }) {
                            Text(companionManager.historyDeleteInFlight ? "删除中…" : "确认删除")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(DS.Colors.textOnAccent)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(
                                    Capsule().fill(DS.Colors.accent)
                                )
                        }
                        .buttonStyle(.plain)
                        .disabled(companionManager.historyDeleteInFlight)
                        .pointerCursor()
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.black.opacity(0.55))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .stroke(DS.Colors.borderSubtle, lineWidth: 1)
                        )
                )
                .padding(.top, 4)
            }
        }
    }

    private static func historyRelativeTime(_ date: Date) -> String {
        if date == Date.distantPast { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        formatter.locale = Locale(identifier: "zh_CN")
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private var sessionScopeExplanation: String {
        switch companionManager.sessionScope.kind {
        case .personal:
            return "这次对话会保存在你的个人区域。"
        case .project:
            let projectName = companionManager.sessionScope.projectLabel ?? "这个项目"
            return "这次对话只保存在「\(projectName)」，不会混进其他项目。"
        case .privateSession:
            return "关闭后不会留下这次内容。"
        }
    }

    private func sessionScopeButton(_ title: String, kind: YishuSessionScopeKind) -> some View {
        let isSelected = companionManager.sessionScope.kind == kind
        return Button(action: {
            companionManager.activateSessionScope(kind)
        }) {
            Text(title)
                .font(.system(size: 11, weight: isSelected ? .semibold : .medium))
                .foregroundColor(isSelected ? DS.Colors.textOnAccent : DS.Colors.textSecondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(isSelected ? DS.Colors.accent : Color.white.opacity(0.05))
                )
        }
        .buttonStyle(.plain)
        .disabled(!companionManager.canSwitchSessionScope)
        .opacity(companionManager.canSwitchSessionScope ? 1 : 0.55)
        .pointerCursor()
    }

    /// Menu-style Picker often fails inside nonactivating NSPanel.
    /// Use explicit tappable rows so model switch always works.
    private var chatModelPickerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: {
                withAnimation(.easeOut(duration: 0.15)) {
                    isModelListExpanded.toggle()
                }
            }) {
                HStack(spacing: 8) {
                    Image(systemName: "brain.head.profile")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(DS.Colors.textTertiary)
                        .frame(width: 16)

                    Text("对话模型")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(DS.Colors.textSecondary)

                    Spacer()

                    Text(companionManager.selectedModelLabel)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.accent)
                        .lineLimit(1)

                    Image(systemName: isModelListExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(DS.Colors.textTertiary)
                }
            }
            .buttonStyle(.plain)
            .pointerCursor()

            if isModelListExpanded {
                ScrollView {
                    VStack(spacing: 4) {
                        ForEach(companionManager.availableConversationModels) { model in
                            modelChoiceRow(model)
                        }
                    }
                }
                .frame(maxHeight: 220)
            }
        }
        .padding(.vertical, 2)
    }

    private func modelChoiceRow(_ option: YishuConversationModelOption) -> some View {
        let isSelected = companionManager.selectedModelProvider == option.provider
            && companionManager.selectedModel == option.model
        return Button(action: {
            companionManager.setSelectedModel(option)
        }) {
            HStack(spacing: 8) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isSelected ? DS.Colors.accent : DS.Colors.textTertiary)
                    .frame(width: 16)

                Text(option.label)
                    .font(.system(size: 12, weight: isSelected ? .semibold : .medium))
                    .foregroundColor(isSelected ? DS.Colors.textPrimary : DS.Colors.textSecondary)

                Spacer()

                Text(option.sourceLabel)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)

            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(isSelected ? DS.Colors.accent.opacity(0.14) : Color.white.opacity(0.03))
            )
        }
        .buttonStyle(.plain)
        .pointerCursor()
    }

    // MARK: - Show Cursor Toggle

    private var showClickyCursorToggleRow: some View {
        HStack {
            HStack(spacing: 8) {
                Image(systemName: "cursorarrow")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .frame(width: 16)

                Text("显示奕枢光标")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
            }

            Spacer()

            Toggle("", isOn: Binding(
                get: { companionManager.isClickyCursorEnabled },
                set: { companionManager.setClickyCursorEnabled($0) }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
            .tint(DS.Colors.accent)
            .scaleEffect(0.8)
        }
        .padding(.vertical, 4)
    }

    private var speechToTextProviderRow: some View {
        HStack {
            HStack(spacing: 8) {
                Image(systemName: "mic.badge.waveform")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .frame(width: 16)

                Text("语音转写")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
            }

            Spacer()

            Text(companionManager.buddyDictationManager.transcriptionProviderDisplayName)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(DS.Colors.textTertiary)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Footer

    private var footerSection: some View {
        HStack {
            Button(action: {
                NSApp.terminate(nil)
            }) {
                HStack(spacing: 6) {
                    Image(systemName: "power")
                        .font(.system(size: 11, weight: .medium))
                    Text("退出奕枢")
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundColor(DS.Colors.textTertiary)
            }
            .buttonStyle(.plain)
            .pointerCursor()

            if companionManager.hasCompletedOnboarding {
                Spacer()

                Button(action: {
                    companionManager.replayOnboarding()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "play.circle")
                            .font(.system(size: 11, weight: .medium))
                        Text("再看一遍引导")
                            .font(.system(size: 12, weight: .medium))
                    }
                    .foregroundColor(DS.Colors.textTertiary)
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
        }
    }

    // MARK: - Visual Helpers

    private var panelBackground: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(DS.Colors.background)
            .shadow(color: Color.black.opacity(0.5), radius: 20, x: 0, y: 10)
            .shadow(color: Color.black.opacity(0.3), radius: 4, x: 0, y: 2)
    }

    private var statusDotColor: Color {
        if !companionManager.voiceProxyAvailability.isReady {
            switch companionManager.voiceProxyAvailability {
            case .starting:
                return DS.Colors.blue400
            default:
                return Color.orange
            }
        }
        if !companionManager.isOverlayVisible {
            return DS.Colors.textTertiary
        }
        switch companionManager.voiceState {
        case .idle:
            return DS.Colors.success
        case .listening:
            return DS.Colors.blue400
        case .processing, .responding:
            return DS.Colors.blue400
        }
    }

    private var statusText: String {
        if !companionManager.voiceProxyAvailability.isReady {
            return companionManager.voiceProxyAvailability.statusChip
        }
        if !companionManager.hasCompletedOnboarding || !companionManager.allPermissionsGranted {
            return "设置中"
        }
        if !companionManager.isOverlayVisible {
            return "就绪"
        }
        switch companionManager.voiceState {
        case .idle:
            return "在线"
        case .listening:
            return "在听"
        case .processing:
            return "思考中"
        case .responding:
            return "在说"
        }
    }

    @ViewBuilder
    private var voiceProxyStatusSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(companionManager.voiceProxyAvailability.recoveryMessage)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(DS.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            if case .starting = companionManager.voiceProxyAvailability {
                EmptyView()
            } else {
                Button(action: {
                    companionManager.retryVoiceProxy()
                }) {
                    Text("重试")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(DS.Colors.blue400)
                        )
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.orange.opacity(0.12))
        )
    }

}
