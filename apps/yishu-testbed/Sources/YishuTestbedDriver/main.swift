import AppKit
import ApplicationServices
import Foundation

/// Outside-process AX driver for the Testbed fixture. Never calls
/// `TestbedView.performPrimaryAction`; a missing TCC grant fails closed.
@main
enum YishuTestbedDriver {
    static let bundleId = "works.earendil.YishuTestbed"
    static let windowTitle = "Yishu Testbed"
    static let effectIdentifier = "testbed-effect"

    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        let command = args.first ?? "read"
        guard AXIsProcessTrusted() else {
            emit(["ok": false, "axTrusted": false, "reason": "accessibility_tcc_denied"])
            exit(2)
        }
        guard let pid = fixturePid() else {
            emit(["ok": false, "axTrusted": true, "reason": "testbed_window_not_found"])
            exit(3)
        }
        switch command {
        case "status", "read":
            let identifier = value(forOption: "--identifier", in: args) ?? effectIdentifier
            let value = identifierValue(identifier, pid: pid)
            emit([
                "ok": value != nil,
                "axTrusted": true,
                "pid": pid,
                "identifier": identifier,
                "value": value ?? NSNull(),
            ])
            exit(value == nil ? 4 : 0)
        case "press":
            guard let identifier = value(forOption: "--identifier", in: args) else {
                emit(["ok": false, "axTrusted": true, "reason": "missing_identifier"])
                exit(1)
            }
            activate(pid)
            guard let element = element(identifier: identifier, pid: pid) else {
                emit(["ok": false, "axTrusted": true, "reason": "identifier_not_found", "identifier": identifier])
                exit(4)
            }
            let pressed = AXUIElementPerformAction(element, kAXPressAction as CFString)
            if pressed != .success {
                AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            }
            usleep(300_000)
            let effect = identifierValue(effectIdentifier, pid: pid)
            emit([
                "ok": true,
                "axTrusted": true,
                "identifier": identifier,
                "pressed": pressed == .success,
                "effect": effect ?? NSNull(),
            ])
            exit(0)
        case "set-text":
            guard let identifier = value(forOption: "--identifier", in: args),
                  let text = value(forOption: "--text", in: args) else {
                emit(["ok": false, "axTrusted": true, "reason": "missing_set_text_args"])
                exit(1)
            }
            activate(pid)
            guard let element = element(identifier: identifier, pid: pid) else {
                emit(["ok": false, "axTrusted": true, "reason": "identifier_not_found", "identifier": identifier])
                exit(4)
            }
            AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            let set = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef)
            usleep(200_000)
            let read = stringAttribute(kAXValueAttribute as String, from: element)
            emit([
                "ok": set == .success && read == text,
                "axTrusted": true,
                "identifier": identifier,
                "value": read ?? NSNull(),
            ])
            exit(set == .success && read == text ? 0 : 5)
        default:
            emit(["ok": false, "reason": "unknown_command", "command": command])
            exit(1)
        }
    }

    private static func fixturePid() -> pid_t? {
        let apps = NSWorkspace.shared.runningApplications
        if let match = apps.first(where: { $0.bundleIdentifier == bundleId }) {
            return match.processIdentifier
        }
        if let match = apps.first(where: {
            $0.localizedName == "Yishu Testbed" || $0.localizedName == "YishuTestbed"
        }) {
            return match.processIdentifier
        }
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }
        for window in windows {
            let title = window[kCGWindowName as String] as? String
            if title == windowTitle, let pid = window[kCGWindowOwnerPID as String] as? pid_t {
                return pid
            }
        }
        return nil
    }

    private static func activate(_ pid: pid_t) {
        if let app = NSRunningApplication(processIdentifier: pid) {
            _ = app.activate()
        }
        usleep(200_000)
    }

    private static func identifierValue(_ identifier: String, pid: pid_t) -> String? {
        guard let element = element(identifier: identifier, pid: pid) else { return nil }
        return stringAttribute(kAXValueAttribute as String, from: element)
            ?? stringAttribute(kAXTitleAttribute as String, from: element)
    }

    private static func element(identifier: String, pid: pid_t) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        let window = axElement(kAXFocusedWindowAttribute as String, from: app)
            ?? axElement(kAXMainWindowAttribute as String, from: app)
        guard let window else { return nil }
        var stack = [window]
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

    private static func value(forOption option: String, in args: [String]) -> String? {
        guard let index = args.firstIndex(of: option), index + 1 < args.count else { return nil }
        return args[index + 1]
    }

    private static func emit(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else {
            FileHandle.standardOutput.write(Data("{}\n".utf8))
            return
        }
        FileHandle.standardOutput.write(Data("\(text)\n".utf8))
    }
}
