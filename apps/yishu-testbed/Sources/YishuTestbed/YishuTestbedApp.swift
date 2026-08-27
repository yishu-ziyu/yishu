import AppKit
import YishuTestbedKit

@main
enum YishuTestbedMain {
    static func main() {
        let fixture = ProcessInfo.processInfo.environment["YISHU_TESTBED_FIXTURE"] ?? "single-button"
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let window = NSWindow(
            contentRect: NSRect(x: 200, y: 200, width: 480, height: 320),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Yishu Testbed"
        window.contentView = TestbedView(fixture: fixture)
        window.makeKeyAndOrderFront(nil)
        app.run()
    }
}
