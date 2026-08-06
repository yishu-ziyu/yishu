import AppKit

@main
struct YishuApplication {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let coordinator = YishuCoordinator()
        application.delegate = coordinator
        application.setActivationPolicy(.accessory)
        application.run()
    }
}
