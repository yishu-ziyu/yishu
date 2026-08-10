import AppKit
import CoreGraphics
import YishuContext

@MainActor
final class YishuPointerTrailMonitor {
    private var samples: [YishuPointerSample] = []
    private var samplingTimer: Timer?
    private var globalEventMonitor: Any?

    func start() {
        guard samplingTimer == nil else { return }

        let timer = Timer(timeInterval: 0.08, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.appendCurrentPoint(kind: .move)
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        samplingTimer = timer

        globalEventMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [
                .leftMouseDown,
                .leftMouseUp,
                .rightMouseDown,
                .rightMouseUp,
                .leftMouseDragged,
                .rightMouseDragged,
                .scrollWheel,
            ]
        ) { [weak self] event in
            guard let kind = Self.pointerKind(for: event.type) else { return }
            let point = event.cgEvent?.location ?? Self.currentGlobalPoint()
            Task { @MainActor in
                self?.append(point: point, kind: kind)
            }
        }

        appendCurrentPoint(kind: .move)
    }

    func stop() {
        samplingTimer?.invalidate()
        samplingTimer = nil
        if let globalEventMonitor {
            NSEvent.removeMonitor(globalEventMonitor)
        }
        globalEventMonitor = nil
        samples.removeAll(keepingCapacity: false)
    }

    func recentSamples(since cutoff: Date) -> [YishuPointerSample] {
        samples.filter { $0.capturedAt >= cutoff }
    }

    static func currentGlobalPoint() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }

    private func appendCurrentPoint(kind: YishuPointerKind) {
        append(point: Self.currentGlobalPoint(), kind: kind)
    }

    private func append(point: CGPoint, kind: YishuPointerKind) {
        if kind == .move,
           let last = samples.last,
           abs(last.point.x - point.x) < 0.5,
           abs(last.point.y - point.y) < 0.5 {
            return
        }

        samples.append(
            YishuPointerSample(
                capturedAt: Date(),
                point: YishuScreenPoint(
                    x: point.x,
                    y: point.y,
                    coordinateSpace: .globalTopLeft
                ),
                kind: kind
            )
        )
        if samples.count > 480 {
            samples.removeFirst(samples.count - 480)
        }
    }

    private static func pointerKind(for eventType: NSEvent.EventType) -> YishuPointerKind? {
        switch eventType {
        case .leftMouseDown: return .leftDown
        case .leftMouseUp: return .leftUp
        case .rightMouseDown: return .rightDown
        case .rightMouseUp: return .rightUp
        case .leftMouseDragged, .rightMouseDragged: return .drag
        case .scrollWheel: return .scroll
        default: return nil
        }
    }
}
