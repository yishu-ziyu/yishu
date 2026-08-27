import Foundation

enum YishuComputerUseRecapture {
    /// Look again at the window we just acted on. Fall back to one display
    /// image if the exact window capture is missing.
    @MainActor
    static func frame(using collector: YishuContextFrameCollector) async -> YishuContextFrame {
        let focused = await collector.capture(activeWindowOnly: true)
        if !focused.frame.screenshots.isEmpty {
            return focused.frame
        }
        return await collector.capture().frame
    }
}
