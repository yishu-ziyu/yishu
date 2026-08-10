import AppKit

@main
struct YishuApplication {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let coordinator = YishuCoordinator()
        application.delegate = coordinator
        let isHeadlessVerification = ProcessInfo.processInfo.environment["YISHU_HEADLESS_VERIFY"] == "1"
        application.setActivationPolicy(isHeadlessVerification ? .prohibited : .accessory)
        application.run()
    }
}
