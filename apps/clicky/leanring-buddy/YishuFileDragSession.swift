import AppKit
import ApplicationServices
import Foundation
import YishuContext

struct YishuFileDragRequest {
    let fileURL: URL
    let basename: String
    let sourceView: NSView
    let sourcePointAppKit: CGPoint
    let destinationPointAppKit: CGPoint
    let destinationPointQuartz: CGPoint
}

enum YishuFileDragOutcome: Equatable {
    case committed
    case blocked
    case failed
}

@MainActor
protocol YishuFileDropExecuting: AnyObject {
    func perform(
        _ request: YishuFileDragRequest,
        authorizationFence: @escaping YishuComputerUseActuator.AuthorizationFence
    ) async -> YishuFileDragOutcome
}

@MainActor
final class YishuFileDraggingSource: NSObject, NSDraggingSource {
    static var active: YishuFileDraggingSource?

    func draggingSession(
        _ session: NSDraggingSession,
        sourceOperationMaskFor context: NSDraggingContext
    ) -> NSDragOperation {
        .copy
    }

    func draggingSession(
        _ session: NSDraggingSession,
        endedAt screenPoint: NSPoint,
        operation: NSDragOperation
    ) {
        if YishuFileDraggingSource.active === self {
            YishuFileDraggingSource.active = nil
        }
    }
}

@MainActor
final class YishuAppKitFileDragDriver: YishuFileDropExecuting {
    static let shared = YishuAppKitFileDragDriver()

    static func clearActiveAfterMouseFailure() {
        YishuFileDraggingSource.active = nil
    }

    func perform(
        _ request: YishuFileDragRequest,
        authorizationFence: @escaping YishuComputerUseActuator.AuthorizationFence
    ) async -> YishuFileDragOutcome {
        guard request.fileURL.isFileURL,
              request.fileURL.lastPathComponent == request.basename,
              let window = request.sourceView.window,
              window.isVisible else {
            return .failed
        }
        let item = NSDraggingItem(pasteboardWriter: request.fileURL as NSURL)
        let sourceInWindow = window.convertPoint(fromScreen: request.sourcePointAppKit)
        let sourceInView = request.sourceView.convert(sourceInWindow, from: nil)
        let icon = NSWorkspace.shared.icon(forFile: request.fileURL.path)
        icon.size = NSSize(width: 32, height: 32)
        item.setDraggingFrame(
            NSRect(x: sourceInView.x - 16, y: sourceInView.y - 16, width: 32, height: 32),
            contents: icon
        )
        guard let event = NSEvent.mouseEvent(
            with: .leftMouseDown,
            location: sourceInWindow,
            modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber,
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: 1
        ) else {
            return .failed
        }
        let source = YishuFileDraggingSource()
        YishuFileDraggingSource.active = source
        let previousIgnore = window.ignoresMouseEvents
        window.ignoresMouseEvents = false
        defer { window.ignoresMouseEvents = previousIgnore }
        guard YishuComputerUseActuator.authorizedCommit(authorizationFence, operation: { true }) != nil else {
            window.ignoresMouseEvents = previousIgnore
            YishuFileDraggingSource.active = nil
            return .blocked
        }
        let session = request.sourceView.beginDraggingSession(with: [item], event: event, source: source)
        session.draggingFormation = .default
        return await Self.finishDropAfterSessionStarted(
            restoreOverlayClickThrough: { window.ignoresMouseEvents = previousIgnore },
            postDragged: { self.postMouse(.leftMouseDragged, at: request.destinationPointQuartz) },
            postUp: { self.postMouse(.leftMouseUp, at: request.destinationPointQuartz) }
        )
    }

    /// Overlay must become click-through again before HID drag events, so the
    /// browser under it is the drop destination.
    static func finishDropAfterSessionStarted(
        restoreOverlayClickThrough: () -> Void,
        postDragged: () -> Bool,
        postUp: () -> Bool
    ) async -> YishuFileDragOutcome {
        restoreOverlayClickThrough()
        guard postDragged() else {
            clearActiveAfterMouseFailure()
            return .failed
        }
        try? await Task.sleep(nanoseconds: 25_000_000)
        guard postUp() else {
            clearActiveAfterMouseFailure()
            return .failed
        }
        return .committed
    }

    private func postMouse(_ type: CGEventType, at point: CGPoint) -> Bool {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let event = CGEvent(
                mouseEventSource: source,
                mouseType: type,
                mouseCursorPosition: point,
                mouseButton: .left
              ) else {
            return false
        }
        event.post(tap: .cghidEventTap)
        return true
    }
}

@MainActor
struct YishuFileDropSeams {
    var downloadsDirectory: URL
    var resolver: ((String, URL) -> Result<URL, YishuDownloadsFileResolver.Failure>)?
    var snapshot: (pid_t) -> YishuNumberedAccessibility.Snapshot
    var frontmost: () -> (pid: pid_t, bundleId: String?)?
    var windowNumber: (pid_t) -> Int?
    var sourceView: () -> NSView?
    var primaryDisplayHeight: CGFloat
    var drag: YishuFileDropExecuting
    var attachmentBasenames: () async -> [String]
    var readbackBudgetNanoseconds: UInt64 = 0
}

enum YishuFileDropAction {
    private static let browserBundleIds: Set<String> = [
        "local.yishu.chrome-main",
        "com.apple.Safari",
        "com.apple.SafariTechnologyPreview",
        "com.google.Chrome",
        "org.chromium.Chromium",
        "com.microsoft.edgemac",
        "org.mozilla.firefox",
        "org.mozilla.firefoxdeveloperedition",
        "org.mozilla.nightly",
        "company.thebrowser.Browser",
        "com.brave.Browser",
    ]

    static func isAllowedBrowserBundleId(_ bundleId: String) -> Bool {
        if bundleId == "local.yishu.chrome-main" { return true }
        if browserBundleIds.contains(bundleId) { return true }
        return browserBundleIds.contains { prefix in
            prefix != "local.yishu.chrome-main" && bundleId.hasPrefix(prefix + ".")
        }
    }

    static func sourcePoint(forDestination destination: CGPoint) -> CGPoint {
        CGPoint(x: destination.x - 24, y: destination.y + 24)
    }

    @MainActor
    static func perform(
        _ request: YishuComputerActionRequest,
        authorizationFence: @escaping YishuComputerUseActuator.AuthorizationFence,
        seams: YishuFileDropSeams?
    ) async -> YishuComputerActionResult {
        let receiptId = UUID().uuidString
        let attemptId = request.attemptId ?? UUID().uuidString
        guard request.action == "drop_download_file",
              request.effectClass == "external_disclosure",
              let fileName = request.fileName,
              let targetId = request.targetId,
              let targetBundleId = request.targetBundleId,
              let targetPid = request.targetPid,
              let targetWindowNumber = request.targetWindowNumber,
              let targetFingerprint = request.targetFingerprint else {
            return fail("The file-drop request is incomplete.", .runtimeError, receiptId, attemptId)
        }
        guard isAllowedBrowserBundleId(targetBundleId) else {
            return fail(
                "File drop is only allowed onto a browser window.",
                .frontmostMismatch,
                receiptId,
                attemptId
            )
        }

        let downloads = seams?.downloadsDirectory
            ?? FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        guard let downloads else {
            return fail("The Downloads file is not available.", .fileNotFound, receiptId, attemptId)
        }
        let resolve = seams?.resolver ?? YishuDownloadsFileResolver.resolve
        let fileURL: URL
        switch resolve(fileName, downloads) {
        case .failure(.invalidName), .failure(.notFound):
            return fail("The Downloads file is not available.", .fileNotFound, receiptId, attemptId)
        case .failure(.ambiguous):
            return fail("Multiple Downloads files match that name.", .fileAmbiguous, receiptId, attemptId)
        case .failure(.unreadable):
            return fail("The Downloads file cannot be read.", .fileUnreadable, receiptId, attemptId)
        case .failure(.outsideDownloads):
            return fail("The Downloads file is not in the Downloads folder.", .fileOutsideDownloads, receiptId, attemptId)
        case let .success(url):
            fileURL = url
        }

        let frontmost = seams?.frontmost() ?? {
            guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
            return (app.processIdentifier, app.bundleIdentifier)
        }()
        guard let frontmost,
              YishuComputerUseActuator.isMatchingFrontmostTarget(
                expectedPid: targetPid,
                expectedBundleId: targetBundleId,
                livePid: frontmost.pid,
                liveBundleId: frontmost.bundleId
              ) else {
            return fail(
                "The observed app is no longer frontmost.",
                .frontmostMismatch,
                receiptId,
                attemptId,
                status: .stale
            )
        }

        let liveWindowNumber = seams?.windowNumber(targetPid) ?? liveWindowNumber(ownedBy: targetPid)
        guard liveWindowNumber == targetWindowNumber else {
            return fail(
                "The upload target window is no longer frontmost.",
                .targetStale,
                receiptId,
                attemptId,
                status: .stale
            )
        }

        let snapshot: YishuNumberedAccessibility.Snapshot
        if let seams {
            snapshot = seams.snapshot(targetPid)
        } else {
            guard AXIsProcessTrusted() else {
                return fail(
                    "Accessibility permission is required for desktop actions.",
                    .accessibilityPermissionDenied,
                    receiptId,
                    attemptId
                )
            }
            snapshot = YishuNumberedAccessibility.snapshot(processIdentifier: targetPid)
        }
        guard let live = snapshot.targets.first(where: { $0.id == targetId }) else {
            return fail(
                "This scene has no numbered target \(targetId).",
                .axLookupFailed,
                receiptId,
                attemptId,
                status: .stale
            )
        }
        if live.enabled == false {
            return fail("The numbered target is disabled.", .axPressUnsupported, receiptId, attemptId)
        }
        guard YishuNumberedAccessibility.fingerprint(live) == targetFingerprint else {
            return fail(
                "The upload target is no longer in the focused window.",
                .targetStale,
                receiptId,
                attemptId,
                status: .stale
            )
        }
        guard YishuFileDropReadBack.isUploadDropLabel(title: live.title, description: live.description) else {
            return fail(
                "The numbered target is not an upload drop zone.",
                .targetStale,
                receiptId,
                attemptId,
                status: .stale
            )
        }
        guard let frame = live.frame, frame.width > 0, frame.height > 0 else {
            return fail(
                "The upload target is no longer in the focused window.",
                .targetStale,
                receiptId,
                attemptId,
                status: .stale
            )
        }

        let primaryHeight = seams?.primaryDisplayHeight ?? OverlayCoordinateSpace.primaryDisplayHeight()
        let destinationAppKit = OverlayCoordinateSpace.appKitCenter(
            ofQuartzFrame: frame,
            primaryDisplayHeight: primaryHeight
        )
        let destinationQuartz = CGPoint(x: frame.midX, y: frame.midY)
        let sourceAppKit = sourcePoint(forDestination: destinationAppKit)
        guard let sourceView = seams?.sourceView() ?? OverlayWindow.displayedDraggingSourceView() else {
            return fail("The overlay is not available for file drag.", .dragSessionFailed, receiptId, attemptId)
        }

        let names: () async -> [String] = {
            if let seams {
                return await seams.attachmentBasenames()
            }
            return YishuFileDropReadBack.liveAttachmentStrings(processIdentifier: targetPid)
        }
        let baselineCount = YishuFileDropReadBack.exactBasenameCount(fileName, in: await names())
        let dragRequest = YishuFileDragRequest(
            fileURL: fileURL,
            basename: fileName,
            sourceView: sourceView,
            sourcePointAppKit: sourceAppKit,
            destinationPointAppKit: destinationAppKit,
            destinationPointQuartz: destinationQuartz
        )
        let driver = seams?.drag ?? YishuAppKitFileDragDriver.shared
        let outcome = await driver.perform(dragRequest, authorizationFence: authorizationFence)
        switch outcome {
        case .blocked:
            return fail(
                "The file drop was cancelled before commit.",
                .cancelled,
                receiptId,
                attemptId,
                status: .cancelled
            )
        case .failed:
            return fail("The file drag could not be started.", .dragSessionFailed, receiptId, attemptId)
        case .committed:
            break
        }

        let budget = seams?.readbackBudgetNanoseconds ?? YishuFileDropReadBack.budgetNanoseconds
        if await YishuFileDropReadBack.waitForBasenameCountIncrease(
            fileName,
            baseline: baselineCount,
            budgetNanoseconds: budget,
            names: names
        ) {
            return YishuComputerActionResult(
                succeeded: true,
                verified: true,
                message: "The file attachment was verified by AX read-back.",
                evidence: "method=appkit_drag;code=verified_accessibility;basename_count_increased=true",
                status: .verified,
                method: .appkitDrag,
                code: .verifiedAccessibility,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        return YishuComputerActionResult(
            succeeded: true,
            verified: false,
            message: "The file was dragged, but the attachment was not confirmed.",
            evidence: "method=appkit_drag;code=drop_unverified",
            status: .delivered,
            method: .appkitDrag,
            code: .dropUnverified,
            receiptId: receiptId,
            attemptId: attemptId
        )
    }

    @MainActor
    private static func liveWindowNumber(ownedBy processIdentifier: pid_t) -> Int? {
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }
        return YishuComputerUseActuator.frontmostLayerZeroWindow(
            in: windows,
            ownedBy: processIdentifier
        ).flatMap { $0[kCGWindowNumber as String] as? Int }
    }

    private static func fail(
        _ message: String,
        _ code: YishuActionCode,
        _ receiptId: String,
        _ attemptId: String,
        status: YishuActionStatus = .failed
    ) -> YishuComputerActionResult {
        YishuComputerActionResult(
            succeeded: false,
            verified: false,
            message: message,
            evidence: "method=appkit_drag;code=\(code.rawValue)",
            status: status,
            method: .appkitDrag,
            code: code,
            receiptId: receiptId,
            attemptId: attemptId
        )
    }
}
