import AppKit
import XCTest
@testable import YishuTestbedKit

@MainActor
final class FixtureTests: XCTestCase {
    func testEffectFieldExposesAccessibilityIdentifier() {
        let view = TestbedView(fixture: "single-button")
        XCTAssertEqual(view.effectField.identifier?.rawValue, "testbed-effect")
        XCTAssertEqual(view.effectField.accessibilityIdentifier(), "testbed-effect")
        let primary = view.subviews.compactMap { $0 as? NSButton }.first { $0.title == "Primary" }
        XCTAssertEqual(primary?.accessibilityIdentifier(), "testbed-primary")
    }

    func testSingleButtonClickIsReadBack() {
        let view = TestbedView(fixture: "single-button")
        XCTAssertEqual(view.effectText, "idle")
        view.performPrimaryAction()
        XCTAssertEqual(view.effectText, "effect-1")
        XCTAssertEqual(view.clickCount, 1)
    }

    func testFiveStepClickReobserve() {
        let view = TestbedView(fixture: "single-button")
        for step in 1...5 {
            view.performPrimaryAction()
            XCTAssertEqual(view.effectText, "effect-\(step)", "step \(step) must re-read the effect field")
        }
    }

    func testDisabledControlDoesNotChangeEffect() {
        let view = TestbedView(fixture: "disabled")
        view.performPrimaryAction()
        XCTAssertEqual(view.effectText, "idle")
        XCTAssertEqual(view.clickCount, 0)
    }

    func testUnknownCommitDoesNotProjectCompletion() {
        let view = TestbedView(fixture: "unknown-commit")
        view.performPrimaryAction()
        XCTAssertEqual(view.clickCount, 1)
        XCTAssertEqual(view.effectText, "idle")
    }

    func testDuplicateLabelsExist() {
        let view = TestbedView(fixture: "duplicate-label")
        let titles = view.subviews.compactMap { $0 as? NSButton }.map(\.title)
        XCTAssertEqual(titles.filter { $0 == "Same" }.count, 2)
    }

    func testTextFieldSubmitReadback() {
        let view = TestbedView(fixture: "text-field")
        view.setTypedText("hello")
        XCTAssertEqual(view.typedText(), "hello")
        view.performPrimaryAction()
        XCTAssertEqual(view.effectText, "effect-1")
    }

    func testScrollListKeepsOffscreenLastRow() {
        let view = TestbedView(fixture: "scroll-list")
        let scroll = view.subviews.compactMap { $0 as? NSScrollView }.first
        XCTAssertNotNil(scroll)
        let last = scroll?.documentView?.subviews.compactMap { $0 as? NSTextField }.first {
            $0.identifier?.rawValue == "testbed-last-row"
        }
        XCTAssertEqual(last?.stringValue, "Row 40")
        XCTAssertTrue((last?.frame.minY ?? 0) > 160)
    }

    func testDelayedClickDoesNotCompleteBeforeReadback() {
        let view = TestbedView(fixture: "delayed", delay: 0.2)
        view.performPrimaryAction()
        XCTAssertEqual(view.effectText, "pending")
        let exp = expectation(description: "delayed effect")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            XCTAssertEqual(view.effectText, "effect-1")
            exp.fulfill()
        }
        wait(for: [exp], timeout: 1)
    }
}
