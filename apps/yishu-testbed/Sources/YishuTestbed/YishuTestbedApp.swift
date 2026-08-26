import AppKit

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
        let view = TestbedView(fixture: fixture)
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        app.run()
    }
}

final class TestbedView: NSView {
    let fixture: String
    let effectField = NSTextField(labelWithString: "idle")
    private var clickCount = 0

    init(fixture: String) {
        self.fixture = fixture
        super.init(frame: NSRect(x: 0, y: 0, width: 480, height: 320))
        wantsLayer = true
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        effectField.frame = NSRect(x: 24, y: 24, width: 400, height: 24)
        effectField.identifier = NSUserInterfaceItemIdentifier("testbed-effect")
        addSubview(effectField)
        switch fixture {
        case "duplicate-label":
            addButton("Same", x: 40)
            addButton("Same", x: 200)
        case "disabled":
            let button = addButton("Disabled", x: 40)
            button.isEnabled = false
        case "text-field":
            let field = NSTextField(frame: NSRect(x: 40, y: 160, width: 240, height: 24))
            field.identifier = NSUserInterfaceItemIdentifier("testbed-text")
            addSubview(field)
        default:
            addButton("Primary", x: 40)
        }
    }

    required init?(coder: NSCoder) { nil }

    @discardableResult
    private func addButton(_ title: String, x: CGFloat) -> NSButton {
        let button = NSButton(frame: NSRect(x: x, y: 200, width: 120, height: 32))
        button.title = title
        button.bezelStyle = .rounded
        button.target = self
        button.action = #selector(click)
        addSubview(button)
        return button
    }

    @objc private func click() {
        clickCount += 1
        effectField.stringValue = "effect-\(clickCount)"
    }
}
