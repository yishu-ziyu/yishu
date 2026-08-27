import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Identifier-aware desktop read-back. Extracted so the actuator does not
/// grow another 200 lines; Testbed's `testbed-effect` is one labeled AX value.
enum YishuComputerUseReadBack {
    static let effectIdentifier = "testbed-effect"
    static let pollNanoseconds: UInt64 = 280_000_000
    static let labeledTimeoutNanoseconds: UInt64 = 3_000_000_000

    struct LabeledValues {
        var values: [String: String]
        var terminalEffect: String?

        var evidenceSuffix: String {
            guard let effect = values[effectIdentifier] else { return "" }
            return ";testbed-effect=\(effect)"
        }
    }

    static func identifierValues(processIdentifier: pid_t?) -> [String: String] {
        guard let root = focusedWindow(processIdentifier: processIdentifier) else { return [:] }
        var found: [String: String] = [:]
        var stack = [root]
        var visited = 0
        while let current = stack.popLast(), visited < 1_200, found.count < 40 {
            visited += 1
            if let identifier = stringAttribute("AXIdentifier", from: current),
               !identifier.isEmpty {
                let value = stringAttribute(kAXValueAttribute as String, from: current)
                    ?? stringAttribute(kAXTitleAttribute as String, from: current)
                    ?? ""
                found[identifier] = value
            }
            if let children = axElements(kAXChildrenAttribute as String, from: current) {
                stack.append(contentsOf: children.reversed())
            }
        }
        return found
    }

    static func identifierValue(
        _ identifier: String,
        processIdentifier: pid_t?
    ) -> String? {
        identifierValues(processIdentifier: processIdentifier)[identifier]
    }

    static func element(
        identifier: String,
        processIdentifier: pid_t?
    ) -> AXUIElement? {
        guard let root = focusedWindow(processIdentifier: processIdentifier) else { return nil }
        var stack = [root]
        var visited = 0
        while let current = stack.popLast(), visited < 1_200 {
            visited += 1
            if stringAttribute("AXIdentifier", from: current) == identifier {
                return current
            }
            if let children = axElements(kAXChildrenAttribute as String, from: current) {
                stack.append(contentsOf: children.reversed())
            }
        }
        return nil
    }

    /// Wait for `testbed-effect` to become `effect-N`. `pending` is not success.
    /// Missing identifier returns immediately so ordinary apps do not wait 3s.
    static func pollLabeledEffect(processIdentifier: pid_t?) async -> LabeledValues {
        var values = identifierValues(processIdentifier: processIdentifier)
        guard values[effectIdentifier] != nil else {
            return LabeledValues(values: values, terminalEffect: nil)
        }
        if let terminal = terminalEffect(in: values) {
            return LabeledValues(values: values, terminalEffect: terminal)
        }
        let deadline = DispatchTime.now().uptimeNanoseconds + labeledTimeoutNanoseconds
        while DispatchTime.now().uptimeNanoseconds < deadline {
            guard !Task.isCancelled else { break }
            try? await Task.sleep(nanoseconds: pollNanoseconds)
            values = identifierValues(processIdentifier: processIdentifier)
            if let terminal = terminalEffect(in: values) {
                return LabeledValues(values: values, terminalEffect: terminal)
            }
        }
        return LabeledValues(values: values, terminalEffect: nil)
    }

    struct Evidence {
        let code: YishuActionCode
        let evidence: String
    }

    struct ElementSnapshot {
        let selected: Bool?
        let focused: Bool?
        let value: String?
    }

    static func wait(
        processIdentifier: pid_t?,
        focusedElementBefore: AXUIElement?,
        windowSignatureBefore: String?,
        candidate: AXUIElement?,
        candidateBefore: ElementSnapshot?,
        screenChanged: () async -> Bool
    ) async -> Evidence? {
        let labeled = await pollLabeledEffect(processIdentifier: processIdentifier)
        if let effect = labeled.terminalEffect {
            return Evidence(
                code: .verifiedAccessibilityChange,
                evidence: "method=accessibility;code=verified_accessibility_change;testbed-effect=\(effect)"
            )
        }
        guard !Task.isCancelled else { return nil }
        if labeled.values[effectIdentifier] == nil {
            try? await Task.sleep(nanoseconds: pollNanoseconds)
            guard !Task.isCancelled else { return nil }
        }
        let candidateChanged: Bool
        if let candidate, let candidateBefore {
            let after = ElementSnapshot(
                selected: boolAttribute(kAXSelectedAttribute as String, from: candidate),
                focused: boolAttribute(kAXFocusedAttribute as String, from: candidate),
                value: stringAttribute(kAXValueAttribute as String, from: candidate)
            )
            candidateChanged = (after.selected == true && candidateBefore.selected != true)
                || (after.focused == true && candidateBefore.focused != true)
                || (candidateBefore.value != nil && after.value != candidateBefore.value)
        } else {
            candidateChanged = false
        }
        let system = AXUIElementCreateSystemWide()
        let focusedAfter = axElement(kAXFocusedUIElementAttribute as String, from: system)
        let windowAfter = frontmostWindowSignature()
        if candidateChanged || !sameElement(focusedElementBefore, focusedAfter)
            || windowSignatureBefore != windowAfter {
            return Evidence(
                code: .verifiedAccessibilityChange,
                evidence: "method=accessibility;code=verified_accessibility_change\(labeled.evidenceSuffix)"
            )
        }
        guard await screenChanged() else { return nil }
        return Evidence(
            code: .verifiedScreenChange,
            evidence: "method=screen_readback;code=verified_screen_change\(labeled.evidenceSuffix)"
        )
    }

    static func focusEditable(
        _ element: AXUIElement,
        authorizationFence: () -> Bool
    ) -> Bool {
        let role = stringAttribute(kAXRoleAttribute as String, from: element) ?? ""
        let editable = role == (kAXTextFieldRole as String)
            || role == (kAXTextAreaRole as String)
            || role == (kAXComboBoxRole as String)
            || role == "AXSearchField"
        guard editable, authorizationFence() else { return false }
        return AXUIElementSetAttributeValue(
            element,
            kAXFocusedAttribute as CFString,
            kCFBooleanTrue
        ) == .success
    }

    private static func terminalEffect(in values: [String: String]) -> String? {
        guard let value = values[effectIdentifier],
              value.range(of: #"^effect-[1-9][0-9]*$"#, options: .regularExpression) != nil else {
            return nil
        }
        return value
    }

    private static func focusedWindow(processIdentifier: pid_t?) -> AXUIElement? {
        guard let processIdentifier, processIdentifier > 0 else { return nil }
        let app = AXUIElementCreateApplication(processIdentifier)
        return axElement(kAXFocusedWindowAttribute as String, from: app)
            ?? axElement(kAXMainWindowAttribute as String, from: app)
    }

    private static func axElement(_ attribute: String, from element: AXUIElement) -> AXUIElement? {
        var rawValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &rawValue) == .success,
              let rawValue,
              CFGetTypeID(rawValue) == AXUIElementGetTypeID() else {
            return nil
        }
        return unsafeBitCast(rawValue, to: AXUIElement.self)
    }

    private static func axElements(_ attribute: String, from element: AXUIElement) -> [AXUIElement]? {
        var rawValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &rawValue) == .success,
              let rawValue,
              CFGetTypeID(rawValue) == CFArrayGetTypeID() else {
            return nil
        }
        let cfArray = unsafeBitCast(rawValue, to: CFArray.self)
        let count = CFArrayGetCount(cfArray)
        guard count > 0 else { return [] }
        var elements: [AXUIElement] = []
        elements.reserveCapacity(count)
        for index in 0..<count {
            guard let pointer = CFArrayGetValueAtIndex(cfArray, index) else { continue }
            elements.append(unsafeBitCast(pointer, to: AXUIElement.self))
        }
        return elements
    }

    private static func stringAttribute(_ attribute: String, from element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value else {
            return nil
        }
        return value as? String
    }

    private static func boolAttribute(_ attribute: String, from element: AXUIElement) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let number = value as? NSNumber else {
            return nil
        }
        return number.boolValue
    }

    private static func sameElement(_ lhs: AXUIElement?, _ rhs: AXUIElement?) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil): return true
        case let (lhs?, rhs?): return CFEqual(lhs, rhs)
        default: return false
        }
    }

    private static func frontmostWindowSignature() -> String? {
        guard let processIdentifier = NSWorkspace.shared.frontmostApplication?.processIdentifier,
              let windows = CGWindowListCopyWindowInfo(
                [.optionOnScreenOnly, .excludeDesktopElements],
                kCGNullWindowID
              ) as? [[String: Any]],
              let window = windows.first(where: {
                  ($0[kCGWindowOwnerPID as String] as? pid_t) == processIdentifier
                      && ($0[kCGWindowLayer as String] as? Int) == 0
              }) else {
            return nil
        }
        let windowNumber = window[kCGWindowNumber as String] as? Int ?? 0
        let windowName = window[kCGWindowName as String] as? String ?? ""
        return "\(processIdentifier):\(windowNumber):\(windowName)"
    }
}
