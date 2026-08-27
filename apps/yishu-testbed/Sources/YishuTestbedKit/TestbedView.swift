import AppKit

public final class TestbedView: NSView {
    public let fixture: String
    public let effectField = NSTextField(labelWithString: "idle")
    public private(set) var clickCount = 0
    public let delay: TimeInterval

    public var effectText: String { effectField.stringValue }

    public init(fixture: String, delay: TimeInterval = 2) {
        self.fixture = fixture
        self.delay = delay
        super.init(frame: NSRect(x: 0, y: 0, width: 480, height: 320))
        wantsLayer = true
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        effectField.frame = NSRect(x: 24, y: 24, width: 400, height: 24)
        effectField.identifier = NSUserInterfaceItemIdentifier("testbed-effect")
        effectField.setAccessibilityIdentifier("testbed-effect")
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
            field.setAccessibilityIdentifier("testbed-text")
            addSubview(field)
            addButton("Submit", x: 300)
        case "scroll-list":
            let scroll = NSScrollView(frame: NSRect(x: 40, y: 80, width: 240, height: 160))
            scroll.hasVerticalScroller = true
            let document = NSView(frame: NSRect(x: 0, y: 0, width: 240, height: 1200))
            for index in 1...40 {
                let row = NSTextField(labelWithString: "Row \(index)")
                row.frame = NSRect(x: 8, y: CGFloat((index - 1) * 28), width: 200, height: 24)
                if index == 40 {
                    row.identifier = NSUserInterfaceItemIdentifier("testbed-last-row")
                    row.setAccessibilityIdentifier("testbed-last-row")
                }
                document.addSubview(row)
            }
            scroll.documentView = document
            addSubview(scroll)
        case "delayed", "unknown-commit":
            addButton("Primary", x: 40)
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
        button.setAccessibilityIdentifier("testbed-\(title.lowercased())")
        button.target = self
        button.action = #selector(performPrimaryAction)
        addSubview(button)
        return button
    }

    @objc public func performPrimaryAction() {
        if fixture == "disabled" { return }
        if fixture == "unknown-commit" {
            clickCount += 1
            return
        }
        if fixture == "delayed" {
            effectField.stringValue = "pending"
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self else { return }
                self.clickCount += 1
                self.effectField.stringValue = "effect-\(self.clickCount)"
            }
            return
        }
        clickCount += 1
        effectField.stringValue = "effect-\(clickCount)"
    }

    public func setTypedText(_ text: String) {
        guard let field = subviews.compactMap({ $0 as? NSTextField }).first(where: {
            $0.identifier?.rawValue == "testbed-text"
        }) else { return }
        field.stringValue = text
    }

    public func typedText() -> String {
        subviews.compactMap { $0 as? NSTextField }.first(where: {
            $0.identifier?.rawValue == "testbed-text"
        })?.stringValue ?? ""
    }
}
