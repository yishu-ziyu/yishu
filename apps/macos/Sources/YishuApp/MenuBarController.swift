import AppKit

@MainActor
final class MenuBarController: NSObject {
    var onToggleListening: (() -> Void)?
    var onRunContextDemo: (() -> Void)?
    var onEnableShortcut: (() -> Void)?
    var onQuit: (() -> Void)?

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let stateItem = NSMenuItem(title: "奕枢正在醒来", action: nil, keyEquivalent: "")
    private let runtimeItem = NSMenuItem(title: "Runtime：正在启动", action: nil, keyEquivalent: "")
    private let contextItem = NSMenuItem(title: "上下文：尚未采集", action: nil, keyEquivalent: "")
    private lazy var toggleItem = NSMenuItem(
        title: "开始说话",
        action: #selector(toggleListening),
        keyEquivalent: ""
    )
    private lazy var shortcutItem = NSMenuItem(
        title: "启用 Control + Option 按住说话",
        action: #selector(enableShortcut),
        keyEquivalent: ""
    )

    override init() {
        super.init()
        statusItem.button?.title = "✿"
        statusItem.button?.toolTip = "奕枢"

        let menu = NSMenu()
        stateItem.isEnabled = false
        runtimeItem.isEnabled = false
        contextItem.isEnabled = false
        menu.addItem(stateItem)
        menu.addItem(runtimeItem)
        menu.addItem(contextItem)
        menu.addItem(.separator())

        toggleItem.target = self
        menu.addItem(toggleItem)

        shortcutItem.target = self
        menu.addItem(shortcutItem)

        let demoItem = NSMenuItem(
            title: "运行‘这个’上下文演示",
            action: #selector(runContextDemo),
            keyEquivalent: "d"
        )
        demoItem.target = self
        menu.addItem(demoItem)

        let permissionMenu = NSMenu()
        permissionMenu.addItem(permissionItem("麦克风…", anchor: "Privacy_Microphone"))
        permissionMenu.addItem(permissionItem("语音识别…", anchor: "Privacy_SpeechRecognition"))
        permissionMenu.addItem(permissionItem("屏幕录制…", anchor: "Privacy_ScreenCapture"))
        permissionMenu.addItem(permissionItem("辅助功能…", anchor: "Privacy_Accessibility"))
        permissionMenu.addItem(permissionItem("输入监控…", anchor: "Privacy_ListenEvent"))
        let permissions = NSMenuItem(title: "打开权限设置", action: nil, keyEquivalent: "")
        permissions.submenu = permissionMenu
        menu.addItem(permissions)

        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "退出奕枢开发壳", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        statusItem.menu = menu
    }

    func update(state: String, listening: Bool) {
        stateItem.title = state
        toggleItem.title = listening ? "停止并发送" : "开始说话"
    }

    func update(runtime: String) {
        runtimeItem.title = "Runtime：\(runtime)"
    }

    func update(shortcutEnabled: Bool) {
        shortcutItem.title = shortcutEnabled
            ? "Control + Option 已启用"
            : "启用 Control + Option 按住说话"
        shortcutItem.isEnabled = !shortcutEnabled
    }

    func update(contextSummary: String) {
        contextItem.title = "上下文：\(contextSummary)"
    }

    @objc private func toggleListening() {
        onToggleListening?()
    }

    @objc private func runContextDemo() {
        onRunContextDemo?()
    }

    @objc private func enableShortcut() {
        onEnableShortcut?()
    }

    @objc private func quit() {
        onQuit?()
    }

    @objc private func openPermissionPane(_ sender: NSMenuItem) {
        guard let anchor = sender.representedObject as? String,
              let url = URL(
                string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)"
              ) else { return }
        NSWorkspace.shared.open(url)
    }

    private func permissionItem(_ title: String, anchor: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(openPermissionPane(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = anchor
        return item
    }
}
