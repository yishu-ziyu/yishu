import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import YishuContext
import ScreenCaptureKit

@MainActor
final class ContextCollector {
    private let pointerMonitor: PointerTrailMonitor
    private var hasRequestedScreenCapturePermission = false
    private var hasRequestedAccessibilityPermission = false

    init(pointerMonitor: PointerTrailMonitor) {
        self.pointerMonitor = pointerMonitor
    }

    func capture() async -> ContextFrame {
        let capturedAt = Date()
        let cursorLocation = PointerTrailMonitor.currentGlobalPoint()
        let cursorPoint = ScreenPoint(
            x: cursorLocation.x,
            y: cursorLocation.y,
            coordinateSpace: .globalTopLeft
        )
        let cursor = ObservedValue(
            value: cursorPoint,
            source: "cg-event-location",
            capturedAt: capturedAt,
            confidence: 1
        )

        var warnings: [String] = []
        let application = frontmostApplication(capturedAt: capturedAt)
        let window = application.flatMap {
            activeWindow(processIdentifier: $0.value.processIdentifier, capturedAt: capturedAt)
        }

        let accessibility = accessibilityElement(
            at: cursorLocation,
            capturedAt: capturedAt,
            warnings: &warnings
        )

        var screenshots: [ScreenshotContext] = []
        do {
            if let screenshot = try await captureCursorDisplay(containing: cursorLocation) {
                screenshots.append(screenshot)
            }
        } catch {
            warnings.append("screen-capture-unavailable:\(compactError(error))")
        }

        let frame = ContextFrame(
            capturedAt: capturedAt,
            expiresAt: capturedAt.addingTimeInterval(15),
            cursor: cursor,
            pointerTrail: pointerMonitor.recentSamples(since: capturedAt.addingTimeInterval(-2.5)),
            frontmostApplication: application,
            activeWindow: window,
            elementUnderCursor: accessibility,
            screenshots: screenshots,
            warnings: warnings
        )

        do {
            try frame.validate(referenceDate: capturedAt)
        } catch {
            // This should only guard an implementation defect. The runtime performs
            // independent schema validation before a frame reaches the model.
            return ContextFrame(
                capturedAt: capturedAt,
                expiresAt: capturedAt.addingTimeInterval(15),
                cursor: cursor,
                pointerTrail: [],
                frontmostApplication: application,
                activeWindow: window,
                elementUnderCursor: accessibility,
                screenshots: [],
                warnings: warnings + ["swift-context-validation-failed:\(compactError(error))"]
            )
        }
        return frame
    }

    private func frontmostApplication(capturedAt: Date) -> ObservedValue<ApplicationContext>? {
        guard let application = NSWorkspace.shared.frontmostApplication,
              application.processIdentifier > 0 else {
            return nil
        }

        return ObservedValue(
            value: ApplicationContext(
                name: application.localizedName ?? "Unknown application",
                bundleIdentifier: application.bundleIdentifier,
                processIdentifier: Int(application.processIdentifier)
            ),
            source: "ns-workspace",
            capturedAt: capturedAt,
            confidence: 1
        )
    }

    private func activeWindow(
        processIdentifier: Int,
        capturedAt: Date
    ) -> ObservedValue<WindowContext>? {
        guard let rawWindows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }

        guard let window = rawWindows.first(where: { item in
            let ownerPID = item[kCGWindowOwnerPID as String] as? Int
            let layer = item[kCGWindowLayer as String] as? Int
            return ownerPID == processIdentifier && layer == 0
        }) else {
            return nil
        }

        let ownerName = (window[kCGWindowOwnerName as String] as? String) ?? "Unknown application"
        let title = window[kCGWindowName as String] as? String
        var bounds: WindowBounds?
        if let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary,
           let rect = CGRect(dictionaryRepresentation: boundsDictionary) {
            bounds = WindowBounds(
                x: rect.origin.x,
                y: rect.origin.y,
                width: rect.width,
                height: rect.height
            )
        }

        return ObservedValue(
            value: WindowContext(
                title: title?.isEmpty == false ? title : nil,
                ownerName: ownerName,
                processIdentifier: processIdentifier,
                bounds: bounds
            ),
            source: "cg-window-list",
            capturedAt: capturedAt,
            confidence: 0.94
        )
    }

    private func accessibilityElement(
        at point: CGPoint,
        capturedAt: Date,
        warnings: inout [String]
    ) -> ObservedValue<AccessibilityElementContext>? {
        if !AXIsProcessTrusted() {
            if !hasRequestedAccessibilityPermission {
                hasRequestedAccessibilityPermission = true
                let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
                _ = AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
            }
            warnings.append("accessibility-permission-required")
            return nil
        }

        let system = AXUIElementCreateSystemWide()
        var rawElement: AXUIElement?
        let result = AXUIElementCopyElementAtPosition(
            system,
            Float(point.x),
            Float(point.y),
            &rawElement
        )
        guard result == .success, let element = rawElement else {
            warnings.append("accessibility-element-unavailable:\(result.rawValue)")
            return nil
        }

        let role = stringAttribute(kAXRoleAttribute, from: element)
        let subrole = stringAttribute(kAXSubroleAttribute, from: element)
        let isSecure = subrole == "AXSecureTextField"
        let context = AccessibilityElementContext(
            role: role,
            subrole: subrole,
            title: truncated(stringAttribute(kAXTitleAttribute, from: element), length: 240),
            description: truncated(stringAttribute(kAXDescriptionAttribute, from: element), length: 240),
            valuePreview: isSecure ? nil : truncated(stringAttribute(kAXValueAttribute, from: element), length: 240)
        )

        return ObservedValue(
            value: context,
            source: "macos-accessibility",
            capturedAt: capturedAt,
            confidence: 0.92
        )
    }

    private func stringAttribute(_ attribute: String, from element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value else {
            return nil
        }
        if let string = value as? String {
            return string
        }
        if let number = value as? NSNumber {
            return number.stringValue
        }
        return nil
    }

    private func captureCursorDisplay(containing point: CGPoint) async throws -> ScreenshotContext? {
        if !CGPreflightScreenCaptureAccess() {
            if !hasRequestedScreenCapturePermission {
                hasRequestedScreenCapturePermission = true
                _ = CGRequestScreenCaptureAccess()
            }
            guard CGPreflightScreenCaptureAccess() else {
                throw ContextCaptureError.screenCapturePermissionRequired
            }
        }

        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        guard let display = content.displays.first(where: { $0.frame.contains(point) })
            ?? content.displays.first else {
            throw ContextCaptureError.noDisplay
        }

        let ownPID = ProcessInfo.processInfo.processIdentifier
        let ownWindows = content.windows.filter { window in
            window.owningApplication?.processID == ownPID
        }
        let filter = SCContentFilter(display: display, excludingWindows: ownWindows)
        let configuration = SCStreamConfiguration()
        let outputWidth = min(max(display.width, 1), 1_280)
        let aspectRatio = Double(display.height) / Double(max(display.width, 1))
        let outputHeight = max(1, Int((Double(outputWidth) * aspectRatio).rounded()))
        configuration.width = outputWidth
        configuration.height = outputHeight
        configuration.showsCursor = true

        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
        let representation = NSBitmapImageRep(cgImage: image)
        guard let jpeg = representation.representation(
            using: .jpeg,
            properties: [.compressionFactor: 0.72]
        ) else {
            throw ContextCaptureError.jpegEncodingFailed
        }

        return ScreenshotContext(
            label: "cursor-display",
            base64Data: jpeg.base64EncodedString(),
            displayWidthPoints: max(1, Int(display.frame.width.rounded())),
            displayHeightPoints: max(1, Int(display.frame.height.rounded())),
            screenshotWidthPixels: outputWidth,
            screenshotHeightPixels: outputHeight
        )
    }

    private func truncated(_ value: String?, length: Int) -> String? {
        guard let value else { return nil }
        let collapsed = value.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        guard collapsed.count > length else { return collapsed }
        return String(collapsed.prefix(length)) + "…"
    }

    private func compactError(_ error: Error) -> String {
        String(describing: error)
            .replacingOccurrences(of: "\n", with: " ")
            .prefix(180)
            .description
    }
}

private enum ContextCaptureError: Error {
    case screenCapturePermissionRequired
    case noDisplay
    case jpegEncodingFailed
}
