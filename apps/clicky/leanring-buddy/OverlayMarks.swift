import AppKit
import Combine
import SwiftUI

/// Marks the overlay can paint after the orb arrives at a target.
enum OverlayMark: Equatable {
    case ring(CGRect)
    case underline(CGRect)
    case highlight(CGRect)
    case arrow(from: CGPoint, to: CGPoint)
    case badge(number: Int, at: CGPoint)

    /// Quartz top-left rect used for cursor-enter dismiss.
    var quartzHitRect: CGRect {
        switch self {
        case .ring(let rect), .underline(let rect), .highlight(let rect):
            return rect
        case .arrow(_, let to):
            return CGRect(x: to.x - 12, y: to.y - 12, width: 24, height: 24)
        case .badge(_, let at):
            return CGRect(x: at.x - 14, y: at.y - 14, width: 28, height: 28)
        }
    }
}

/// Quartz global top-left ↔ AppKit global ↔ overlay-local (SwiftUI, top-left of this screen).
/// Y-flip matches `CompanionManager.globalAppKitPoint` (`displayHeight - y`).
enum OverlayCoordinateSpace {
    static func primaryDisplayHeight(screens: [NSScreen] = NSScreen.screens) -> CGFloat {
        screens.first(where: { $0.frame.origin == .zero })?.frame.height
            ?? screens.first?.frame.height
            ?? 0
    }

    static func appKitRect(
        fromQuartzTopLeft quartz: CGRect,
        primaryDisplayHeight: CGFloat
    ) -> CGRect {
        CGRect(
            x: quartz.origin.x,
            y: primaryDisplayHeight - quartz.origin.y - quartz.height,
            width: quartz.width,
            height: quartz.height
        )
    }

    static func appKitCenter(
        ofQuartzFrame quartz: CGRect,
        primaryDisplayHeight: CGFloat
    ) -> CGPoint {
        let appKit = appKitRect(fromQuartzTopLeft: quartz, primaryDisplayHeight: primaryDisplayHeight)
        return CGPoint(x: appKit.midX, y: appKit.midY)
    }

    static func overlayPoint(fromAppKit screenPoint: CGPoint, screenFrame: CGRect) -> CGPoint {
        CGPoint(
            x: screenPoint.x - screenFrame.origin.x,
            y: (screenFrame.origin.y + screenFrame.height) - screenPoint.y
        )
    }

    static func overlayRect(fromAppKit appKit: CGRect, screenFrame: CGRect) -> CGRect {
        let topLeft = overlayPoint(
            fromAppKit: CGPoint(x: appKit.minX, y: appKit.maxY),
            screenFrame: screenFrame
        )
        return CGRect(x: topLeft.x, y: topLeft.y, width: appKit.width, height: appKit.height)
    }

    static func overlayRect(
        fromQuartzTopLeft quartz: CGRect,
        screenFrame: CGRect,
        primaryDisplayHeight: CGFloat
    ) -> CGRect {
        overlayRect(
            fromAppKit: appKitRect(fromQuartzTopLeft: quartz, primaryDisplayHeight: primaryDisplayHeight),
            screenFrame: screenFrame
        )
    }

    static func overlayPoint(
        fromQuartzTopLeft quartz: CGPoint,
        screenFrame: CGRect,
        primaryDisplayHeight: CGFloat
    ) -> CGPoint {
        overlayPoint(
            fromAppKit: CGPoint(x: quartz.x, y: primaryDisplayHeight - quartz.y),
            screenFrame: screenFrame
        )
    }

    /// Stroke rect around a target. Padding grows the ring; it always contains `target`.
    static func ringRect(around target: CGRect, padding: CGFloat = 4) -> CGRect {
        target.insetBy(dx: -padding, dy: -padding)
    }
}

struct OverlayMarkLive: Identifiable, Equatable {
    let id: UUID
    let mark: OverlayMark
    let screenFrame: CGRect
    let appKitHitRect: CGRect
    let expiresAt: Date
}

final class OverlayMarkStore: ObservableObject {
    @Published private(set) var items: [OverlayMarkLive] = []

    private var cursorTimer: Timer?
    private let linger: TimeInterval = 8

    func show(_ mark: OverlayMark, on screen: NSScreen) {
        let primary = OverlayCoordinateSpace.primaryDisplayHeight()
        let appKitHit = OverlayCoordinateSpace.appKitRect(
            fromQuartzTopLeft: mark.quartzHitRect,
            primaryDisplayHeight: primary
        )
        let item = OverlayMarkLive(
            id: UUID(),
            mark: mark,
            screenFrame: screen.frame,
            appKitHitRect: appKitHit,
            expiresAt: Date().addingTimeInterval(linger)
        )
        items.append(item)
        startWatchingIfNeeded()
        let itemId = item.id
        DispatchQueue.main.asyncAfter(deadline: .now() + linger) { [weak self] in
            self?.remove(id: itemId)
        }
    }

    func clear() {
        items.removeAll()
        stopWatching()
    }

    deinit {
        cursorTimer?.invalidate()
    }

    private func remove(id: UUID) {
        items.removeAll { $0.id == id }
        if items.isEmpty { stopWatching() }
    }

    private func startWatchingIfNeeded() {
        guard cursorTimer == nil else { return }
        cursorTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            self?.tickDismiss()
        }
    }

    private func stopWatching() {
        cursorTimer?.invalidate()
        cursorTimer = nil
    }

    private func tickDismiss() {
        let mouse = NSEvent.mouseLocation
        let now = Date()
        let before = items.count
        items.removeAll { item in
            now >= item.expiresAt || item.appKitHitRect.contains(mouse)
        }
        if items.isEmpty && before > 0 {
            stopWatching()
        }
    }
}

struct OverlayMarksLayer: View {
    let screenFrame: CGRect
    @ObservedObject var store: OverlayMarkStore

    private var primaryDisplayHeight: CGFloat {
        OverlayCoordinateSpace.primaryDisplayHeight()
    }

    var body: some View {
        ZStack {
            ForEach(store.items.filter { $0.screenFrame == screenFrame }) { item in
                OverlayMarkShape(
                    item: item,
                    screenFrame: screenFrame,
                    primaryDisplayHeight: primaryDisplayHeight
                )
            }
        }
        .frame(width: screenFrame.width, height: screenFrame.height)
        .allowsHitTesting(false)
    }
}

private struct OverlayMarkShape: View {
    let item: OverlayMarkLive
    let screenFrame: CGRect
    let primaryDisplayHeight: CGFloat
    @State private var progress: CGFloat = 0

    var body: some View {
        Group {
            switch item.mark {
            case .ring(let quartz):
                ring(quartz)
            case .underline(let quartz):
                underline(quartz)
            case .highlight(let quartz):
                highlight(quartz)
            case .arrow(let from, let to):
                arrow(from: from, to: to)
            case .badge(let number, let at):
                badge(number, at: at)
            }
        }
        .onAppear {
            withAnimation(.easeOut(duration: 0.3)) {
                progress = 1
            }
        }
    }

    private func localRect(_ quartz: CGRect) -> CGRect {
        OverlayCoordinateSpace.overlayRect(
            fromQuartzTopLeft: quartz,
            screenFrame: screenFrame,
            primaryDisplayHeight: primaryDisplayHeight
        )
    }

    private func localPoint(_ quartz: CGPoint) -> CGPoint {
        OverlayCoordinateSpace.overlayPoint(
            fromQuartzTopLeft: quartz,
            screenFrame: screenFrame,
            primaryDisplayHeight: primaryDisplayHeight
        )
    }

    private func ring(_ quartz: CGRect) -> some View {
        let target = localRect(quartz)
        let ring = OverlayCoordinateSpace.ringRect(around: target, padding: 4)
        return RoundedRectangle(cornerRadius: min(8, max(4, ring.height / 4)), style: .continuous)
            .trim(from: 0, to: progress)
            .stroke(DS.Colors.overlayCursorBlue, lineWidth: 2)
            .frame(width: ring.width, height: ring.height)
            .position(x: ring.midX, y: ring.midY)
    }

    private func underline(_ quartz: CGRect) -> some View {
        let rect = localRect(quartz)
        let y = rect.maxY + 2
        return Path { path in
            path.move(to: CGPoint(x: rect.minX, y: y))
            path.addLine(to: CGPoint(x: rect.maxX, y: y))
        }
        .trim(from: 0, to: progress)
        .stroke(DS.Colors.overlayCursorBlue, style: StrokeStyle(lineWidth: 2, lineCap: .round))
    }

    private func highlight(_ quartz: CGRect) -> some View {
        let rect = localRect(quartz)
        return RoundedRectangle(cornerRadius: 4, style: .continuous)
            .fill(DS.Colors.overlayCursorBlue.opacity(0.22 * Double(progress)))
            .frame(width: rect.width, height: rect.height)
            .position(x: rect.midX, y: rect.midY)
    }

    private func arrow(from: CGPoint, to: CGPoint) -> some View {
        let start = localPoint(from)
        let end = localPoint(to)
        return OverlayArrowPath(from: start, to: end, progress: progress)
            .stroke(DS.Colors.overlayCursorBlue, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
    }

    private func badge(_ number: Int, at: CGPoint) -> some View {
        let point = localPoint(at)
        return Text("\(number)")
            .font(.system(size: 11, weight: .semibold, design: .rounded))
            .foregroundColor(.white)
            .frame(width: 20, height: 20)
            .background(Circle().fill(DS.Colors.overlayCursorBlue))
            .scaleEffect(0.7 + 0.3 * progress)
            .opacity(Double(progress))
            .position(point)
    }
}

private struct OverlayArrowPath: Shape {
    var from: CGPoint
    var to: CGPoint
    var progress: CGFloat

    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }

    func path(in _: CGRect) -> Path {
        var path = Path()
        let dx = to.x - from.x
        let dy = to.y - from.y
        let end = CGPoint(x: from.x + dx * progress, y: from.y + dy * progress)
        path.move(to: from)
        path.addLine(to: end)
        guard progress > 0.85 else { return path }
        let angle = atan2(dy, dx)
        let head: CGFloat = 8
        path.move(to: end)
        path.addLine(to: CGPoint(
            x: end.x - head * cos(angle - .pi / 6),
            y: end.y - head * sin(angle - .pi / 6)
        ))
        path.move(to: end)
        path.addLine(to: CGPoint(
            x: end.x - head * cos(angle + .pi / 6),
            y: end.y - head * sin(angle + .pi / 6)
        ))
        return path
    }
}

extension OverlayWindowManager {
    func showMark(_ mark: OverlayMark, on screen: NSScreen) {
        markStore.show(mark, on: screen)
    }

    func clearMarks() {
        markStore.clear()
    }
}
