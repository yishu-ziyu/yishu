import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import YishuContext

struct YishuCapturedContext {
    let frame: YishuContextFrame
    let screenCaptures: [CompanionScreenCapture]
}

@MainActor
final class YishuContextFrameCollector {
    private let pointerMonitor: YishuPointerTrailMonitor

    init(pointerMonitor: YishuPointerTrailMonitor) {
        self.pointerMonitor = pointerMonitor
    }

    /// `activeWindowOnly` is reserved for the narrow current-page-to-note
    /// request. Ordinary turns keep their full display evidence unchanged.
    func capture(activeWindowOnly: Bool = false, pointerSince: Date? = nil) async -> YishuCapturedContext {
        let snapshot = captureMetadata(
            includePointerTrail: true,
            includeNumberedTargets: true,
            pointerSince: pointerSince
        )
        var warnings = snapshot.warnings
        var screenCaptures: [CompanionScreenCapture] = []
        var activeWindowCapture: CompanionWindowCapture?
        if activeWindowOnly, let windowNumber = snapshot.activeWindow?.value.windowNumber {
            do {
                activeWindowCapture = try await CompanionScreenCaptureUtility.captureWindowAsJPEG(
                    windowNumber: windowNumber
                )
            } catch {
                // Do not fall back to the cursor display. The exact page is
                // either available as its own image or omitted altogether.
                warnings.append("active-window-capture-unavailable")
            }
        } else {
            do {
                screenCaptures = try await CompanionScreenCaptureUtility.captureAllScreensAsJPEG()
            } catch {
                warnings.append("screen-capture-unavailable:\(compactError(error))")
            }
        }

        let screenshots: [YishuScreenshotContext]
        if activeWindowOnly {
            // No display fallback: a missing exact window image means no image
            // evidence for this write-capable path.
            screenshots = activeWindowCapture.map { [Self.activeWindowScreenshot(from: $0)] } ?? []
        } else {
            screenshots = screenCaptures.prefix(4).map { capture in
                YishuScreenshotContext(
                label: capture.label,
                mediaType: "image/jpeg",
                base64Data: capture.imageData.base64EncodedString(),
                displayWidthPoints: capture.displayWidthInPoints,
                displayHeightPoints: capture.displayHeightInPoints,
                screenshotWidthPixels: capture.screenshotWidthInPixels,
                screenshotHeightPixels: capture.screenshotHeightInPixels,
                displayOriginXPoints: capture.displayFrame.origin.x,
                displayOriginYPoints: capture.displayFrame.origin.y
            )
            }
        }

        let frame = YishuContextFrame(
            capturedAt: snapshot.capturedAt,
            expiresAt: snapshot.capturedAt.addingTimeInterval(30),
            cursor: snapshot.cursor,
            pointerTrail: snapshot.pointerTrail,
            frontmostApplication: snapshot.frontmostApplication,
            activeWindow: snapshot.activeWindow,
            elementUnderCursor: snapshot.elementUnderCursor,
            screenshots: screenshots,
            numberedTargets: snapshot.numberedTargets,
            warnings: warnings
        )

        do {
            try frame.validate(referenceDate: snapshot.capturedAt)
            return YishuCapturedContext(frame: frame, screenCaptures: screenCaptures)
        } catch {
            let safeFrame = YishuContextFrame(
                capturedAt: snapshot.capturedAt,
                expiresAt: snapshot.capturedAt.addingTimeInterval(30),
                cursor: snapshot.cursor,
                pointerTrail: [],
                frontmostApplication: snapshot.frontmostApplication,
                activeWindow: snapshot.activeWindow,
                elementUnderCursor: snapshot.elementUnderCursor,
                screenshots: [],
                numberedTargets: snapshot.numberedTargets,
                warnings: warnings + ["context-validation-failed:\(compactError(error))"]
            )
            return YishuCapturedContext(frame: safeFrame, screenCaptures: screenCaptures)
        }
    }

    static func activeWindowScreenshot(from capture: CompanionWindowCapture) -> YishuScreenshotContext {
        YishuScreenshotContext(
            label: "current frontmost window",
            mediaType: "image/jpeg",
            base64Data: capture.imageData.base64EncodedString(),
            displayWidthPoints: capture.widthInPoints,
            displayHeightPoints: capture.heightInPoints,
            screenshotWidthPixels: capture.widthInPixels,
            screenshotHeightPixels: capture.heightInPixels,
            sourceWindowNumber: capture.windowNumber
        )
    }

    /// Metadata-only capture for ContextTrail background sampling.
    /// Omits screenshot bytes so trail.observe stays cheap and private by default.
    func captureTrailSample() -> YishuContextFrame {
        let snapshot = captureMetadata(
            includePointerTrail: false,
            includeNumberedTargets: false,
            pointerSince: nil
        )
        let frame = YishuContextFrame(
            capturedAt: snapshot.capturedAt,
            expiresAt: snapshot.capturedAt.addingTimeInterval(30),
            cursor: snapshot.cursor,
            pointerTrail: snapshot.pointerTrail,
            frontmostApplication: snapshot.frontmostApplication,
            activeWindow: snapshot.activeWindow,
            elementUnderCursor: snapshot.elementUnderCursor,
            screenshots: [],
            numberedTargets: [],
            warnings: snapshot.warnings + ["trail-sample:no-screenshot"]
        )
        return frame
    }

    private struct MetadataSnapshot {
        let capturedAt: Date
        let cursor: YishuObservedValue<YishuScreenPoint>
        let pointerTrail: [YishuPointerSample]
        let frontmostApplication: YishuObservedValue<YishuApplicationContext>?
        let activeWindow: YishuObservedValue<YishuWindowContext>?
        let elementUnderCursor: YishuObservedValue<YishuAccessibilityElementContext>?
        let numberedTargets: [YishuNumberedAccessibilityTarget]
        let warnings: [String]
    }

    /// Frontmost app + focused window + display arrangement. No screenshot bytes.
    func liveSceneIdentity(displayFingerprint: String) -> YishuHeldSceneIdentity {
        let capturedAt = Date()
        let application = frontmostApplication(capturedAt: capturedAt)
        let processIdentifier = application.map { pid_t($0.value.processIdentifier) }
        let windowNumber = processIdentifier.flatMap { pid in
            activeWindow(
                processIdentifier: Int(pid),
                capturedAt: capturedAt
            )?.value.windowNumber
        }
        return YishuHeldSceneIdentity(
            frontmostProcessIdentifier: processIdentifier,
            activeWindowNumber: windowNumber,
            displayFingerprint: displayFingerprint
        )
    }

    /// Keep press-time screenshots; refresh cursor, pointer path, and the
    /// control under the cursor so a long hold still sees the latest point.
    func refreshLiveAttention(
        onto captured: YishuCapturedContext,
        pointerSince: Date
    ) -> YishuCapturedContext {
        let snapshot = captureMetadata(
            includePointerTrail: true,
            includeNumberedTargets: true,
            pointerSince: pointerSince
        )
        let frame = YishuContextFrame(
            capturedAt: snapshot.capturedAt,
            expiresAt: snapshot.capturedAt.addingTimeInterval(30),
            cursor: snapshot.cursor,
            pointerTrail: snapshot.pointerTrail,
            frontmostApplication: snapshot.frontmostApplication,
            activeWindow: snapshot.activeWindow,
            elementUnderCursor: snapshot.elementUnderCursor,
            screenshots: captured.frame.screenshots,
            numberedTargets: snapshot.numberedTargets,
            warnings: snapshot.warnings
        )
        return YishuCapturedContext(frame: frame, screenCaptures: captured.screenCaptures)
    }

    private func captureMetadata(
        includePointerTrail: Bool,
        includeNumberedTargets: Bool,
        pointerSince: Date?
    ) -> MetadataSnapshot {
        let capturedAt = Date()
        // Screenshot display frames use NSScreen/AppKit coordinates. Keep the
        // cursor evidence in that same global bottom-left coordinate space;
        // Accessibility still receives its native Quartz top-left point below.
        let cursorLocation = NSEvent.mouseLocation
        let accessibilityLocation = YishuPointerTrailMonitor.currentGlobalPoint()
        let cursor = YishuObservedValue(
            value: YishuScreenPoint(
                x: cursorLocation.x,
                y: cursorLocation.y,
                coordinateSpace: .appKitBottomLeft
            ),
            source: "ns-event-mouse-location",
            capturedAt: capturedAt,
            confidence: 1
        )

        var warnings: [String] = []
        let application = frontmostApplication(capturedAt: capturedAt)
        let window = application.flatMap {
            activeWindow(processIdentifier: $0.value.processIdentifier, capturedAt: capturedAt)
        }
        let accessibility = accessibilityElement(
            at: accessibilityLocation,
            capturedAt: capturedAt,
            warnings: &warnings
        )
        let numbered: YishuNumberedAccessibility.Snapshot
        if includeNumberedTargets {
            numbered = YishuNumberedAccessibility.snapshot(
                processIdentifier: application.map { pid_t($0.value.processIdentifier) }
            )
            if numbered.permissionDenied {
                if !warnings.contains(where: { $0.hasPrefix("accessibility-permission-required") }) {
                    warnings.append("accessibility-permission-required")
                }
            } else if numbered.targets.isEmpty {
                warnings.append("ax-unreadable")
            }
        } else {
            numbered = YishuNumberedAccessibility.Snapshot(targets: [], permissionDenied: false)
        }
        let trail: [YishuPointerSample]
        if includePointerTrail {
            let cutoff = pointerSince ?? capturedAt.addingTimeInterval(-2.5)
            let samples = pointerMonitor.recentSamples(since: cutoff)
            trail = samples.count > 240 ? Array(samples.suffix(240)) : samples
        } else {
            trail = []
        }

        return MetadataSnapshot(
            capturedAt: capturedAt,
            cursor: cursor,
            pointerTrail: trail,
            frontmostApplication: application,
            activeWindow: window,
            elementUnderCursor: accessibility,
            numberedTargets: numbered.targets,
            warnings: warnings
        )
    }

    private func frontmostApplication(
        capturedAt: Date
    ) -> YishuObservedValue<YishuApplicationContext>? {
        guard let application = NSWorkspace.shared.frontmostApplication,
              application.processIdentifier > 0 else {
            return nil
        }

        return YishuObservedValue(
            value: YishuApplicationContext(
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
    ) -> YishuObservedValue<YishuWindowContext>? {
        guard let rawWindows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]],
        let window = rawWindows.first(where: { item in
            let ownerPID = item[kCGWindowOwnerPID as String] as? Int
            let layer = item[kCGWindowLayer as String] as? Int
            return ownerPID == processIdentifier && layer == 0
        }) else {
            return nil
        }

        var bounds: YishuWindowBounds?
        if let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary,
           let rect = CGRect(dictionaryRepresentation: boundsDictionary) {
            bounds = YishuWindowBounds(
                x: rect.origin.x,
                y: rect.origin.y,
                width: rect.width,
                height: rect.height
            )
        }

        let rawTitle = window[kCGWindowName as String] as? String
        let title = rawTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
        let windowNumber = window[kCGWindowNumber as String] as? Int
        return YishuObservedValue(
            value: YishuWindowContext(
                title: title?.isEmpty == false ? truncated(title, length: 240) : nil,
                ownerName: (window[kCGWindowOwnerName as String] as? String) ?? "Unknown application",
                processIdentifier: processIdentifier,
                windowNumber: windowNumber.flatMap { $0 > 0 ? $0 : nil },
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
    ) -> YishuObservedValue<YishuAccessibilityElementContext>? {
        guard AXIsProcessTrusted() else {
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
        return YishuObservedValue(
            value: YishuAccessibilityElementContext(
                role: role,
                subrole: subrole,
                title: truncated(stringAttribute(kAXTitleAttribute, from: element), length: 240),
                description: truncated(stringAttribute(kAXDescriptionAttribute, from: element), length: 240),
                valuePreview: isSecure
                    ? nil
                    : truncated(stringAttribute(kAXValueAttribute, from: element), length: 240)
            ),
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
