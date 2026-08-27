import Foundation
import YishuContext

enum YishuComputerUseRecapture {
    /// Look again at the window we just acted on. Never wait on a full
    /// display mosaic: that path blocked `computer.action.result` past 60s.
    /// If ScreenCaptureKit stalls, return nil so the click receipt still lands.
    @MainActor
    static func frame(
        using collector: YishuContextFrameCollector,
        timeoutNanoseconds: UInt64 = 3_000_000_000
    ) async -> YishuContextFrame? {
        await withTaskGroup(of: YishuContextFrame?.self) { group in
            group.addTask { @MainActor in
                await collector.capture(activeWindowOnly: true).frame
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: timeoutNanoseconds)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }
}
