//
//  ProviderAccountsView.swift
//  leanring-buddy
//
//  Product-owned Provider account controls.  The view only renders the
//  token-free auth events defined by the Pi runtime protocol; credential
//  material remains in the runtime's Keychain-backed provider adapters.
//

import AppKit
import Combine
import SwiftUI

enum YishuProviderAccountPhase: Equatable {
    case idle
    case loading
    case authorizing
    case awaitingBrowser
    case awaitingDeviceCode
    case signingOut
}

struct YishuProviderAccountState: Equatable {
    var status: YishuAuthPublicStatus?
    var phase: YishuProviderAccountPhase = .idle
    var message: String?
    var infoLinks: [YishuAuthLink] = []
    var browserURL: YishuAuthURL?
    var deviceCode: YishuAuthDeviceCode?
    var prompt: YishuAuthPrompt?
    var failure: YishuAuthFailure?
    var models: [YishuAuthModel] = []

    var isConfigured: Bool {
        status?.configured == true && status?.requiresRelogin != true
    }

    mutating func clearTransientAuthSurface() {
        browserURL = nil
        deviceCode = nil
        prompt = nil
        infoLinks = []
    }
}

/// Pure projection used when a dual-provider status refresh fails.  A single
/// status request owns both rows, so one typed failure must retire both loading
/// surfaces together instead of leaving the other provider spinning.
enum YishuProviderStatusFailureReducer {
    static func apply(
        to states: [YishuAuthProvider: YishuProviderAccountState],
        code: String,
        message: String
    ) -> [YishuAuthProvider: YishuProviderAccountState] {
        var nextStates = states
        for provider in YishuAuthProvider.allCases {
            var state = nextStates[provider] ?? YishuProviderAccountState()
            state.phase = .idle
            state.failure = YishuAuthFailure(
                provider: provider,
                code: code,
                message: message
            )
            state.message = message
            state.clearTransientAuthSurface()
            nextStates[provider] = state
        }
        return nextStates
    }
}

@MainActor
final class ProviderAccountsViewModel: ObservableObject {
    @Published private(set) var states: [YishuAuthProvider: YishuProviderAccountState]

    private let runtimeClient: YishuAgentRuntimeClient?
    private let openExternalURL: (URL) -> Bool
    private var requestTasks: [UUID: Task<Void, Never>] = [:]
    private var activeRequestIDs: [YishuAuthProvider: UUID] = [:]
    /// Request ids are retired as soon as the UI cancels or completes a flow.
    /// Runtime events can still be in flight; a tombstone prevents them from
    /// reviving a newer account surface for the same provider.
    private var tombstonedRequestIDs: Set<UUID> = []
    private var statusRequestID: UUID?

    init(
        runtimeClient: YishuAgentRuntimeClient? = nil,
        openExternalURL: ((URL) -> Bool)? = nil
    ) {
        self.runtimeClient = runtimeClient ?? YishuAgentRuntimeClient.active
        self.openExternalURL = openExternalURL ?? { NSWorkspace.shared.open($0) }
        self.states = Dictionary(
            uniqueKeysWithValues: YishuAuthProvider.allCases.map {
                ($0, YishuProviderAccountState())
            }
        )
    }

    deinit {
        requestTasks.values.forEach { $0.cancel() }
    }

    func state(for provider: YishuAuthProvider) -> YishuProviderAccountState {
        states[provider] ?? YishuProviderAccountState()
    }

    func refreshStatus() {
        if let statusRequestID {
            tombstone(statusRequestID)
            requestTasks[statusRequestID]?.cancel()
            self.statusRequestID = nil
        }

        guard let runtimeClient else {
            setRuntimeUnavailable()
            return
        }

        for provider in YishuAuthProvider.allCases {
            update(provider) { state in
                if state.phase == .idle {
                    state.phase = .loading
                }
                state.message = nil
                state.failure = nil
            }
        }

        do {
            let request = try runtimeClient.startAuthStatus()
            statusRequestID = request.requestId
            consume(request, fallbackProvider: nil, operation: .status)
        } catch {
            handleTransportFailure(provider: nil, requestID: nil)
        }
    }

    func startLogin(for provider: YishuAuthProvider) {
        guard let runtimeClient else {
            setRuntimeUnavailable(for: provider)
            return
        }

        cancelExistingRequest(for: provider)
        update(provider) { state in
            state.phase = .authorizing
            state.message = "正在准备登录…"
            state.failure = nil
            state.clearTransientAuthSurface()
        }

        do {
            let request = try runtimeClient.startAuthLogin(provider: provider)
            activeRequestIDs[provider] = request.requestId
            consume(request, fallbackProvider: provider, operation: .login(provider))
        } catch {
            handleTransportFailure(provider: provider, requestID: nil)
        }
    }

    func cancelLogin(for provider: YishuAuthProvider) {
        guard let requestID = activeRequestIDs[provider], let runtimeClient else {
            update(provider) { state in
                state.phase = .idle
                state.message = "已取消登录。"
                state.clearTransientAuthSurface()
            }
            return
        }

        do {
            // Send the provider explicitly so the runtime cannot cancel a
            // request belonging to another provider.  Retire the UI request
            // immediately after the command is accepted; late prompt or
            // terminal events must not re-open the cancelled surface.
            try runtimeClient.cancelAuthLogin(requestId: requestID, provider: provider)
            tombstone(requestID)
            activeRequestIDs.removeValue(forKey: provider)
            requestTasks[requestID]?.cancel()
            update(provider) { state in
                state.phase = .idle
                state.message = "已取消登录。"
                state.clearTransientAuthSurface()
            }
        } catch {
            tombstone(requestID)
            activeRequestIDs.removeValue(forKey: provider)
            requestTasks[requestID]?.cancel()
            handleTransportFailure(provider: provider, requestID: requestID)
        }
    }

    func logout(for provider: YishuAuthProvider) {
        guard let runtimeClient else {
            setRuntimeUnavailable(for: provider)
            return
        }

        cancelExistingRequest(for: provider)
        update(provider) { state in
            state.phase = .signingOut
            state.message = "正在退出登录…"
            state.failure = nil
        }

        do {
            let request = try runtimeClient.logoutProvider(provider: provider)
            activeRequestIDs[provider] = request.requestId
            consume(request, fallbackProvider: provider, operation: .logout(provider))
        } catch {
            handleTransportFailure(provider: provider, requestID: nil)
        }
    }

    func openBrowser(_ authURL: YishuAuthURL) {
        _ = openExternalURL(authURL.url)
    }

    func openLink(_ link: YishuAuthLink) {
        NSWorkspace.shared.open(link.url)
    }

    func copyDeviceCode(for provider: YishuAuthProvider) {
        guard let userCode = states[provider]?.deviceCode?.userCode else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(userCode, forType: .string)
    }

    func submitPrompt(for provider: YishuAuthProvider, value: String) {
        guard let requestID = activeRequestIDs[provider],
              let prompt = states[provider]?.prompt,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let runtimeClient else {
            return
        }

        do {
            try runtimeClient.replyToAuthPrompt(
                requestId: requestID,
                provider: provider,
                promptId: prompt.id,
                value: value
            )
            update(provider) { state in
                state.prompt = nil
                state.message = "已提交，等待 Provider 响应…"
            }
        } catch {
            handleTransportFailure(provider: provider, requestID: requestID)
        }
    }

    private enum AuthOperation {
        case status
        case login(YishuAuthProvider)
        case logout(YishuAuthProvider)

        var provider: YishuAuthProvider? {
            switch self {
            case .status:
                return nil
            case let .login(provider), let .logout(provider):
                return provider
            }
        }
    }

    private func consume(
        _ request: YishuAuthRequest,
        fallbackProvider: YishuAuthProvider?,
        operation: AuthOperation
    ) {
        let requestID = request.requestId
        let task = Task { @MainActor [weak self] in
            guard let self else { return }

            do {
                for try await event in request.events {
                    self.apply(
                        event,
                        requestID: requestID,
                        fallbackProvider: fallbackProvider,
                        operation: operation
                    )
                }
            } catch is CancellationError {
                // User cancellation is represented by auth.failed(code:
                // cancelled) when the runtime acknowledges it.  A local task
                // cancellation never surfaces raw errors or credential data.
            } catch {
                if case .status = operation {
                    self.handleStatusStreamFailure(error, requestID: requestID)
                } else {
                    self.handleTransportFailure(
                        provider: fallbackProvider ?? operation.provider,
                        requestID: requestID
                    )
                }
            }

            self.finishTask(requestID, operation: operation)
        }
        requestTasks[requestID] = task
    }

    private func apply(
        _ event: YishuAuthEvent,
        requestID: UUID,
        fallbackProvider: YishuAuthProvider?,
        operation: AuthOperation
    ) {
        guard !tombstonedRequestIDs.contains(requestID),
              let provider = event.provider ?? fallbackProvider else { return }

        // A status refresh is allowed to update the public model list while a
        // login is in flight.  Other stale request events must not overwrite a
        // newer login/logout surface for the same provider.
        if case .status = operation {
            // Status is a read-only refresh and may update a provider while a
            // login/logout request is still completing.
        } else if let activeRequestID = activeRequestIDs[provider],
                  activeRequestID != requestID {
            return
        } else if activeRequestIDs[provider] == nil {
            // A login/logout request is only allowed to update the row while
            // it remains current.  This closes the late-event gap after local
            // cancellation, where there is intentionally no active id.
            return
        }

        switch event {
        case let .status(status):
            update(provider) { state in
                state.status = status
                state.models = status.models
                state.failure = nil
                if state.phase == .loading || state.phase == .idle {
                    state.phase = .idle
                    state.message = nil
                }
            }
        case let .info(info):
            update(provider) { state in
                state.message = info.message
                state.infoLinks = info.links
                if state.phase == .idle {
                    state.phase = .authorizing
                }
            }
        case let .url(authURL):
            handleBrowserURL(authURL)
        case let .deviceCode(deviceCode):
            update(provider) { state in
                state.deviceCode = deviceCode
                state.phase = .awaitingDeviceCode
                state.message = "请使用设备码完成授权。"
            }
        case let .progress(progress):
            update(provider) { state in
                state.phase = .authorizing
                state.message = progress.message
            }
        case let .prompt(prompt):
            update(provider) { state in
                state.prompt = prompt
                state.phase = .authorizing
                state.message = prompt.message
            }
        case let .completed(status):
            tombstone(requestID)
            activeRequestIDs.removeValue(forKey: provider)
            update(provider) { state in
                state.status = status
                state.models = status.models
                state.phase = .idle
                state.failure = nil
                state.message = "登录成功。"
                state.clearTransientAuthSurface()
            }
        case let .failed(failure):
            if case .status = operation {
                applyStatusFailure(failure, requestID: requestID)
                return
            }
            tombstone(requestID)
            activeRequestIDs.removeValue(forKey: provider)
            update(provider) { state in
                state.phase = .idle
                state.failure = failure.code == "cancelled" ? nil : failure
                state.message = failure.code == "cancelled" ? "已取消登录。" : failure.message
                state.clearTransientAuthSurface()
            }
        case let .loggedOut(status):
            tombstone(requestID)
            activeRequestIDs.removeValue(forKey: provider)
            update(provider) { state in
                state.status = status
                state.models = status.models
                state.phase = .idle
                state.failure = nil
                state.message = "已退出登录。"
                state.clearTransientAuthSurface()
            }
        }
    }

    func handleBrowserURL(_ authURL: YishuAuthURL) {
        let shouldOpen = states[authURL.provider]?.browserURL != authURL
        update(authURL.provider) { state in
            state.browserURL = authURL
            state.phase = .awaitingBrowser
            state.message = authURL.instructions ?? "请在浏览器完成授权。"
        }
        if shouldOpen {
            _ = openExternalURL(authURL.url)
        }
    }

    private func cancelExistingRequest(for provider: YishuAuthProvider) {
        guard let requestID = activeRequestIDs.removeValue(forKey: provider) else { return }
        tombstone(requestID)
        // The request is retired from the UI first; the runtime method is
        // guarded by its own request kind and quietly fails for a logout.
        try? runtimeClient?.cancelAuthLogin(requestId: requestID, provider: provider, reason: "superseded")
        requestTasks[requestID]?.cancel()
    }

    private func finishTask(_ requestID: UUID, operation: AuthOperation) {
        tombstone(requestID)
        requestTasks.removeValue(forKey: requestID)
        if statusRequestID == requestID {
            statusRequestID = nil
        }
        if let provider = operation.provider,
           activeRequestIDs[provider] == requestID {
            activeRequestIDs.removeValue(forKey: provider)
        }
    }

    private func handleTransportFailure(provider: YishuAuthProvider?, requestID: UUID?) {
        if let requestID {
            tombstone(requestID)
            requestTasks[requestID]?.cancel()
            if statusRequestID == requestID {
                statusRequestID = nil
            }
        }

        if let provider {
            update(provider) { state in
                state.phase = .idle
                state.failure = nil
                state.message = YishuPanelRuntimeCopy.unavailable
                state.clearTransientAuthSurface()
            }
        } else {
            for provider in YishuAuthProvider.allCases {
                update(provider) { state in
                    state.phase = .idle
                    state.failure = nil
                    state.message = YishuPanelRuntimeCopy.unavailable
                }
            }
        }
    }

    private func applyStatusFailure(_ failure: YishuAuthFailure, requestID: UUID) {
        tombstone(requestID)
        if statusRequestID == requestID {
            statusRequestID = nil
        }
        states = YishuProviderStatusFailureReducer.apply(
            to: states,
            code: failure.code,
            message: failure.message
        )
    }

    private func handleStatusStreamFailure(_ error: Error, requestID: UUID) {
        let details: (code: String, message: String)
        if let runtimeError = error as? YishuAgentRuntimeClientError {
            switch runtimeError {
            case .authFailed:
                details = ("oauth_failed", "Provider 状态刷新失败。")
            case .invalidAuthEvent:
                details = ("invalid_request", "Provider 账号协议无效。")
            case .authTimedOut:
                details = ("unavailable", "Provider 状态刷新超时。")
            default:
                details = ("unavailable", YishuPanelRuntimeCopy.unavailable)
            }
        } else {
            // Do not surface arbitrary transport descriptions: runtime stderr
            // may contain provider-specific material.  Keep one safe typed
            // failure for both rows.
            details = ("unavailable", "Provider 状态刷新失败，请稍后重试。")
        }
        applyStatusFailure(
            YishuAuthFailure(
                provider: .openAICodex,
                code: details.code,
                message: details.message
            ),
            requestID: requestID
        )
    }

    private func setRuntimeUnavailable(for provider: YishuAuthProvider? = nil) {
        if let provider {
            update(provider) { state in
                state.phase = .idle
                state.message = YishuPanelRuntimeCopy.unavailable
            }
        } else {
            for provider in YishuAuthProvider.allCases {
                update(provider) { state in
                    state.phase = .idle
                    state.message = YishuPanelRuntimeCopy.unavailable
                }
            }
        }
    }

    private func update(
        _ provider: YishuAuthProvider,
        _ mutate: (inout YishuProviderAccountState) -> Void
    ) {
        var state = states[provider] ?? YishuProviderAccountState()
        mutate(&state)
        states[provider] = state
    }

    private func tombstone(_ requestID: UUID) {
        tombstonedRequestIDs.insert(requestID)
        if tombstonedRequestIDs.count > 512,
           let oldest = tombstonedRequestIDs.first {
            tombstonedRequestIDs.remove(oldest)
        }
    }
}

struct ProviderAccountsView: View {
    @ObservedObject var viewModel: ProviderAccountsViewModel
    @State private var isExpanded = false

    init(viewModel: ProviderAccountsViewModel) {
        self.viewModel = viewModel
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header

            if isExpanded {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(YishuAuthProvider.allCases) { provider in
                            ProviderAccountRow(provider: provider, viewModel: viewModel)
                        }
                    }
                }
                .frame(maxHeight: 270)
                .transition(.opacity)
            }
        }
        .padding(.vertical, 2)
        .task {
            viewModel.refreshStatus()
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "person.crop.circle.badge.key")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(DS.Colors.textTertiary)
                        .frame(width: 16)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("账号")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(DS.Colors.textSecondary)
                        Text(headerSummary)
                            .font(.system(size: 10))
                            .foregroundColor(DS.Colors.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer()

                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(DS.Colors.textTertiary)
                }
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel("账号")
            .accessibilityValue(headerSummary)
            .accessibilityAddTraits(.isButton)

            Button {
                viewModel.refreshStatus()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .help("刷新账号状态")
        }
    }

    private var headerSummary: String {
        let chatGPT = viewModel.state(for: .openAICodex)
        let xAI = viewModel.state(for: .xAI)
        return YishuAccountSurfaceCopy.headerSummary(
            chatGPTStatus: chatGPT.status,
            chatGPTLoading: chatGPT.phase == .loading,
            xAIStatus: xAI.status,
            xAILoading: xAI.phase == .loading
        )
    }
}

private struct ProviderAccountRow: View {
    let provider: YishuAuthProvider
    @ObservedObject var viewModel: ProviderAccountsViewModel
    @State private var promptValue = ""
    @State private var showsBrowserFallback = false

    private var state: YishuProviderAccountState {
        viewModel.state(for: provider)
    }

    var body: some View {
        rowContent
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.white.opacity(0.035))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(DS.Colors.borderSubtle, lineWidth: 1)
                )
        )
        .onChange(of: state.prompt?.id) { _ in
            promptValue = ""
            showsBrowserFallback = false
        }
    }

    private var rowContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            providerHeader
            statusLine
            experimentalNotice
            accountMessage
            actionRow
            authContinuationSurface
        }
    }

    @ViewBuilder
    private var experimentalNotice: some View {
        if state.status?.isExperimental == true {
            Text("此登录方式仍在测试，可用选项可能变化。")
                .font(.system(size: 10))
                .foregroundColor(DS.Colors.warning)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var accountMessage: some View {
        if (state.failure != nil || state.phase == .idle),
           let message = state.message,
           !message.isEmpty {
            Text(message)
                .font(.system(size: 10))
                .foregroundColor(state.failure == nil ? DS.Colors.textTertiary : DS.Colors.warningText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var providerHeader: some View {
        HStack(spacing: 8) {
            Image(systemName: provider.symbolName)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(DS.Colors.accent)
                .frame(width: 18)

            Text(provider.shortName)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(DS.Colors.textPrimary)

            Spacer()

            if state.isConfigured {
                Text(YishuAccountSurfaceCopy.rowBadge(status: state.status))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(DS.Colors.success)
                    .lineLimit(1)
            } else {
                Text(state.status?.statusLabel ?? "待检查")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
            }
        }
    }

    private var statusLine: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(statusColor)
                .frame(width: 6, height: 6)
            Text(phaseLabel)
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(DS.Colors.textTertiary)
            Spacer()
        }
    }

    private var statusColor: Color {
        switch state.phase {
        case .loading, .authorizing, .awaitingBrowser, .awaitingDeviceCode, .signingOut:
            return DS.Colors.accent
        case .idle:
            return state.isConfigured ? DS.Colors.success : DS.Colors.textTertiary
        }
    }

    private var phaseLabel: String {
        switch state.phase {
        case .idle:
            return state.status?.statusLabel ?? "正在检查登录状态"
        case .loading:
            return "正在检查…"
        case .authorizing:
            return "登录流程进行中…"
        case .awaitingBrowser:
            return "等待浏览器确认"
        case .awaitingDeviceCode:
            return "等待设备码确认"
        case .signingOut:
            return "正在退出登录…"
        }
    }

    @ViewBuilder
    private var actionRow: some View {
        HStack(spacing: 8) {
            switch state.phase {
            case .authorizing, .awaitingBrowser, .awaitingDeviceCode:
                actionButton(title: "取消") {
                    viewModel.cancelLogin(for: provider)
                }
            case .signingOut, .loading:
                ProgressView()
                    .controlSize(.small)
                Text(phaseLabel)
                    .font(.system(size: 10))
                    .foregroundColor(DS.Colors.textTertiary)
            case .idle:
                if state.isConfigured {
                    actionButton(title: "退出登录") {
                        viewModel.logout(for: provider)
                    }
                } else {
                    actionButton(title: "登录", emphasized: true) {
                        viewModel.startLogin(for: provider)
                    }
                }
            }

            Spacer()
        }
    }

    @ViewBuilder
    private var authContinuationSurface: some View {
        if let authURL = state.browserURL {
            HStack(spacing: 8) {
                Text("需要浏览器授权")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
                Button("打开浏览器") {
                    viewModel.openBrowser(authURL)
                }
                .font(.system(size: 10, weight: .semibold))
                .buttonStyle(.plain)
                .foregroundColor(DS.Colors.accent)
                .pointerCursor()
            }
        }

        if let deviceCode = state.deviceCode {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(deviceCode.userCode)
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundColor(DS.Colors.textPrimary)
                    Button("复制") {
                        viewModel.copyDeviceCode(for: provider)
                    }
                    .font(.system(size: 10, weight: .semibold))
                    .buttonStyle(.plain)
                    .foregroundColor(DS.Colors.accent)
                    .pointerCursor()
                }

                Button("打开验证页面") {
                    NSWorkspace.shared.open(deviceCode.verificationURI)
                }
                .font(.system(size: 10, weight: .medium))
                .buttonStyle(.plain)
                .foregroundColor(DS.Colors.accent)
                .pointerCursor()
            }
        }

        if let prompt = state.prompt {
            promptSurface(prompt)
        }

        if !state.infoLinks.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(state.infoLinks) { link in
                    Button(link.label) {
                        viewModel.openLink(link)
                    }
                    .font(.system(size: 10, weight: .medium))
                    .buttonStyle(.plain)
                    .foregroundColor(DS.Colors.accent)
                    .pointerCursor()
                }
            }
        }
    }

    @ViewBuilder
    private func promptSurface(_ prompt: YishuAuthPrompt) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if isBrowserCallbackPrompt(prompt) {
                Text("请在浏览器完成登录。完成后会自动回到这里。")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                if showsBrowserFallback {
                    Text("只有浏览器没有自动返回时，才需要这一步。")
                        .font(.system(size: 9))
                        .foregroundColor(DS.Colors.textTertiary)
                    promptInput(
                        placeholder: "粘贴浏览器最后打开的完整地址",
                        isSecure: false
                    )
                } else {
                    Button("浏览器没有自动返回？") {
                        showsBrowserFallback = true
                    }
                    .font(.system(size: 10, weight: .medium))
                    .buttonStyle(.plain)
                    .foregroundColor(DS.Colors.accent)
                    .pointerCursor()
                }
            } else {
                Text(prompt.message)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                switch prompt.kind {
                case let .select(options):
                    ForEach(options) { option in
                        Button {
                            viewModel.submitPrompt(for: provider, value: option.id)
                        } label: {
                            HStack(alignment: .top, spacing: 6) {
                                Text(option.label)
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundColor(DS.Colors.textSecondary)
                                if let description = option.description {
                                    Text(description)
                                        .font(.system(size: 9))
                                        .foregroundColor(DS.Colors.textTertiary)
                                        .lineLimit(1)
                                }
                                Spacer()
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                            .background(
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .fill(Color.white.opacity(0.04))
                            )
                        }
                        .buttonStyle(.plain)
                        .pointerCursor()
                    }
                case let .secret(placeholder):
                    promptInput(placeholder: placeholder, isSecure: true)
                case let .text(placeholder), let .manualCode(placeholder):
                    promptInput(placeholder: placeholder, isSecure: false)
                }
            }
        }
    }

    private func isBrowserCallbackPrompt(_ prompt: YishuAuthPrompt) -> Bool {
        guard provider == .openAICodex else { return false }
        switch prompt.kind {
        case .manualCode, .text:
            return true
        case .secret, .select:
            return false
        }
    }

    @ViewBuilder
    private func promptInput(placeholder: String?, isSecure: Bool) -> some View {
        HStack(spacing: 6) {
            Group {
                if isSecure {
                    SecureField(placeholder ?? "输入", text: $promptValue)
                } else {
                    TextField(placeholder ?? "输入", text: $promptValue)
                }
            }
            .textFieldStyle(.roundedBorder)

            Button("提交") {
                viewModel.submitPrompt(for: provider, value: promptValue)
                promptValue = ""
            }
            .font(.system(size: 10, weight: .semibold))
            .buttonStyle(.plain)
            .foregroundColor(promptValue.isEmpty ? DS.Colors.textTertiary : DS.Colors.accent)
            .disabled(promptValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .pointerCursor(isEnabled: !promptValue.isEmpty)
        }
    }

    private func actionButton(
        title: String,
        emphasized: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(emphasized ? DS.Colors.textOnAccent : DS.Colors.textSecondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    Capsule()
                        .fill(emphasized ? DS.Colors.accent : Color.white.opacity(0.07))
                )
        }
        .buttonStyle(.plain)
        .pointerCursor()
    }
}
