import Foundation
import YishuContext

enum YishuComputerUseRecapture {
    /// Look again at numbered AX targets after a click. Screenshot recapture
    /// goes through ScreenCaptureKit and has blocked the receipt for 60s+.
    @MainActor
    static func frame(using collector: YishuContextFrameCollector) -> YishuContextFrame {
        collector.recaptureObservation()
    }
}
