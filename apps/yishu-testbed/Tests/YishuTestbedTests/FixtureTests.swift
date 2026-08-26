import AppKit
import XCTest
@testable import YishuTestbed

final class FixtureTests: XCTestCase {
    func testDefaultFixtureHasAPrimaryControl() {
        let view = TestbedView(fixture: "single-button")
        XCTAssertEqual(view.subviews.contains { $0 is NSButton }, true)
    }
}
