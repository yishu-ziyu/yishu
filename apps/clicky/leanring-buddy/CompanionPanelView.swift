//
//  CompanionPanelView.swift
//  leanring-buddy
//
//  Menu-bar inspector. First job: say how to talk. Everything else recedes.
//

import AppKit
import AVFoundation
import SwiftUI

enum YishuPanelRuntimeCopy {
    static let headerStarting = "正在接上"
    static let headerStopped = "还没接上"
    static let bodyStarting = "正在接上…"
    static let bodyStopped = "后台停了。正在做的事会停下。"
    static let retry = "再试一次"
    static let unavailable = "还没接上，请稍后重试。"
}

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

                permissionsCopySection
                    .padding(.top, 8)
                    .padding(.horizontal, 16)

                if !YishuVoiceProxyProcessPolicy.isFormalAppBundlePath(Bundle.main.bundlePath) {
                    formalInstallWarningSection
                        .padding(.top, 12)
                        .padding(.horizontal, 16)
                }

                if !companionManager.voiceProxyAvailability.isReady {
                    voiceProxyStatusSection
                        .padding(.top, 12)
                        .padding(.horizontal, 16)
                }

                if companionManager.voiceProxyAvailability.isReady,
                   companionManager.agentRuntimeAvailability != .ready {
                    agentRuntimeStatusSection
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
        .frame(width: 320)
        .frame(maxHeight: 520)
        .background(panelBackground)
    }

    // MARK: - Header

    private var panelHeader: some View {
        HStack {
            HStack(spacing: 8) {
                YishuMarkShape()
                    .fill(DS.Colors.textPrimary)
                    .frame(width: 12, height: 12)

                Circle()
                    .fill(statusDotColor)
                    .frame(width: 7, height: 7)

                Text("奕枢")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(DS.Colors.textPrimary)
            }

            Spacer()

            Text(statusText)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(DS.Colors.textTertiary)

            Button(action: {
                NotificationCenter.default.post(name: .yishuDismissPanel, object: nil)
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
            .accessibilityElement(children: .combine)
            .accessibilityLabel("关闭")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    // MARK: - Permissions Copy

    @ViewBuilder
    private var permissionsCopySection: some View {
        if companionManager.hasCompletedOnboarding && companionManager.allPermissionsGranted {
            VStack(alignment: .leading, spacing: 4) {
                Text("按住 Control + Option")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(DS.Colors.textPrimary)
                Text("松开就发送")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
            }
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

            if !companionManager.allPermissionsGranted {
                guidedPermissionGrantSection
                    .padding(.bottom, 8)
            }

            microphonePermissionRow

            accessibilityPermissionRow

            screenRecordingPermissionRow

            if companionManager.hasScreenRecordingPermission {
                screenContentPermissionRow
            }

        }
    }

    private var guidedPermissionGrantSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: {
                companionManager.requestPermissionsInGuidedSequence()
            }) {
                Text("依次授权")
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

            Text(YishuPermissionGuidance.unifiedGrantCaption)
                .font(.system(size: 10))
                .foregroundColor(DS.Colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)

            Text(YishuPermissionGuidance.staleGrantHint)
                .font(.system(size: 10))
                .foregroundColor(DS.Colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
                HStack(spacing: 6) {
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

                    Button(action: {
                        WindowPositionManager.revealAppInFinder()
                        WindowPositionManager.openScreenRecordingSettings()
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
        let microphoneStatus: YishuPermissionGuidance.MicrophoneStatus = {
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized:
                return .authorized
            case .notDetermined:
                return .notDetermined
            default:
                return .denied
            }
        }()
        return HStack {
            HStack(spacing: 8) {
                Image(systemName: "mic")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isGranted ? DS.Colors.textTertiary : DS.Colors.warning)
                    .frame(width: 16)

                VStack(alignment: .leading, spacing: 1) {
                    Text("麦克风")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(DS.Colors.textSecondary)

                    if !isGranted {
                        Text(YishuPermissionGuidance.microphoneInstruction(for: microphoneStatus))
                            .font(.system(size: 10))
                            .foregroundColor(DS.Colors.textTertiary)
                    }
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
                    if microphoneStatus == .notDetermined {
                        AVCaptureDevice.requestAccess(for: .audio) { _ in }
                    } else {
                        WindowPositionManager.openMicrophoneSettings()
                    }
                }) {
                    Text(microphoneStatus == .denied ? "打开设置" : "授权")
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
    @State private var isMoreLocalModelsExpanded = false

    private var controlPanelSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            YishuVisibleMemoryEditor()

            disclosureGroup(
                title: "设置",
                isExpanded: $isAdvancedSettingsExpanded
            ) {
                speechSpeedSection
                chatModelPickerSection
                ProviderAccountsView(viewModel: accountViewModel)
                showYishuCursorToggleRow
            }
        }
    }

    private func disclosureGroup<Content: View>(
        title: String,
        isExpanded: Binding<Bool>,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: {
                withAnimation(.easeOut(duration: 0.15)) {
                    isExpanded.wrappedValue.toggle()
                }
            }) {
                HStack {
                    Text(title)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(DS.Colors.textSecondary)
                    Spacer()
                    Image(systemName: isExpanded.wrappedValue ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(DS.Colors.textTertiary)
                }
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .contentShape(Rectangle())
            .accessibilityElement(children: .combine)
            .accessibilityLabel(title)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(isExpanded.wrappedValue ? "已展开" : "已收起")

            if isExpanded.wrappedValue {
                content()
            }
        }
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
            .tint(DS.Colors.accentText)

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
        }
        .padding(.top, 4)
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
            .accessibilityLabel("对话模型")
            .accessibilityValue(companionManager.selectedModelLabel)

            if isModelListExpanded {
                let featuredLocal = YishuConversationModelCatalog.featuredLocalModels(
                    selectedModel: companionManager.selectedModel,
                    selectedProvider: companionManager.selectedModelProvider
                )
                let moreLocal = YishuConversationModelCatalog.moreLocalModels(
                    selectedModel: companionManager.selectedModel,
                    selectedProvider: companionManager.selectedModelProvider
                )
                let authSections = YishuConversationModelCatalog.authSections(
                    authModels: companionManager.configuredAuthModels
                )
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(YishuAccountSurfaceCopy.localGrokSource)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(DS.Colors.textTertiary)
                            .padding(.top, 2)
                        VStack(spacing: 4) {
                            ForEach(featuredLocal) { model in
                                modelChoiceRow(model)
                            }
                        }
                        if !moreLocal.isEmpty {
                            Button(action: {
                                withAnimation(.easeOut(duration: 0.15)) {
                                    isMoreLocalModelsExpanded.toggle()
                                }
                            }) {
                                HStack {
                                    Text("更多本机模型")
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundColor(DS.Colors.textSecondary)
                                    Spacer()
                                    Image(systemName: isMoreLocalModelsExpanded ? "chevron.up" : "chevron.down")
                                        .font(.system(size: 10, weight: .semibold))
                                        .foregroundColor(DS.Colors.textTertiary)
                                }
                                .padding(.horizontal, 8)
                                .padding(.vertical, 6)
                            }
                            .buttonStyle(.plain)
                            .pointerCursor()
                            .accessibilityLabel("更多本机模型")
                            .accessibilityValue(isMoreLocalModelsExpanded ? "已展开" : "已收起")

                            if isMoreLocalModelsExpanded {
                                VStack(spacing: 4) {
                                    ForEach(moreLocal) { model in
                                        modelChoiceRow(model)
                                    }
                                }
                            }
                        }
                        ForEach(authSections, id: \.title) { section in
                            Text(section.title)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(DS.Colors.textTertiary)
                                .padding(.top, 2)
                            VStack(spacing: 4) {
                                ForEach(section.models) { model in
                                    modelChoiceRow(model)
                                }
                            }
                        }
                        Text("本机 Grok 不用登录。ChatGPT / xAI 登录后会出现在这张表里。")
                            .font(.system(size: 10))
                            .foregroundColor(DS.Colors.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 4)
                    }
                }
                .frame(maxHeight: isMoreLocalModelsExpanded ? 260 : 180)
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

    private var showYishuCursorToggleRow: some View {
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
                get: { companionManager.isYishuCursorEnabled },
                set: { companionManager.setYishuCursorEnabled($0) }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
            .tint(DS.Colors.accent)
            .scaleEffect(0.8)
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
            .fill(
                LinearGradient(
                    colors: [DS.Colors.surface1, DS.Colors.background],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
    }

    private var statusDotColor: Color {
        if !companionManager.voiceProxyAvailability.isReady {
            switch companionManager.voiceProxyAvailability {
            case .starting:
                return DS.Colors.accentText
            default:
                return Color.orange
            }
        }
        if companionManager.agentRuntimeAvailability != .ready {
            return companionManager.agentRuntimeAvailability == .starting
                ? DS.Colors.accentText
                : Color.orange
        }
        if !companionManager.isOverlayVisible {
            return DS.Colors.textTertiary
        }
        switch companionManager.voiceState {
        case .idle:
            return DS.Colors.success
        case .listening:
            return DS.Colors.accentText
        case .processing, .responding:
            return DS.Colors.accentText
        }
    }

    private var statusText: String {
        if !companionManager.voiceProxyAvailability.isReady {
            return companionManager.voiceProxyAvailability.statusChip
        }
        switch companionManager.agentRuntimeAvailability {
        case .starting:
            return YishuPanelRuntimeCopy.headerStarting
        case .stopped:
            return YishuPanelRuntimeCopy.headerStopped
        case .ready:
            break
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
    private var agentRuntimeStatusSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(
                companionManager.agentRuntimeAvailability == .starting
                    ? YishuPanelRuntimeCopy.bodyStarting
                    : YishuPanelRuntimeCopy.bodyStopped
            )
            .font(.system(size: 12, weight: .medium))
            .foregroundColor(DS.Colors.textSecondary)
            .fixedSize(horizontal: false, vertical: true)

            if companionManager.agentRuntimeAvailability == .stopped {
                Button(action: {
                    companionManager.retryAgentRuntime()
                }) {
                    Text(YishuPanelRuntimeCopy.retry)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(DS.Colors.accentText)
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

    @ViewBuilder
    private var formalInstallWarningSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(YishuVoiceProxyProcessPolicy.nonFormalInstallWarning)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(DS.Colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            Button(action: {
                NSApp.terminate(nil)
            }) {
                Text("退出这份临时程序")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(DS.Colors.accentText)
                    )
            }
            .buttonStyle(.plain)
            .pointerCursor()
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.orange.opacity(0.12))
        )
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
                                .fill(DS.Colors.accentText)
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
