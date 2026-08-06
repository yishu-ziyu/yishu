import AppKit
import Foundation
import YishuContext
import os

@MainActor
final class YishuCoordinator: NSObject, NSApplicationDelegate {
    private enum Phase: Equatable {
        case idle
        case listening
        case capturing(UUID)
        case waiting(UUID)
        case speaking(UUID)
    }

    private let logger = Logger(subsystem: "com.yishu.yishu-lab", category: "lifecycle")
    private let pointerMonitor = PointerTrailMonitor()
    private let shortcutMonitor = GlobalPushToTalkMonitor()
    private let presence = PresenceController()
    private let transcriber = AppleSpeechTranscriber()
    private let speechOutput = SpeechOutput()
    private let runtime = YishuRuntimeClient()
    private let menuBar = MenuBarController()
    private lazy var contextCollector = ContextCollector(pointerMonitor: pointerMonitor)

    private var phase: Phase = .idle
    private var currentRequestId: UUID?
    private var streamedResponse = ""
    private var runtimeMode = "启动中"
    private var didAutorunDemo = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        pointerMonitor.start()
        presence.show()

        shortcutMonitor.onPress = { [weak self] in self?.beginListening() }
        shortcutMonitor.onRelease = { [weak self] in self?.finishListening() }
        let shortcutRequested = ProcessInfo.processInfo.environment["YISHU_ENABLE_DEV_SHORTCUT"] == "1"
            || (Bundle.main.object(forInfoDictionaryKey: "YishuGlobalShortcutEnabled") as? Bool) == true
        let shortcutAvailable = shortcutRequested && shortcutMonitor.startIfAuthorized()

        menuBar.onToggleListening = { [weak self] in self?.toggleListening() }
        menuBar.onRunContextDemo = { [weak self] in self?.runContextDemo() }
        menuBar.onEnableShortcut = { [weak self] in self?.enableGlobalShortcut() }
        menuBar.onQuit = { NSApp.terminate(nil) }
        menuBar.update(shortcutEnabled: shortcutAvailable)
        menuBar.update(
            state: shortcutAvailable
                ? "奕枢开发壳已启用 · Control + Option 说话"
                : "奕枢开发壳已启动 · 全局快捷键未占用",
            listening: false
        )

        runtime.onEvent = { [weak self] event in self?.handleRuntimeEvent(event) }
        do {
            try runtime.start()
            logger.info("runtime process launched")
        } catch {
            showFailure(error.localizedDescription)
            menuBar.update(runtime: "启动失败")
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        transcriber.cancel()
        speechOutput.stop()
        shortcutMonitor.stop()
        pointerMonitor.stop()
        runtime.stop()
        presence.hide()
    }

    private func toggleListening() {
        switch phase {
        case .listening:
            finishListening()
        case .capturing, .waiting:
            cancelCurrentTurn()
            beginListening()
        case .speaking:
            speechOutput.stop()
            phase = .idle
            beginListening()
        case .idle:
            beginListening()
        }
    }

    private func beginListening() {
        guard phase != .listening else { return }
        if case .waiting = phase { cancelCurrentTurn() }
        if case .capturing = phase { phase = .idle }
        speechOutput.stop()
        phase = .listening
        presence.update(.listening(partial: nil))
        menuBar.update(state: "奕枢正在听", listening: true)

        Task {
            do {
                try await transcriber.start(
                    onPartial: { [weak self] text in
                        guard let self, self.phase == .listening else { return }
                        self.presence.update(.listening(partial: text))
                    },
                    onFinal: { [weak self] text in
                        self?.submit(utterance: text)
                    },
                    onFailure: { [weak self] message in
                        self?.showFailure(message)
                    }
                )
            } catch {
                showFailure(error.localizedDescription)
            }
        }
    }

    private func finishListening() {
        guard phase == .listening else { return }
        presence.update(.thinking(message: "我在整理你刚才的话。"))
        menuBar.update(state: "奕枢正在整理语音", listening: false)
        transcriber.stopAndFinalize()
    }

    private func submit(utterance rawUtterance: String) {
        let utterance = rawUtterance.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !utterance.isEmpty else {
            showFailure("我没听清。点我再说一次就好。")
            return
        }

        transcriber.cancel()
        let captureId = UUID()
        phase = .capturing(captureId)
        streamedResponse = ""
        presence.update(.thinking(message: "我在看你的光标所在之处。"))
        menuBar.update(state: "奕枢正在对齐上下文", listening: false)

        Task {
            let frame = await contextCollector.capture()
            guard phase == .capturing(captureId) else { return }
            menuBar.update(contextSummary: contextSummary(frame))

            do {
                if !runtime.isRunning {
                    try runtime.start()
                }
                let requestId = try runtime.startTurn(
                    utterance: utterance,
                    contextFrame: frame,
                    capabilityProfile: "conversation"
                )
                currentRequestId = requestId
                phase = .waiting(requestId)
                presence.update(.thinking(message: "我已经看见，正在想怎么回应你。"))
                menuBar.update(state: "奕枢正在思考", listening: false)
            } catch {
                showFailure(error.localizedDescription)
            }
        }
    }

    private func runContextDemo() {
        transcriber.cancel()
        speechOutput.stop()
        cancelCurrentTurn()
        submit(utterance: "这个是什么？")
    }

    private func enableGlobalShortcut() {
        let enabled = shortcutMonitor.requestPermissionAndStart()
        menuBar.update(shortcutEnabled: enabled)
        if enabled {
            presence.update(.idle(message: "Control + Option 已经启用。按住说话，松开发送。"))
            menuBar.update(state: "奕枢开发壳已启用全局按住说话", listening: false)
        } else {
            presence.update(.idle(message: "授权后再点一次菜单即可启用。你仍然可以直接点我说话。"))
        }
    }

    private func cancelCurrentTurn() {
        if let requestId = currentRequestId {
            try? runtime.cancelTurn(requestId: requestId)
        }
        currentRequestId = nil
        streamedResponse = ""
        if case .capturing = phase {
            // The capture task observes the phase token and discards its result.
        }
        phase = .idle
    }

    private func handleRuntimeEvent(_ event: RuntimeClientEvent) {
        switch event {
        case let .ready(mode):
            runtimeMode = mode
            menuBar.update(runtime: mode)
            logger.info("runtime ready in \(mode, privacy: .public) mode")
            autorunDemoIfRequested()

        case let .turnStarted(requestId):
            guard requestId == currentRequestId else { return }
            menuBar.update(state: "奕枢已开始回应", listening: false)

        case let .responseDelta(requestId, text):
            guard requestId == currentRequestId else { return }
            streamedResponse += text
            presence.update(.thinking(message: streamedResponse))

        case let .responseCompleted(requestId, text, _):
            guard requestId == currentRequestId else { return }
            currentRequestId = nil
            streamedResponse = text
            phase = .speaking(requestId)
            presence.update(.speaking(text: text))
            menuBar.update(state: "奕枢正在说话", listening: false)
            speechOutput.speak(text) { [weak self] in
                guard let self, self.phase == .speaking(requestId) else { return }
                self.phase = .idle
                self.presence.update(.idle(message: text))
                self.menuBar.update(state: "奕枢在身边", listening: false)
            }

        case let .toolStarted(requestId, name):
            guard requestId == currentRequestId else { return }
            presence.update(.thinking(message: "我正在用 \(name) 处理这件事。"))

        case let .toolCompleted(requestId, name, isError):
            guard requestId == currentRequestId, isError else { return }
            presence.update(.thinking(message: "\(name) 遇到了问题，我在换一条路。"))

        case let .turnCancelled(requestId):
            guard requestId == currentRequestId else { return }
            currentRequestId = nil
            phase = .idle
            presence.update(.idle(message: "已经停下。你可以立刻换一个方向。"))

        case let .failed(requestId, message):
            if requestId == nil || requestId == currentRequestId {
                currentRequestId = nil
                showFailure(message)
            }

        case let .stopped(exitCode):
            currentRequestId = nil
            menuBar.update(runtime: "已停止（\(exitCode)）")
            showFailure("Runtime 意外停止了。再次发言时我会尝试重启。")
        }
    }

    private func showFailure(_ message: String) {
        transcriber.cancel()
        currentRequestId = nil
        phase = .idle
        presence.update(.failed(message: message))
        menuBar.update(state: "奕枢需要你看一眼", listening: false)
        logger.error("interaction failed")
    }

    private func contextSummary(_ frame: ContextFrame) -> String {
        let application = frame.frontmostApplication?.value.name ?? "未知应用"
        let sensors = [
            frame.activeWindow == nil ? nil : "窗口",
            frame.elementUnderCursor == nil ? nil : "元素",
            frame.screenshots.isEmpty ? nil : "画面",
            frame.pointerTrail.isEmpty ? nil : "轨迹",
        ].compactMap { $0 }.joined(separator: "/")
        let available = sensors.isEmpty ? "光标" : sensors
        return "\(application) · \(available)"
    }

    private func autorunDemoIfRequested() {
        guard !didAutorunDemo else { return }
        let environmentRequested = ProcessInfo.processInfo.environment["YISHU_AUTORUN_DEMO"] == "1"
        let bundleRequested = (Bundle.main.object(forInfoDictionaryKey: "YishuAutorunDemo") as? Bool) == true
        guard environmentRequested || bundleRequested else { return }
        didAutorunDemo = true
        Task {
            try? await Task.sleep(nanoseconds: 900_000_000)
            runContextDemo()
        }
    }
}
