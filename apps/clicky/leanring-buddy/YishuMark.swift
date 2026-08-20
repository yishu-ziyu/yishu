import AppKit
import SwiftUI

/// Yishu's mark: a pointing companion, not a play button.
enum YishuMark {
    static func menuBarImage(size: CGFloat = 18) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()
        NSColor.black.setFill()
        pointerPath(in: NSRect(x: 0, y: 0, width: size, height: size)).fill()
        image.unlockFocus()
        image.isTemplate = true
        return image
    }

    static func pointerPath(in rect: NSRect) -> NSBezierPath {
        let inset = rect.insetBy(dx: rect.width * 0.14, dy: rect.height * 0.14)
        let path = NSBezierPath()
        // Shifted up a little so the asymmetric pointer looks optically centered.
        path.move(to: CGPoint(
            x: inset.minX + inset.width * 0.12,
            y: inset.minY + inset.height * 0.28
        ))
        path.line(to: CGPoint(
            x: inset.minX + inset.width * 0.88,
            y: inset.minY + inset.height * 0.56
        ))
        path.line(to: CGPoint(
            x: inset.minX + inset.width * 0.38,
            y: inset.minY + inset.height * 0.46
        ))
        path.line(to: CGPoint(
            x: inset.minX + inset.width * 0.28,
            y: inset.minY + inset.height * 0.90
        ))
        path.close()
        return path
    }
}

struct YishuMarkShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let inset = rect.insetBy(dx: rect.width * 0.08, dy: rect.height * 0.08)
        path.move(to: CGPoint(
            x: inset.minX + inset.width * 0.12,
            y: inset.minY + inset.height * 0.78
        ))
        path.addLine(to: CGPoint(
            x: inset.minX + inset.width * 0.88,
            y: inset.minY + inset.height * 0.50
        ))
        path.addLine(to: CGPoint(
            x: inset.minX + inset.width * 0.38,
            y: inset.minY + inset.height * 0.60
        ))
        path.addLine(to: CGPoint(
            x: inset.minX + inset.width * 0.28,
            y: inset.minY + inset.height * 0.14
        ))
        path.closeSubpath()
        return path
    }
}
