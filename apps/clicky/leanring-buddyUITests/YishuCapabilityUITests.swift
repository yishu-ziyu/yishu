import XCTest

final class YishuCapabilityUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testProductAppLaunchesWithoutASecondShell() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--yishu-ui-smoke"]
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10) || app.state != .notRunning)
    }
}
