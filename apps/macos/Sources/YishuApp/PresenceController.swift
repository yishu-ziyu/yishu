import AppKit

enum PresenceState: Equatable {
    case idle(message: String?)
    case listening(partial: String?)
    case thinking(message: String?)
    case speaking(text: String)
    case failed(message: String)

    var title: String {
        switch self {
        case .idle: return "奕枢"
        case .listening: return "奕枢 · 在听"
        case .thinking: return "奕枢 · 在想"
        case .speaking: return "奕枢 · 在说"
        case .failed: return "奕枢 · 需要你看一眼"
        }
    }

    var detail: String {
        switch self {
        case let .idle(message):
            return message ?? "点菜单栏的 ✿ 开始说话"
        case let .listening(partial):
            return partial?.isEmpty == false ? partial! : "我在听。你可以直接说“这个”。"
        case let .thinking(message):
            return message ?? "正在把你的话与光标所在的场景对齐。"
        case let .speaking(text):
            return text
        case let .failed(message):
            return message
        }
    }

    var accentColor: NSColor {
        switch self {
        case .idle: return NSColor(calibratedRed: 0.33, green: 0.49, blue: 0.59, alpha: 1)
        case .listening: return NSColor(calibratedRed: 0.38, green: 0.77, blue: 0.68, alpha: 1)
        case .thinking: return NSColor(calibratedRed: 0.66, green: 0.56, blue: 0.91, alpha: 1)
        case .speaking: return NSColor(calibratedRed: 0.47, green: 0.68, blue: 0.91, alpha: 1)
        case .failed: return NSColor(calibratedRed: 0.93, green: 0.43, blue: 0.43, alpha: 1)
        }
    }

    var showsBubble: Bool {
        switch self {
        case let .idle(message): return message != nil
        case .listening, .thinking, .speaking, .failed: return true
        }
    }
}

@MainActor
final class PresenceController {
    private enum Geometry {
        static let iconPanelSize = CGSize(width: 28, height: 28)
        static let bubbleSize = CGSize(width: 340, height: 96)
        static let cursorCenterOffset = CGPoint(x: 35, y: -25)
        static let trackingInterval = 0.016
    }

    private let iconPanel: CompanionPanel
    private let bubblePanel: PassthroughPanel
    private let iconView: PresenceIconView
    private let bubbleView: PresenceBubbleView
    private var positioningTimer: Timer?
    private var bubbleHideTimer: Timer?

    init() {
        iconView = PresenceIconView(frame: NSRect(origin: .zero, size: Geometry.iconPanelSize))
        bubbleView = PresenceBubbleView(frame: NSRect(origin: .zero, size: Geometry.bubbleSize))
        iconPanel = CompanionPanel(
            contentRect: iconView.bounds,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        bubblePanel = PassthroughPanel(
            contentRect: bubbleView.bounds,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        configure(panel: iconPanel)
        configure(panel: bubblePanel)
        iconPanel.contentView = iconView
        bubblePanel.contentView = bubbleView
        iconPanel.ignoresMouseEvents = true
        bubblePanel.ignoresMouseEvents = true
        iconPanel.level = .screenSaver
        bubblePanel.level = .statusBar
    }

    func show() {
        positionPanels()
        iconPanel.orderFrontRegardless()
        update(.idle(message: "hey，我是奕枢。点菜单栏的 ✿ 开始说话。"))

        let timer = Timer(timeInterval: Geometry.trackingInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.positionPanels() }
        }
        RunLoop.main.add(timer, forMode: .common)
        positioningTimer = timer
    }

    func update(_ newState: PresenceState) {
        bubbleHideTimer?.invalidate()
        bubbleHideTimer = nil
        iconView.state = newState
        bubbleView.state = newState
        iconPanel.orderFrontRegardless()

        if newState.showsBubble {
            bubblePanel.orderFrontRegardless()
            positionPanels()
            if case .idle = newState {
                bubbleHideTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { [weak self] _ in
                    Task { @MainActor in self?.bubblePanel.orderOut(nil) }
                }
            }
        } else {
            bubblePanel.orderOut(nil)
        }
    }

    func hide() {
        positioningTimer?.invalidate()
        positioningTimer = nil
        bubbleHideTimer?.invalidate()
        bubbleHideTimer = nil
        iconPanel.orderOut(nil)
        bubblePanel.orderOut(nil)
    }

    private func configure(panel: NSPanel) {
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .stationary,
            .ignoresCycle,
        ]
    }

    private func positionPanels() {
        let cursor = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { $0.frame.contains(cursor) }) ?? NSScreen.main
        guard let screen else { return }

        let iconSize = iconPanel.frame.size
        let desiredCenter = CGPoint(
            x: cursor.x + Geometry.cursorCenterOffset.x,
            y: cursor.y + Geometry.cursorCenterOffset.y
        )
        var iconOrigin = CGPoint(
            x: desiredCenter.x - iconSize.width / 2,
            y: desiredCenter.y - iconSize.height / 2
        )
        iconOrigin.x = min(max(screen.frame.minX + 4, iconOrigin.x), screen.frame.maxX - iconSize.width - 4)
        iconOrigin.y = min(max(screen.frame.minY + 4, iconOrigin.y), screen.frame.maxY - iconSize.height - 4)
        iconPanel.setFrameOrigin(iconOrigin)

        guard bubblePanel.isVisible else { return }
        let visibleFrame = screen.visibleFrame
        let bubbleSize = bubblePanel.frame.size
        let fitsRight = iconOrigin.x + iconSize.width + 8 + bubbleSize.width <= visibleFrame.maxX - 8
        var bubbleOrigin = CGPoint(
            x: fitsRight
                ? iconOrigin.x + iconSize.width + 8
                : iconOrigin.x - bubbleSize.width - 8,
            y: iconOrigin.y - 4
        )
        bubbleOrigin.x = min(max(visibleFrame.minX + 8, bubbleOrigin.x), visibleFrame.maxX - bubbleSize.width - 8)
        bubbleOrigin.y = min(max(visibleFrame.minY + 8, bubbleOrigin.y), visibleFrame.maxY - bubbleSize.height - 8)
        bubblePanel.setFrameOrigin(bubbleOrigin)
    }
}

private final class CompanionPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class PassthroughPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class PresenceIconView: NSView {
    var state: PresenceState = .idle(message: nil) {
        didSet { needsDisplay = true }
    }

    private var phase: CGFloat = 0
    private var animationTimer: Timer?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        setAccessibilityRole(.image)
        setAccessibilityLabel("奕枢")

        let timer = Timer(timeInterval: 1 / 36, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.phase += 0.2
            self.needsDisplay = true
        }
        RunLoop.main.add(timer, forMode: .common)
        animationTimer = timer
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        animationTimer?.invalidate()
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let shadow = NSShadow()
        shadow.shadowColor = state.accentColor.withAlphaComponent(0.72)
        shadow.shadowBlurRadius = 6
        shadow.shadowOffset = .zero

        NSGraphicsContext.saveGraphicsState()
        shadow.set()
        switch state {
        case .listening:
            drawWaveform(center: center)
        case .thinking:
            drawSpinner(center: center)
        case .idle, .speaking, .failed:
            drawFlower(center: center)
        }
        NSGraphicsContext.restoreGraphicsState()
    }

    private func drawFlower(center: CGPoint) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 16, weight: .semibold),
            .foregroundColor: state.accentColor,
        ]
        let flower = "✿" as NSString
        let size = flower.size(withAttributes: attributes)
        flower.draw(
            at: CGPoint(x: center.x - size.width / 2, y: center.y - size.height / 2 - 1),
            withAttributes: attributes
        )
    }

    private func drawWaveform(center: CGPoint) {
        state.accentColor.setFill()
        let barWidth: CGFloat = 2
        let spacing: CGFloat = 2
        let totalWidth = barWidth * 5 + spacing * 4
        for index in 0..<5 {
            let activity = (sin(phase + CGFloat(index) * 0.9) + 1) / 2
            let height = 3 + activity * 11.5
            let rect = NSRect(
                x: center.x - totalWidth / 2 + CGFloat(index) * (barWidth + spacing),
                y: center.y - height / 2,
                width: barWidth,
                height: height
            )
            NSBezierPath(roundedRect: rect, xRadius: 1, yRadius: 1).fill()
        }
    }

    private func drawSpinner(center: CGPoint) {
        state.accentColor.setStroke()
        let start = phase * 57.2958
        let path = NSBezierPath()
        path.appendArc(
            withCenter: center,
            radius: 7,
            startAngle: start,
            endAngle: start + 252,
            clockwise: false
        )
        path.lineWidth = 2.5
        path.lineCapStyle = .round
        path.stroke()
    }
}

private final class PresenceBubbleView: NSView {
    var state: PresenceState = .idle(message: nil) {
        didSet { needsDisplay = true }
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let card = bounds.insetBy(dx: 5, dy: 5)
        NSColor(calibratedWhite: 0.06, alpha: 0.88).setFill()
        let path = NSBezierPath(roundedRect: card, xRadius: 12, yRadius: 12)
        path.fill()
        state.accentColor.withAlphaComponent(0.72).setStroke()
        path.lineWidth = 1
        path.stroke()

        (state.title as NSString).draw(
            in: NSRect(x: 18, y: 15, width: bounds.width - 36, height: 20),
            withAttributes: [
                .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
                .foregroundColor: state.accentColor,
            ]
        )

        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        paragraph.maximumLineHeight = 18
        (state.detail as NSString).draw(
            with: NSRect(x: 18, y: 38, width: bounds.width - 36, height: 40),
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
            attributes: [
                .font: NSFont.systemFont(ofSize: 13, weight: .regular),
                .foregroundColor: NSColor.white.withAlphaComponent(0.92),
                .paragraphStyle: paragraph,
            ]
        )
    }
}
