import AppKit
import ApplicationServices
import Foundation
import YishuContext

/// Numbers pressable AX controls in the focused window, top-to-bottom then
/// left-to-right. Capture and click must use this same walk; ids are not
/// pointers and go stale when the tree changes.
enum YishuNumberedAccessibility {
    static let maxTargets = 50

    struct Candidate: Equatable {
        var role: String?
        var title: String?
        var description: String?
        var enabled: Bool?
        var x: Double
        var y: Double
    }

    struct Snapshot {
        let targets: [NumberedAccessibilityTarget]
        let permissionDenied: Bool
    }

    enum ResolveFailure: Error {
        case missingExpected
        case unreadable
        case stale
        case disabled
    }

    static func assignIds(_ candidates: [Candidate]) -> [NumberedAccessibilityTarget] {
        sorted(candidates).prefix(maxTargets).enumerated().map { index, item in
            NumberedAccessibilityTarget(
                id: String(index + 1),
                role: item.role,
                title: item.title,
                description: item.description,
                enabled: item.enabled
            )
        }
    }

    static func fingerprint(_ target: NumberedAccessibilityTarget) -> String {
        [target.role ?? "", target.title ?? "", target.description ?? ""].joined(separator: "\u{1e}")
    }

    static func isStale(expected: NumberedAccessibilityTarget, live: NumberedAccessibilityTarget) -> Bool {
        fingerprint(expected) != fingerprint(live)
    }

    static func liveTargets(fallback: [NumberedAccessibilityTarget]) -> [NumberedAccessibilityTarget] {
        let snapshot = snapshot(
            processIdentifier: NSWorkspace.shared.frontmostApplication?.processIdentifier
        )
        return snapshot.targets.isEmpty ? fallback : snapshot.targets
    }

    static func snapshot(processIdentifier: pid_t?) -> Snapshot {
        guard AXIsProcessTrusted() else {
            return Snapshot(targets: [], permissionDenied: true)
        }
        guard let processIdentifier, processIdentifier > 0,
              processIdentifier != ProcessInfo.processInfo.processIdentifier else {
            return Snapshot(targets: [], permissionDenied: false)
        }
        let live = collectLive(processIdentifier: processIdentifier)
        return Snapshot(targets: live.map(\.target), permissionDenied: false)
    }

    static func resolve(
        targetId: String,
        expected: [NumberedAccessibilityTarget],
        processIdentifier: pid_t?
    ) -> Result<AXUIElement, ResolveFailure> {
        guard let captured = expected.first(where: { $0.id == targetId }) else {
            return .failure(.missingExpected)
        }
        guard AXIsProcessTrusted() else {
            return .failure(.unreadable)
        }
        guard let processIdentifier, processIdentifier > 0,
              processIdentifier != ProcessInfo.processInfo.processIdentifier else {
            return .failure(.unreadable)
        }
        let live = collectLive(processIdentifier: processIdentifier)
        guard let hit = live.first(where: { $0.target.id == targetId }) else {
            return .failure(.stale)
        }
        guard !isStale(expected: captured, live: hit.target) else {
            return .failure(.stale)
        }
        if hit.target.enabled == false {
            return .failure(.disabled)
        }
        return .success(hit.element)
    }

    private struct LiveHit {
        let target: NumberedAccessibilityTarget
        let element: AXUIElement
    }

    private static func sorted(_ candidates: [Candidate]) -> [Candidate] {
        candidates.sorted { left, right in
            if left.y != right.y { return left.y < right.y }
            return left.x < right.x
        }
    }

    private static func collectLive(processIdentifier: pid_t) -> [LiveHit] {
        guard let window = focusedWindow(processIdentifier: processIdentifier) else {
            return []
        }
        var stack = [window]
        var visited = 0
        var collected: [(candidate: Candidate, element: AXUIElement)] = []
        while let current = stack.popLast(), visited < 1_200 {
            visited += 1
            if let candidate = interactiveCandidate(current) {
                collected.append((candidate, current))
            }
            if let children = axElements(kAXChildrenAttribute as String, from: current) {
                stack.append(contentsOf: children.reversed())
            }
        }
        let ordered = collected.sorted { left, right in
            if left.candidate.y != right.candidate.y {
                return left.candidate.y < right.candidate.y
            }
            return left.candidate.x < right.candidate.x
        }
        return ordered.prefix(maxTargets).enumerated().map { index, item in
            LiveHit(
                target: NumberedAccessibilityTarget(
                    id: String(index + 1),
                    role: item.candidate.role,
                    title: item.candidate.title,
                    description: item.candidate.description,
                    enabled: item.candidate.enabled
                ),
                element: item.element
            )
        }
    }

    private static func focusedWindow(processIdentifier: pid_t) -> AXUIElement? {
        let app = AXUIElementCreateApplication(processIdentifier)
        return axElement(kAXFocusedWindowAttribute as String, from: app)
            ?? axElement(kAXMainWindowAttribute as String, from: app)
    }

    private static func interactiveCandidate(_ element: AXUIElement) -> Candidate? {
        let role = stringAttribute(kAXRoleAttribute as String, from: element) ?? ""
        let advertisesPress = controlAdvertisesPress(element)
        let isNamedRole = interactiveRoles.contains(role)
        let isRowOrText = role == (kAXRowRole as String)
            || role == (kAXCellRole as String)
            || role == (kAXStaticTextRole as String)
        if isNamedRole {
            if !advertisesPress && !editableRoles.contains(role) {
                return nil
            }
        } else if isRowOrText {
            guard advertisesPress else { return nil }
        } else {
            return nil
        }
        guard let frame = frame(of: element), frame.width > 0, frame.height > 0 else {
            return nil
        }
        let title = truncated(stringAttribute(kAXTitleAttribute as String, from: element))
        let description = truncated(stringAttribute(kAXDescriptionAttribute as String, from: element))
        guard title != nil || description != nil || isNamedRole else {
            return nil
        }
        return Candidate(
            role: role.isEmpty ? nil : role,
            title: title,
            description: description,
            enabled: boolAttribute(kAXEnabledAttribute as String, from: element),
            x: frame.minX,
            y: frame.minY
        )
    }

    private static let interactiveRoles: Set<String> = [
        kAXButtonRole as String,
        kAXCheckBoxRole as String,
        kAXRadioButtonRole as String,
        kAXPopUpButtonRole as String,
        kAXMenuButtonRole as String,
        kAXComboBoxRole as String,
        kAXTextFieldRole as String,
        kAXTextAreaRole as String,
        "AXLink",
        "AXDisclosureTriangle",
        "AXIncrementor",
        "AXSlider",
        "AXSearchField",
    ]

    private static let editableRoles: Set<String> = [
        kAXTextFieldRole as String,
        kAXTextAreaRole as String,
        kAXComboBoxRole as String,
        "AXSearchField",
    ]

    private static func controlAdvertisesPress(_ element: AXUIElement) -> Bool {
        var rawActions: CFArray?
        let actionResult = AXUIElementCopyActionNames(element, &rawActions)
        guard actionResult == .success, let rawActions else {
            return true
        }
        let count = CFArrayGetCount(rawActions)
        if count == 0 { return true }
        for index in 0..<count {
            guard let pointer = CFArrayGetValueAtIndex(rawActions, index) else { continue }
            let action = unsafeBitCast(pointer, to: CFString.self) as String
            if action == (kAXPressAction as String) {
                return true
            }
        }
        return false
    }

    private static func frame(of element: AXUIElement) -> CGRect? {
        var positionRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXPositionAttribute as CFString,
            &positionRef
        ) == .success,
              AXUIElementCopyAttributeValue(
                element,
                kAXSizeAttribute as CFString,
                &sizeRef
              ) == .success,
              let positionRef,
              let sizeRef else {
            return nil
        }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionRef as! AXValue, .cgPoint, &position),
              AXValueGetValue(sizeRef as! AXValue, .cgSize, &size) else {
            return nil
        }
        return CGRect(origin: position, size: size)
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
              let value else {
            return nil
        }
        return value as? Bool
    }

    private static func truncated(_ value: String?) -> String? {
        guard let value else { return nil }
        let collapsed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !collapsed.isEmpty else { return nil }
        if collapsed.count <= 120 { return collapsed }
        return String(collapsed.prefix(120)) + "…"
    }
}
