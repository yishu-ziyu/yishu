import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import YishuContext

/// Executes product-authorized desktop actions. Accessibility is preferred;
/// self-drawn controls fall back to a pointer-preserving Quartz click after
/// checking that the captured target still belongs to the frontmost app.
@MainActor
enum YishuComputerUseActuator {
    typealias AuthorizationFence = @MainActor () -> Bool

    enum NotesExecutionOutcome: Equatable, Sendable {
        case created(noteId: String, title: String, plaintext: String)
        case blockedBeforeSubmission
        case targetStaleBeforeSubmission
        case permissionDenied
        case unavailable
        case unknownAfterSubmission
        case timedOut
    }

    typealias NotesExecutor = @MainActor (
        _ title: String,
        _ htmlBody: String,
        _ expectedPlaintext: String,
        _ authorizationFence: AuthorizationFence
    ) async -> NotesExecutionOutcome

    typealias SourceWindowValidator = @MainActor (YishuSourceWindowTarget) -> Bool

    typealias TimeReminderExecutor = @MainActor (
        _ reminderId: String,
        _ body: String,
        _ delaySeconds: Int,
        _ authorizationFence: AuthorizationFence
    ) async -> YishuTimeReminderScheduleOutcome

    /// One reusable commit point for AXSet/AXPress/CGEvent. Keeping the fence
    /// adjacent to the irreversible call makes cancellation testable without
    /// manufacturing real Accessibility elements in unit tests.
    static func authorizedCommit<Result>(
        _ authorizationFence: AuthorizationFence,
        operation: () -> Result
    ) -> Result? {
        guard authorizationFence() else { return nil }
        return operation()
    }

    /// Finder chrome navigation is two distinct actions. Back needs browse
    /// history (toolbar/menu 返回). Up is hierarchy (上层文件夹 / Enclosing).
    /// Never silent-substitute one for the other.
    enum ChromeNavigationKind: Equatable, Sendable {
        case back
        case up
    }

    /// Direct-click chrome labels that often lack OCR-visible glyphs (Finder
    /// toolbar back is `desc=返回` with a chevron, not the characters 返回).
    static func isAccessibilityChromeNavigationTarget(_ targetPhrase: String) -> Bool {
        chromeNavigationKind(forTargetPhrase: targetPhrase) != nil
    }

    /// Classify a single user target phrase into Back vs Up. Nil when not chrome nav.
    static func chromeNavigationKind(forTargetPhrase targetPhrase: String) -> ChromeNavigationKind? {
        let normalized = targetPhrase.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if ["返回", "后退", "back", "goback", "go back", "backbutton", "back button"].contains(normalized) {
            return .back
        }
        if ["上一级", "上层文件夹", "上层", "enclosing folder", "enclosingfolder", "go up", "goup"].contains(normalized)
            || normalized.contains("上层文件夹")
            || normalized.contains("enclosing") {
            return .up
        }
        return nil
    }

    /// Synonym labels for one chrome intent. Back never includes Up titles.
    static func chromeNavigationLabels(forTargetPhrase targetPhrase: String) -> [String]? {
        guard let kind = chromeNavigationKind(forTargetPhrase: targetPhrase) else { return nil }
        let target = targetPhrase.trimmingCharacters(in: .whitespacesAndNewlines)
        switch kind {
        case .back:
            var labels = [target]
            for extra in ["返回", "后退", "go back", "back button"] {
                if !labels.contains(where: { $0.caseInsensitiveCompare(extra) == .orderedSame }) {
                    labels.append(extra)
                }
            }
            return labels
        case .up:
            var labels = [target]
            for extra in ["上一级", "上层文件夹", "enclosing folder"] {
                if !labels.contains(where: { $0.caseInsensitiveCompare(extra) == .orderedSame }) {
                    labels.append(extra)
                }
            }
            return labels
        }
    }

    /// Dominant chrome intent from a label list. Back wins only when no Up label.
    static func chromeNavigationKind(forLabels labels: [String]) -> ChromeNavigationKind? {
        var sawBack = false
        var sawUp = false
        for label in labels {
            switch chromeNavigationKind(forTargetPhrase: label) {
            case .back: sawBack = true
            case .up: sawUp = true
            case nil: break
            }
        }
        // Explicit Up label never collapses into Back substitution.
        if sawUp && !sawBack { return .up }
        if sawUp && sawBack { return .up }
        if sawBack { return .back }
        return nil
    }

    /// True when `parentPath` is the immediate or ancestor directory of `childPath`.
    /// Used for Finder chrome verified read-back (child → parent only).
    static func isFilesystemPath(_ parentPath: String, ancestorOf childPath: String) -> Bool {
        let parent = normalizedFilesystemPath(parentPath)
        let child = normalizedFilesystemPath(childPath)
        guard !parent.isEmpty, !child.isEmpty, parent != child else { return false }
        let parentPrefix = parent.hasSuffix("/") ? parent : parent + "/"
        return child.hasPrefix(parentPrefix)
    }

    static func normalizedFilesystemPath(_ raw: String) -> String {
        var path = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if path.hasPrefix("file://") {
            if let url = URL(string: path) {
                path = url.path
            } else if let stripped = path.dropFirst("file://".count) as Substring? {
                path = String(stripped)
            }
        }
        // Expand ~ and strip trailing slash (except root).
        if path.hasPrefix("~") {
            path = (path as NSString).expandingTildeInPath
        }
        while path.count > 1 && path.hasSuffix("/") {
            path.removeLast()
        }
        return path
    }

    /// Presses a labeled control on the current frontmost app once, revalidating
    /// that the control still exists and still belongs to that app.
    static func performFrontmostLabeledControl(
        matching labels: [String],
        screenCaptures: [CompanionScreenCapture]
    ) async -> YishuComputerActionResult {
        let receiptId = UUID().uuidString
        let attemptId = UUID().uuidString
        guard AXIsProcessTrusted() else {
            return failed(
                "Accessibility permission is required for desktop actions.",
                code: .accessibilityPermissionDenied,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        let system = AXUIElementCreateSystemWide()
        let focusedElementBefore = elementAttribute(kAXFocusedUIElementAttribute as String, from: system)
        let windowSignatureBefore = frontmostWindowSignature()
        let beforeCapture = screenCaptures.first(where: \.isCursorScreen) ?? screenCaptures.first
        let chromeKind = chromeNavigationKind(forLabels: labels)
        let isFinderChrome = chromeKind != nil

        // Prefer Finder for chrome back/up navigation so toolbar/menu resolve.
        if isFinderChrome, let finder = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier == "com.apple.finder"
        }) {
            finder.activate(options: [.activateIgnoringOtherApps])
            try? await Task.sleep(nanoseconds: 80_000_000)
        }

        // Path-specific basis for Finder chrome: never verify on menu focus alone.
        let pathBefore = isFinderChrome ? finderFrontWindowPath() : nil

        let resolved: LabeledControlHit?
        switch chromeKind {
        case .back:
            // Back only: enabled toolbar/menu 返回. Never substitute 上层文件夹.
            resolved = resolveFinderBackControl(labels: labels)
                ?? resolveLabeledControlAcrossVisibleApps(labels: backOnlyLabels(from: labels))
        case .up:
            resolved = resolveFinderUpControl(labels: labels)
                ?? resolveLabeledControlAcrossVisibleApps(labels: upOnlyLabels(from: labels))
        case nil:
            resolved = resolveLabeledControlAcrossVisibleApps(labels: labels)
        }
        guard let resolved else {
            let message: String
            if chromeKind == .back {
                message = "Finder back control is unavailable (no browse history or disabled 返回)."
            } else {
                message = "No matching frontmost control was found."
            }
            return failed(
                message,
                code: .axElementUnavailable,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        let expectedPID = resolved.processIdentifier

        // Re-resolve immediately before the single press (fresh target).
        let live: LabeledControlHit?
        switch chromeKind {
        case .back:
            live = resolveFinderBackControl(labels: labels)
                ?? resolveLabeledControlAcrossVisibleApps(labels: backOnlyLabels(from: labels))
        case .up:
            live = resolveFinderUpControl(labels: labels)
                ?? resolveLabeledControlAcrossVisibleApps(labels: upOnlyLabels(from: labels))
        case nil:
            live = resolveLabeledControlAcrossVisibleApps(labels: labels)
        }
        guard let live, live.processIdentifier == expectedPID else {
            return failed(
                "The target control is no longer available.",
                code: .targetStale,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        let liveElement = live.element
        let before = snapshot(of: liveElement)
        let routeTag: String
        switch chromeKind {
        case .back: routeTag = "chrome_back"
        case .up: routeTag = "chrome_up"
        case nil: routeTag = "chrome_label"
        }
        switch performPress(liveElement) {
        case .blocked:
            return failed(
                "The control press was cancelled before commit.",
                code: .cancelled,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case .unsupported:
            return failed(
                "The matched control does not support AXPress.",
                code: .axElementUnavailable,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case let .attempted(actionResult):
            guard actionResult == .success else {
                return YishuComputerActionResult(
                    succeeded: true,
                    verified: false,
                    message: "AXPress delivery is uncertain; the action was not repeated.",
                    evidence: "method=ax_press;code=ax_press_failed;delivery=unknown;axError=\(actionResult.rawValue);route=\(routeTag)",
                    status: .unverified,
                    method: .axPress,
                    code: .axPressUnknown,
                    receiptId: receiptId,
                    attemptId: attemptId
                )
            }
            // Finder chrome: verified only when observed path moves to an ancestor.
            if isFinderChrome {
                try? await Task.sleep(nanoseconds: 320_000_000)
                let pathAfter = finderFrontWindowPath()
                if let pathBefore, let pathAfter,
                   isFilesystemPath(pathAfter, ancestorOf: pathBefore) {
                    let safeBefore = sanitizedPathEvidence(pathBefore)
                    let safeAfter = sanitizedPathEvidence(pathAfter)
                    return verifiedResult(
                        VerificationEvidence(
                            code: .verifiedAccessibilityChange,
                            evidence: "method=finder_path;code=verified_accessibility;route=\(routeTag);before=\(safeBefore);after=\(safeAfter)"
                        ),
                        method: .axPress,
                        receiptId: receiptId,
                        attemptId: attemptId
                    )
                }
                // Menu focus / window signature alone is not enough for chrome nav.
                let pathNote: String
                if let pathBefore, let pathAfter {
                    pathNote = "before=\(sanitizedPathEvidence(pathBefore));after=\(sanitizedPathEvidence(pathAfter));path_unchanged_or_not_ancestor"
                } else {
                    pathNote = "path_unavailable"
                }
                return YishuComputerActionResult(
                    succeeded: true,
                    verified: false,
                    message: "AXPress was delivered, but Finder path did not move to the expected parent.",
                    evidence: "method=ax;code=ax_press_unverified;route=\(routeTag);\(pathNote)",
                    status: .delivered,
                    method: .axPress,
                    code: .axPressUnverified,
                    receiptId: receiptId,
                    attemptId: attemptId
                )
            }
            if let beforeCapture {
                let verification = await readBack(
                    before: beforeCapture,
                    system: system,
                    focusedElementBefore: focusedElementBefore,
                    windowSignatureBefore: windowSignatureBefore,
                    candidate: liveElement,
                    candidateSnapshotBefore: before
                )
                if let verification {
                    return verifiedResult(
                        verification,
                        method: .axPress,
                        receiptId: receiptId,
                        attemptId: attemptId
                    )
                }
            } else if windowSignatureBefore != frontmostWindowSignature() {
                return verifiedResult(
                    VerificationEvidence(
                        code: .verifiedAccessibilityChange,
                        evidence: "method=accessibility;code=verified_accessibility_change;route=\(routeTag)"
                    ),
                    method: .axPress,
                    receiptId: receiptId,
                    attemptId: attemptId
                )
            }
            return YishuComputerActionResult(
                succeeded: true,
                verified: false,
                message: "AXPress was delivered, but the visible outcome was not confirmed.",
                evidence: "method=ax;code=ax_press_unverified;route=\(routeTag)",
                status: .delivered,
                method: .axPress,
                code: .axPressUnverified,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
    }

    private static func backOnlyLabels(from labels: [String]) -> [String] {
        labels.filter { chromeNavigationKind(forTargetPhrase: $0) != .up }
    }

    private static func upOnlyLabels(from labels: [String]) -> [String] {
        let filtered = labels.filter { chromeNavigationKind(forTargetPhrase: $0) != .back }
        return filtered.isEmpty ? labels : filtered
    }

    /// Evidence-safe path token: keep only last two path components.
    private static func sanitizedPathEvidence(_ path: String) -> String {
        let normalized = normalizedFilesystemPath(path)
        let parts = normalized.split(separator: "/").map(String.init)
        if parts.count >= 2 {
            return ".../\(parts[parts.count - 2])/\(parts[parts.count - 1])"
        }
        if let last = parts.last {
            return ".../\(last)"
        }
        return "(empty)"
    }

    private struct LabeledControlHit {
        let processIdentifier: pid_t
        let element: AXUIElement
    }

    /// Find a labeled pressable control on a visible non-self app.
    /// Prefer the OS frontmost app when it hosts the control; otherwise scan
    /// on-screen layer-0 owners so an overlay key-window does not hide Finder.
    private static func resolveLabeledControlAcrossVisibleApps(
        labels: [String]
    ) -> LabeledControlHit? {
        for pid in visibleNonSelfProcessIdentifiers() {
            if let element = findLabeledControl(inProcess: pid, labels: labels) {
                return LabeledControlHit(processIdentifier: pid, element: element)
            }
        }
        return nil
    }

    /// Resolve enabled Finder Back only (toolbar desc=返回 or Go→Back).
    /// Does not press 上层文件夹 / Enclosing Folder.
    private static func resolveFinderBackControl(
        labels: [String],
        processIdentifier: pid_t? = nil,
        window: AXUIElement? = nil,
        allowMenuFallback: Bool = true
    ) -> LabeledControlHit? {
        guard chromeNavigationKind(forLabels: labels) == .back else { return nil }
        guard let finder = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier == "com.apple.finder"
                && (processIdentifier == nil || $0.processIdentifier == processIdentifier)
        }) else {
            return nil
        }
        let backLabels = backOnlyLabels(from: labels)
        // Finder navigation must stay on the focused/main window. Never scan
        // background Finder windows for a matching toolbar button.
        let targetWindow = window ?? finderFocusedOrMainWindow(for: finder.processIdentifier)
        if let targetWindow,
           let element = findLabeledControl(inRoot: targetWindow, labels: backLabels) {
            return LabeledControlHit(processIdentifier: finder.processIdentifier, element: element)
        }
        guard allowMenuFallback else { return nil }
        // Menu bar Go → Back / 返回 (not Enclosing Folder).
        return resolveFinderGoMenuItem(
            processIdentifier: finder.processIdentifier,
            preferredTitles: ["返回", "back"]
        )
    }

    /// Resolve Finder hierarchy Up (Go → Enclosing Folder / 上层文件夹).
    private static func resolveFinderUpControl(labels: [String]) -> LabeledControlHit? {
        guard chromeNavigationKind(forLabels: labels) == .up else { return nil }
        guard let finder = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier == "com.apple.finder"
        }) else {
            return nil
        }
        return resolveFinderGoMenuItem(
            processIdentifier: finder.processIdentifier,
            preferredTitles: ["上层文件夹", "enclosing folder", "上一级"]
        )
    }

    /// menu bar → 前往/Go → preferred enabled menu item (first match by rank).
    private static func resolveFinderGoMenuItem(
        processIdentifier: pid_t,
        preferredTitles: [String]
    ) -> LabeledControlHit? {
        let app = AXUIElementCreateApplication(processIdentifier)
        guard let menuBarRef = axSingleElement(kAXMenuBarAttribute as String, from: app)
                ?? axElementArray(kAXMenuBarAttribute as String, from: app)?.first else {
            return nil
        }
        let goTitles = ["前往", "go"]
        let preferred = preferredTitles.map { $0.lowercased() }
        for menu in axElementArray(kAXChildrenAttribute as String, from: menuBarRef) ?? [] {
            let title = (stringAttribute(kAXTitleAttribute as String, from: menu) ?? "").lowercased()
            guard goTitles.contains(where: { title == $0 }) else { continue }
            var stack = axElementArray(kAXChildrenAttribute as String, from: menu) ?? []
            var candidates: [(rank: Int, element: AXUIElement)] = []
            while let node = stack.popLast() {
                let role = stringAttribute(kAXRoleAttribute as String, from: node) ?? ""
                let itemTitle = (stringAttribute(kAXTitleAttribute as String, from: node) ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased()
                if role == (kAXMenuItemRole as String) || role == "AXMenuItem" {
                    if let rank = preferred.firstIndex(where: { itemTitle == $0 || itemTitle.hasPrefix($0) }) {
                        if let enabled = boolAttribute(kAXEnabledAttribute as String, from: node),
                           enabled == false {
                            continue
                        }
                        // Never treat enclosing-folder titles as Back candidates.
                        let isEnclosing = itemTitle.contains("上层") || itemTitle.contains("enclosing")
                        let prefersBackOnly = preferred.allSatisfy {
                            !$0.contains("上层") && !$0.contains("enclosing") && $0 != "上一级"
                        }
                        if prefersBackOnly && isEnclosing {
                            continue
                        }
                        if controlAdvertisesPress(node) {
                            candidates.append((rank, node))
                        }
                    }
                }
                if let children = axElementArray(kAXChildrenAttribute as String, from: node) {
                    stack.append(contentsOf: children)
                }
            }
            if let best = candidates.sorted(by: { $0.rank < $1.rank }).first {
                return LabeledControlHit(
                    processIdentifier: processIdentifier,
                    element: best.element
                )
            }
        }
        return nil
    }

    /// Observable Finder front-window path (AXDocument / AXURL / path-like title).
    private static func finderFrontWindowPath(for processIdentifier: pid_t? = nil) -> String? {
        guard let finder = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier == "com.apple.finder"
                && (processIdentifier == nil || $0.processIdentifier == processIdentifier)
        }) else {
            return nil
        }
        guard let window = finderFocusedOrMainWindow(for: finder.processIdentifier) else {
            return nil
        }
        return filesystemPath(fromAXWindow: window)
    }

    private static func finderFocusedOrMainWindow(for processIdentifier: pid_t) -> AXUIElement? {
        let app = AXUIElementCreateApplication(processIdentifier)
        return axSingleElement(kAXFocusedWindowAttribute as String, from: app)
            ?? axSingleElement(kAXMainWindowAttribute as String, from: app)
    }

    private static func filesystemPath(fromAXWindow window: AXUIElement) -> String? {
        if let path = filesystemPathAttribute(kAXDocumentAttribute as String, from: window) {
            return path
        }
        if let path = filesystemPathAttribute(kAXURLAttribute as String, from: window) {
            return path
        }
        // Walk for a document-like child (path bar / proxy icon).
        var stack = axElementArray(kAXChildrenAttribute as String, from: window) ?? []
        var visited = 0
        while let node = stack.popLast(), visited < 80 {
            visited += 1
            if let path = filesystemPathAttribute(kAXDocumentAttribute as String, from: node)
                ?? filesystemPathAttribute(kAXURLAttribute as String, from: node) {
                return path
            }
            if let children = axElementArray(kAXChildrenAttribute as String, from: node) {
                stack.append(contentsOf: children)
            }
        }
        return nil
    }

    private static func filesystemPathAttribute(_ attribute: String, from element: AXUIElement) -> String? {
        var rawValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &rawValue) == .success,
              let rawValue else {
            return nil
        }
        if let string = rawValue as? String {
            let normalized = normalizedFilesystemPath(string)
            return normalized.hasPrefix("/") ? normalized : nil
        }
        if CFGetTypeID(rawValue) == CFURLGetTypeID() {
            let url = unsafeBitCast(rawValue, to: CFURL.self) as URL
            let normalized = normalizedFilesystemPath(url.path)
            return normalized.hasPrefix("/") ? normalized : nil
        }
        if let url = rawValue as? URL {
            let normalized = normalizedFilesystemPath(url.path)
            return normalized.hasPrefix("/") ? normalized : nil
        }
        return nil
    }

    private static func axSingleElement(_ attribute: String, from element: AXUIElement) -> AXUIElement? {
        var rawValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &rawValue) == .success,
              let rawValue,
              CFGetTypeID(rawValue) == AXUIElementGetTypeID() else {
            return nil
        }
        return unsafeBitCast(rawValue, to: AXUIElement.self)
    }

    private static func visibleNonSelfProcessIdentifiers() -> [pid_t] {
        let selfPID = ProcessInfo.processInfo.processIdentifier
        var orderedPIDs: [pid_t] = []
        if let front = NSWorkspace.shared.frontmostApplication?.processIdentifier,
           front != selfPID {
            orderedPIDs.append(front)
        }
        // Always consider Finder for chrome navigation labels.
        if let finder = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier == "com.apple.finder"
        })?.processIdentifier,
           !orderedPIDs.contains(finder) {
            orderedPIDs.append(finder)
        }
        if let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] {
            for window in windows {
                guard (window[kCGWindowLayer as String] as? Int) == 0,
                      let owner = window[kCGWindowOwnerPID as String] as? pid_t,
                      owner != selfPID,
                      !orderedPIDs.contains(owner) else {
                    continue
                }
                orderedPIDs.append(owner)
            }
        }
        return orderedPIDs
    }

    private static func findLabeledControl(
        inProcess processIdentifier: pid_t,
        labels: [String]
    ) -> AXUIElement? {
        let normalizedLabels = labels
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
        guard !normalizedLabels.isEmpty else { return nil }

        let app = AXUIElementCreateApplication(processIdentifier)
        var stack: [AXUIElement] = []
        // Prefer focused/main/windows attributes; app-child bridging is flaky for AX.
        for attribute in [
            kAXFocusedWindowAttribute as String,
            kAXMainWindowAttribute as String,
            kAXWindowsAttribute as String,
            kAXChildrenAttribute as String,
        ] {
            if let elements = axElementArray(attribute, from: app) {
                stack.append(contentsOf: elements)
            }
        }
        var visited = 0
        while let current = stack.popLast(), visited < 1_200 {
            visited += 1
            if let match = labeledPressableMatch(
                current,
                normalizedLabels: normalizedLabels,
                preferExactDescription: true,
                buttonsOnly: true
            ) {
                return match
            }
            if let children = axElementArray(kAXChildrenAttribute as String, from: current) {
                stack.append(contentsOf: children.reversed())
            }
        }

        // Second pass: exact description/title match on any pressable control.
        stack = []
        if let windows = axElementArray(kAXWindowsAttribute as String, from: app) {
            stack.append(contentsOf: windows)
        }
        visited = 0
        while let current = stack.popLast(), visited < 1_200 {
            visited += 1
            if let match = labeledPressableMatch(
                current,
                normalizedLabels: normalizedLabels,
                preferExactDescription: true,
                buttonsOnly: false
            ) {
                return match
            }
            if let children = axElementArray(kAXChildrenAttribute as String, from: current) {
                stack.append(contentsOf: children.reversed())
            }
        }
        return nil
    }

    /// Search exactly one AX subtree. Used for window-bound Finder actions so
    /// an identically labelled control in another window cannot become target.
    private static func findLabeledControl(
        inRoot root: AXUIElement,
        labels: [String]
    ) -> AXUIElement? {
        let normalizedLabels = labels
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
        guard !normalizedLabels.isEmpty else { return nil }

        for buttonsOnly in [true, false] {
            var stack = [root]
            var visited = 0
            while let current = stack.popLast(), visited < 1_200 {
                visited += 1
                if let match = labeledPressableMatch(
                    current,
                    normalizedLabels: normalizedLabels,
                    preferExactDescription: true,
                    buttonsOnly: buttonsOnly
                ) {
                    return match
                }
                if let children = axElementArray(kAXChildrenAttribute as String, from: current) {
                    stack.append(contentsOf: children.reversed())
                }
            }
        }
        return nil
    }

    private static func labeledPressableMatch(
        _ current: AXUIElement,
        normalizedLabels: [String],
        preferExactDescription: Bool,
        buttonsOnly: Bool
    ) -> AXUIElement? {
        let role = stringAttribute(kAXRoleAttribute as String, from: current) ?? ""
        let isButtonRole = role == (kAXButtonRole as String)
            || role == (kAXMenuButtonRole as String)
            || role == (kAXPopUpButtonRole as String)
            || role == "AXButton"
        if buttonsOnly && !isButtonRole {
            return nil
        }
        let title = (stringAttribute(kAXTitleAttribute as String, from: current) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let description = (stringAttribute(kAXDescriptionAttribute as String, from: current) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let help = (stringAttribute(kAXHelpAttribute as String, from: current) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let exactHit = normalizedLabels.contains { $0 == description || $0 == title }
        let containsHit = normalizedLabels.contains {
            description == $0
                || title == $0
                || description.hasPrefix($0 + "/")
                || description.hasSuffix("/" + $0)
                || help == $0
        }
        let labelHit = preferExactDescription ? (exactHit || containsHit) : containsHit
        guard labelHit, controlAdvertisesPress(current) else { return nil }
        // Require explicitly enabled when the attribute is present. Disabled
        // Finder toolbar "返回" (no browse history) must not be pressed.
        if boolAttribute(kAXEnabledAttribute as String, from: current) != true {
            // Some menu items omit AXEnabled; treat missing as enabled only for menus.
            let role = stringAttribute(kAXRoleAttribute as String, from: current) ?? ""
            let isMenuItem = role == (kAXMenuItemRole as String) || role == "AXMenuItem"
            if !isMenuItem {
                return nil
            }
            if let enabled = boolAttribute(kAXEnabledAttribute as String, from: current), enabled == false {
                return nil
            }
        }
        return current
    }

    private static func controlAdvertisesPress(_ element: AXUIElement) -> Bool {
        var rawActions: CFArray?
        let actionResult = AXUIElementCopyActionNames(element, &rawActions)
        guard actionResult == .success, let rawActions else {
            // Some controls omit action lists but still accept AXPress.
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

    private static func axElementArray(_ attribute: String, from element: AXUIElement) -> [AXUIElement]? {
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

    static func perform(
        _ request: YishuComputerActionRequest,
        screenCaptures: [CompanionScreenCapture],
        numberedTargets: [NumberedAccessibilityTarget] = [],
        authorizationFence: @escaping AuthorizationFence = { true },
        notesExecutor: NotesExecutor? = nil,
        sourceWindowValidator: @escaping SourceWindowValidator = sourceWindowStillMatches,
        timeReminderExecutor: TimeReminderExecutor? = nil
    ) async -> YishuComputerActionResult {
        let receiptId = UUID().uuidString
        let attemptId = request.attemptId ?? UUID().uuidString
        if request.action == "create_note" {
            return await performCreateNote(
                request,
                receiptId: receiptId,
                attemptId: attemptId,
                authorizationFence: authorizationFence,
                sourceWindowValidator: sourceWindowValidator,
                notesExecutor: notesExecutor ?? executeNotesCreate
            )
        }
        if request.action == "schedule_reminder" {
            return await performScheduleReminder(
                request,
                receiptId: receiptId,
                attemptId: attemptId,
                authorizationFence: authorizationFence,
                executor: timeReminderExecutor ?? { reminderId, body, delaySeconds, fence in
                    await YishuTimeReminderDelivery.schedule(
                        reminderId: reminderId,
                        body: body,
                        delaySeconds: delaySeconds,
                        authorizationFence: fence
                    )
                }
            )
        }
        if request.action == "finder_history_back" {
            return await performFinderHistoryBack(
                request,
                receiptId: receiptId,
                attemptId: attemptId,
                authorizationFence: authorizationFence
            )
        }
        if request.action == "set_text" {
            return await performSetText(
                request,
                receiptId: receiptId,
                attemptId: attemptId,
                authorizationFence: authorizationFence
            )
        }
        guard request.action == "left_click" else {
            return failed(
                "Unsupported computer action.",
                code: .unsupportedAction,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        if let targetId = request.targetId {
            return await performNumberedTargetClick(
                targetId: targetId,
                expected: numberedTargets,
                screenCaptures: screenCaptures,
                receiptId: receiptId,
                attemptId: attemptId,
                authorizationFence: authorizationFence
            )
        }
        guard AXIsProcessTrusted() else {
            return failed(
                "Accessibility permission is required for desktop actions.",
                code: .accessibilityPermissionDenied,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard let screenCapture = targetScreen(for: request.screen, in: screenCaptures) else {
            return failed(
                "The requested screen is unavailable.",
                code: .screenUnavailable,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard request.x >= 0,
              request.y >= 0,
              request.x <= Double(screenCapture.screenshotWidthInPixels),
              request.y <= Double(screenCapture.screenshotHeightInPixels) else {
            return failed(
                "The requested point is outside the captured screen.",
                code: .pointOutOfBounds,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }

        let point = globalTopLeftPoint(
            screenshotX: request.x,
            screenshotY: request.y,
            screenCapture: screenCapture
        )
        let system = AXUIElementCreateSystemWide()
        let focusedElementBefore = elementAttribute(kAXFocusedUIElementAttribute as String, from: system)
        let windowSignatureBefore = frontmostWindowSignature()
        let frontmostProcessIdentifierBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier

        var rawElement: AXUIElement?
        let lookupResult = AXUIElementCopyElementAtPosition(
            system,
            Float(point.x),
            Float(point.y),
            &rawElement
        )
        guard lookupResult == .success, let rawElement else {
            let lookupCode: YishuActionCode = .axElementUnavailable
            guard YishuActionPolicy.allowsQuartzFallback(after: lookupCode) else {
                return failed(
                    "No accessible control was found at the requested point.",
                    code: lookupCode,
                    receiptId: receiptId,
                    attemptId: attemptId
                )
            }
            return await performPointerPreservingSystemClick(
                at: point,
                before: screenCapture,
                expectedFrontmostProcessIdentifier: frontmostProcessIdentifierBefore,
                focusedElementBefore: focusedElementBefore,
                windowSignatureBefore: windowSignatureBefore,
                receiptId: receiptId,
                attemptId: attemptId,
                authorizationFence: authorizationFence
            )
        }

        var candidate: AXUIElement? = rawElement
        for _ in 0..<10 {
            guard let currentCandidate = candidate else { break }
            let before = snapshot(of: currentCandidate)
            switch performPress(currentCandidate, authorizationFence: authorizationFence) {
            case .blocked:
                return failed(
                    "The desktop action was cancelled before commit.",
                    code: .cancelled,
                    receiptId: receiptId,
                    attemptId: attemptId
                )
            case .unsupported:
                candidate = elementAttribute(kAXParentAttribute as String, from: currentCandidate)
                continue
            case let .attempted(actionResult):
                // AXPress returning an error means delivery is unknown. It is
                // not safe to reinterpret a later visual change as proof and
                // then issue a second pointer click, so this branch is always
                // terminal and unverified.
                guard actionResult == .success else {
                    return YishuComputerActionResult(
                        succeeded: true,
                        verified: false,
                        message: "AXPress delivery is uncertain; the action was not repeated.",
                        evidence: "method=ax_press;code=ax_press_failed;delivery=unknown;axError=\(actionResult.rawValue)",
                        status: .unverified,
                        method: .axPress,
                        code: .axPressUnknown,
                        receiptId: receiptId,
                        attemptId: attemptId
                    )
                }
                let verification = await readBack(
                    before: screenCapture,
                    system: system,
                    focusedElementBefore: focusedElementBefore,
                    windowSignatureBefore: windowSignatureBefore,
                    candidate: currentCandidate,
                    candidateSnapshotBefore: before
                )
                if let verification {
                    return verifiedResult(
                        verification,
                        method: .axPress,
                        receiptId: receiptId,
                        attemptId: attemptId
                    )
                }

                return YishuComputerActionResult(
                    succeeded: true,
                    verified: false,
                    message: "AXPress was delivered, but the visible outcome was not confirmed.",
                    evidence: "method=ax;code=ax_press_unverified",
                    status: .delivered,
                    method: .axPress,
                    code: .axPressUnverified,
                    receiptId: receiptId,
                    attemptId: attemptId
                )
            }
        }

        return await performPointerPreservingSystemClick(
            at: point,
            before: screenCapture,
            expectedFrontmostProcessIdentifier: frontmostProcessIdentifierBefore,
            focusedElementBefore: focusedElementBefore,
            windowSignatureBefore: windowSignatureBefore,
            receiptId: receiptId,
            attemptId: attemptId,
            authorizationFence: authorizationFence
        )
    }

    private static func performCreateNote(
        _ request: YishuComputerActionRequest,
        receiptId: String,
        attemptId: String,
        authorizationFence: @escaping AuthorizationFence,
        sourceWindowValidator: @escaping SourceWindowValidator,
        notesExecutor: NotesExecutor
    ) async -> YishuComputerActionResult {
        guard request.targetBundleId == "com.apple.Notes",
              request.effectClass == "write",
              request.intentId.flatMap(UUID.init(uuidString:)) != nil,
              request.attemptId.flatMap(UUID.init(uuidString:)) != nil,
              request.basisFrameId.flatMap(UUID.init(uuidString:)) != nil,
              let title = request.title,
              let content = request.content else {
            return failed(
                "The note request is incomplete.",
                code: .runtimeError,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard !request.hasAnySourceWindowField || request.sourceWindowTarget != nil else {
            return failed(
                "The page source pin is incomplete.",
                code: .runtimeError,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        let htmlBody = notesHTMLBody(for: content)

        // This closure is invoked inside executeNotesCreate's final synchronous
        // commit gate, immediately before the Apple event is sent. Keep source
        // freshness and the turn authorization inseparable at that point.
        var sourceChangedAtCommit = false
        let submissionFence: AuthorizationFence = {
            guard authorizationFence() else { return false }
            guard let source = request.sourceWindowTarget else { return true }
            let matches = sourceWindowValidator(source)
            sourceChangedAtCommit = !matches
            return matches
        }

        switch await notesExecutor(title, htmlBody, content, submissionFence) {
        case .blockedBeforeSubmission:
            if sourceChangedAtCommit {
                return failed(
                    "The observed page changed before the note was created.",
                    code: .targetStale,
                    receiptId: receiptId,
                    attemptId: attemptId
                )
            }
            return YishuComputerActionResult(
                succeeded: false,
                verified: false,
                message: "Note creation was blocked before submission.",
                evidence: "method=none;code=permission_denied;submitted=false",
                status: .blocked,
                method: .unknown,
                code: .permissionDenied,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case .targetStaleBeforeSubmission:
            return failed(
                "The observed page changed before the note was created.",
                code: .targetStale,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case let .created(noteId, readTitle, plaintext):
            guard !noteId.isEmpty,
                  readTitle == title,
                  plaintext == content else {
                return YishuComputerActionResult(
                    succeeded: true,
                    verified: false,
                    message: "The note was created, but exact read-back was not confirmed.",
                    evidence: "method=native_command;code=runtime_error;submitted=true;readback=not_exact",
                    status: .unverified,
                    method: .nativeCommand,
                    code: .runtimeError,
                    receiptId: receiptId,
                    attemptId: attemptId
                )
            }
            return YishuComputerActionResult(
                succeeded: true,
                verified: true,
                message: "The new note was verified by exact read-back.",
                evidence: "method=native_command;code=verified_accessibility;submitted=true;readback=exact",
                status: .verified,
                method: .nativeCommand,
                code: .verifiedAccessibility,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case .permissionDenied:
            return YishuComputerActionResult(
                succeeded: false,
                verified: false,
                message: "Automation permission for Notes was denied.",
                evidence: "method=native_command;code=permission_denied;submitted=true",
                status: .blocked,
                method: .nativeCommand,
                code: .permissionDenied,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case .unavailable:
            return failed(
                "Note automation is unavailable.",
                code: .runtimeError,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case .unknownAfterSubmission:
            return YishuComputerActionResult(
                succeeded: true,
                verified: false,
                message: "Note creation was submitted, but its result is unknown.",
                evidence: "method=native_command;code=runtime_error;submitted=true;readback=unknown",
                status: .unverified,
                method: .nativeCommand,
                code: .runtimeError,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case .timedOut:
            return YishuComputerActionResult(
                succeeded: true,
                verified: false,
                message: "Note creation timed out after submission.",
                evidence: "method=native_command;code=timeout;submitted=true;readback=unknown",
                status: .unverified,
                method: .nativeCommand,
                code: .timeout,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
    }

    private static func performScheduleReminder(
        _ request: YishuComputerActionRequest,
        receiptId: String,
        attemptId: String,
        authorizationFence: @escaping AuthorizationFence,
        executor: TimeReminderExecutor
    ) async -> YishuComputerActionResult {
        guard request.effectClass == "schedule",
              request.intentId.flatMap(UUID.init(uuidString:)) != nil,
              request.attemptId.flatMap(UUID.init(uuidString:)) != nil,
              request.basisFrameId.flatMap(UUID.init(uuidString:)) != nil,
              let reminderId = request.reminderId,
              UUID(uuidString: reminderId) != nil,
              let body = request.reminderBody,
              (1...500).contains(body.count),
              let delaySeconds = request.delaySeconds,
              (60...86_400).contains(delaySeconds) else {
            return failed(
                "The reminder request is incomplete.",
                code: .notificationScheduleFailed,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }

        switch await executor(reminderId, body, delaySeconds, authorizationFence) {
        case .verified:
            return YishuComputerActionResult(
                succeeded: true,
                verified: true,
                message: "The system reminder was verified.",
                evidence: "method=native_command;code=verified_system_notification;readback=exact",
                status: .verified,
                method: .nativeCommand,
                code: .verifiedSystemNotification,
                receiptId: receiptId,
                attemptId: attemptId,
                clockLabel: YishuTimeReminderDelivery.clockLabel(delaySeconds: delaySeconds)
            )
        case .permissionPending:
            return YishuComputerActionResult(
                succeeded: false,
                verified: false,
                message: "还没设置提醒权限，请允许后再说一次。",
                evidence: "method=native_command;code=notification_permission_pending;submitted=false",
                status: .blocked,
                method: .nativeCommand,
                code: .notificationPermissionPending,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case .permissionDenied:
            return YishuComputerActionResult(
                succeeded: false,
                verified: false,
                message: "提醒权限没有打开。",
                evidence: "method=native_command;code=notification_permission_denied;submitted=false",
                status: .blocked,
                method: .nativeCommand,
                code: .notificationPermissionDenied,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case .failedBeforeSubmission:
            return YishuComputerActionResult(
                succeeded: false,
                verified: false,
                message: "这次没有设置提醒。",
                evidence: "method=native_command;code=notification_schedule_failed;submitted=false",
                status: .failed,
                method: .nativeCommand,
                code: .notificationScheduleFailed,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case .unknownAfterSubmission:
            return YishuComputerActionResult(
                succeeded: true,
                verified: false,
                message: "提醒可能已经交给系统，但我还不能确认；我不会重复设置。",
                evidence: "method=native_command;code=timeout;submitted=true;readback=unknown",
                status: .unverified,
                method: .nativeCommand,
                code: .timeout,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
    }

    static func notesHTMLBody(for content: String) -> String {
        content
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
            .replacingOccurrences(of: "\n", with: "<br>")
    }

    /// Reads the same frontmost layer-0 window shape the context collector
    /// uses. A different tab, window, move, resize, or frontmost app fails
    /// closed; source text is never included in receipts or logs.
    static func sourceWindowStillMatches(_ expected: YishuSourceWindowTarget) -> Bool {
        guard let frontmost = NSWorkspace.shared.frontmostApplication,
              isMatchingFrontmostTarget(
                expectedPid: expected.processIdentifier,
                expectedBundleId: expected.bundleId,
                livePid: frontmost.processIdentifier,
                liveBundleId: frontmost.bundleIdentifier
              ),
              let windows = CGWindowListCopyWindowInfo(
                [.optionOnScreenOnly, .excludeDesktopElements],
                kCGNullWindowID
              ) as? [[String: Any]],
              let window = frontmostLayerZeroWindow(
                in: windows,
                ownedBy: expected.processIdentifier
              ),
              let windowNumber = window[kCGWindowNumber as String] as? Int,
              windowNumber == expected.windowNumber,
              let rawTitle = window[kCGWindowName as String] as? String,
              canonicalWindowTitle(rawTitle) == expected.title,
              let rawBounds = window[kCGWindowBounds as String] as? NSDictionary,
              let liveBounds = CGRect(dictionaryRepresentation: rawBounds),
              approximatelyEqual(liveBounds.origin.x, expected.bounds.x),
              approximatelyEqual(liveBounds.origin.y, expected.bounds.y),
              approximatelyEqual(liveBounds.width, expected.bounds.width),
              approximatelyEqual(liveBounds.height, expected.bounds.height) else {
            return false
        }
        return true
    }

    /// CGWindowList is front-to-back. The first layer-0 window owned by the
    /// frontmost process is therefore its active window; searching all its
    /// windows would incorrectly accept an old background window after a
    /// same-app window switch.
    static func frontmostLayerZeroWindow(
        in windows: [[String: Any]],
        ownedBy processIdentifier: pid_t
    ) -> [String: Any]? {
        windows.first(where: {
            ($0[kCGWindowOwnerPID as String] as? pid_t) == processIdentifier
                && ($0[kCGWindowLayer as String] as? Int) == 0
        })
    }

    private static func canonicalWindowTitle(_ rawTitle: String) -> String? {
        let trimmed = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(240))
    }

    private static func approximatelyEqual(_ lhs: CGFloat, _ rhs: Double) -> Bool {
        guard lhs.isFinite, rhs.isFinite else { return false }
        return abs(Double(lhs) - rhs) <= 0.5
    }

    private static func executeNotesCreate(
        title: String,
        htmlBody: String,
        expectedPlaintext: String,
        authorizationFence: AuthorizationFence
    ) async -> NotesExecutionOutcome {
        guard let prepared = prepareNotesCreate(
            title: title,
            htmlBody: htmlBody,
            expectedPlaintext: expectedPlaintext
        ) else {
            return .unavailable
        }
        // NSAppleScript is main-thread-bound. Preparation is complete before
        // this fresh fence, and no suspension occurs before executeAppleEvent.
        return authorizedCommit(authorizationFence) {
            submitPreparedNotesCreate(prepared)
        } ?? .blockedBeforeSubmission
    }

    private struct PreparedNotesCreate {
        let script: NSAppleScript
        let event: NSAppleEventDescriptor
    }

    private static func prepareNotesCreate(
        title: String,
        htmlBody: String,
        expectedPlaintext: String
    ) -> PreparedNotesCreate? {
        let source = """
        using terms from application "Notes"
            on createYishuNote(noteTitle, noteBody, expectedText)
                with timeout of 6 seconds
                    tell application "Notes"
                        set targetFolder to default folder of default account
                        set createdNote to make new note at targetFolder with properties {name:noteTitle, body:noteBody}
                        set createdID to id of createdNote
                        set readTitle to ""
                        set readText to ""
                        repeat 12 times
                            try
                                set liveNote to note id createdID
                                set readTitle to name of liveNote
                                set readText to plaintext of liveNote
                                if readTitle is noteTitle and readText is expectedText then exit repeat
                            end try
                            delay 0.1
                        end repeat
                        return {createdID, readTitle, readText}
                    end tell
                end timeout
            end createYishuNote
        end using terms from
        """
        guard let script = NSAppleScript(source: source) else { return nil }
        var compileError: NSDictionary?
        guard script.compileAndReturnError(&compileError) else { return nil }

        let event = NSAppleEventDescriptor(
            eventClass: AEEventClass(0x61736372), // 'ascr'
            eventID: AEEventID(0x70736272), // 'psbr'
            targetDescriptor: nil,
            returnID: AEReturnID(kAutoGenerateReturnID),
            transactionID: AETransactionID(kAnyTransactionID)
        )
        event.setParam(
            NSAppleEventDescriptor(string: "createYishuNote"),
            forKeyword: AEKeyword(0x736e616d) // 'snam'
        )
        let arguments = NSAppleEventDescriptor.list()
        arguments.insert(NSAppleEventDescriptor(string: title), at: 1)
        arguments.insert(NSAppleEventDescriptor(string: htmlBody), at: 2)
        arguments.insert(NSAppleEventDescriptor(string: expectedPlaintext), at: 3)
        event.setParam(arguments, forKeyword: AEKeyword(keyDirectObject))
        return PreparedNotesCreate(script: script, event: event)
    }

    private static func submitPreparedNotesCreate(
        _ prepared: PreparedNotesCreate
    ) -> NotesExecutionOutcome {
        var executionError: NSDictionary?
        let reply = prepared.script.executeAppleEvent(prepared.event, error: &executionError)
        if executionError != nil {
            let number = executionError?[NSAppleScript.errorNumber] as? Int
            if number == -1743 || number == -10004 { return .permissionDenied }
            if number == -1712 { return .timedOut }
            return .unknownAfterSubmission
        }
        guard reply.numberOfItems == 3,
              let noteId = reply.atIndex(1)?.stringValue,
              let readTitle = reply.atIndex(2)?.stringValue,
              let plaintext = reply.atIndex(3)?.stringValue else {
            return .unknownAfterSubmission
        }
        return .created(noteId: noteId, title: readTitle, plaintext: plaintext)
    }

    private static func performFinderHistoryBack(
        _ request: YishuComputerActionRequest,
        receiptId: String,
        attemptId: String,
        authorizationFence: @escaping AuthorizationFence
    ) async -> YishuComputerActionResult {
        guard AXIsProcessTrusted() else {
            return failed(
                "Accessibility permission is required for Finder navigation.",
                code: .accessibilityPermissionDenied,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard request.basisFrameId.flatMap(UUID.init(uuidString:)) != nil,
              request.targetBundleId == "com.apple.finder",
              let targetPid = request.targetPid else {
            return failed(
                "The Finder navigation basis is invalid.",
                code: .targetStale,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard let frontmost = NSWorkspace.shared.frontmostApplication,
              isMatchingFrontmostTarget(
                expectedPid: targetPid,
                expectedBundleId: "com.apple.finder",
                livePid: frontmost.processIdentifier,
                liveBundleId: frontmost.bundleIdentifier
              ) else {
            return failed(
                "Finder is no longer the observed frontmost application.",
                code: .frontmostChanged,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard let targetWindow = finderFocusedOrMainWindow(for: targetPid),
              let pathBefore = filesystemPath(fromAXWindow: targetWindow),
              let resolved = resolveFinderBackControl(
                labels: ["返回", "back"],
                processIdentifier: targetPid,
                window: targetWindow,
                allowMenuFallback: false
              ) else {
            return failed(
                "Finder back is unavailable or its current path cannot be observed.",
                code: .axElementUnavailable,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }

        // Fresh revalidation immediately before the one permitted AXPress.
        guard let liveFrontmost = NSWorkspace.shared.frontmostApplication,
              isMatchingFrontmostTarget(
                expectedPid: targetPid,
                expectedBundleId: "com.apple.finder",
                livePid: liveFrontmost.processIdentifier,
                liveBundleId: liveFrontmost.bundleIdentifier
              ),
              let liveWindow = finderFocusedOrMainWindow(for: targetPid),
              sameElement(targetWindow, liveWindow),
              filesystemPath(fromAXWindow: liveWindow) == pathBefore,
              let live = resolveFinderBackControl(
                labels: ["返回", "back"],
                processIdentifier: targetPid,
                window: liveWindow,
                allowMenuFallback: false
              ),
              live.processIdentifier == resolved.processIdentifier,
              sameElement(resolved.element, live.element) else {
            return failed(
                "The Finder target changed before execution.",
                code: .targetStale,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        switch performPress(live.element, authorizationFence: authorizationFence) {
        case .blocked:
            return failed(
                "Finder navigation was cancelled before commit.",
                code: .cancelled,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case .unsupported:
            return failed(
                "Finder back does not support AXPress.",
                code: .axPressUnsupported,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case let .attempted(result):
            guard result == .success else {
                return YishuComputerActionResult(
                    succeeded: true,
                    verified: false,
                    message: "Finder back delivery is uncertain; it was not repeated.",
                    evidence: "method=ax_press;code=ax_press_failed;delivery=unknown;axError=\(result.rawValue)",
                    status: .unverified,
                    method: .axPress,
                    code: .axPressUnknown,
                    receiptId: receiptId,
                    attemptId: attemptId
                )
            }
        }

        try? await Task.sleep(nanoseconds: 320_000_000)
        guard let frontmostAfter = NSWorkspace.shared.frontmostApplication,
              isMatchingFrontmostTarget(
                expectedPid: targetPid,
                expectedBundleId: "com.apple.finder",
                livePid: frontmostAfter.processIdentifier,
                liveBundleId: frontmostAfter.bundleIdentifier
              ) else {
            return YishuComputerActionResult(
                succeeded: true,
                verified: false,
                message: "Finder back was delivered, but Finder was no longer frontmost for read-back.",
                evidence: "method=ax_press;code=frontmost_mismatch;readback=unavailable",
                status: .unverified,
                method: .axPress,
                code: .frontmostMismatch,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard let readBackWindow = finderFocusedOrMainWindow(for: targetPid),
              sameElement(targetWindow, readBackWindow) else {
            return YishuComputerActionResult(
                succeeded: true,
                verified: false,
                message: "Finder back was delivered, but the focused window changed before read-back.",
                evidence: "method=ax_press;code=target_stale;readback=window_changed",
                status: .unverified,
                method: .axPress,
                code: .targetStale,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        let pathAfter = filesystemPath(fromAXWindow: readBackWindow)
        if let pathAfter, pathAfter != pathBefore {
            return YishuComputerActionResult(
                succeeded: true,
                verified: true,
                message: "Finder navigation changed as requested.",
                evidence: "method=finder_path;code=verified_accessibility;before=\(sanitizedPathEvidence(pathBefore));after=\(sanitizedPathEvidence(pathAfter))",
                status: .verified,
                method: .axPress,
                code: .verifiedAccessibility,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        return YishuComputerActionResult(
            succeeded: true,
            verified: false,
            message: "Finder back was delivered, but its path change was not confirmed.",
            evidence: "method=finder_path;code=ax_press_unverified;path=unchanged_or_unavailable",
            status: .delivered,
            method: .axPress,
            code: .axPressUnverified,
            receiptId: receiptId,
            attemptId: attemptId
        )
    }

    private static func performNumberedTargetClick(
        targetId: String,
        expected: [NumberedAccessibilityTarget],
        screenCaptures: [CompanionScreenCapture],
        receiptId: String,
        attemptId: String,
        authorizationFence: @escaping AuthorizationFence
    ) async -> YishuComputerActionResult {
        guard expected.contains(where: { $0.id == targetId }) else {
            return failed(
                "This scene has no numbered target \(targetId).",
                code: .axLookupFailed,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard AXIsProcessTrusted() else {
            return failed(
                "Accessibility permission is required for desktop actions.",
                code: .accessibilityPermissionDenied,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        let processIdentifier = NSWorkspace.shared.frontmostApplication?.processIdentifier
        switch YishuNumberedAccessibility.resolve(
            targetId: targetId,
            expected: expected,
            processIdentifier: processIdentifier
        ) {
        case .failure(.missingExpected):
            return failed(
                "This scene has no numbered target \(targetId).",
                code: .axLookupFailed,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case .failure(.unreadable):
            return failed(
                "The focused window has no readable accessibility controls.",
                code: .axLookupFailed,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case .failure(.stale):
            return failed(
                "The numbered target is no longer in the focused window.",
                code: .targetStale,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case .failure(.disabled):
            return failed(
                "The numbered target is disabled.",
                code: .axPressUnsupported,
                receiptId: receiptId,
                attemptId: attemptId
            )
        case let .success(element):
            let system = AXUIElementCreateSystemWide()
            let focusedElementBefore = elementAttribute(kAXFocusedUIElementAttribute as String, from: system)
            let windowSignatureBefore = frontmostWindowSignature()
            let beforeCapture = screenCaptures.first(where: \.isCursorScreen) ?? screenCaptures.first
            let before = snapshot(of: element)
            switch performPress(element, authorizationFence: authorizationFence) {
            case .blocked:
                return failed(
                    "The control press was cancelled before commit.",
                    code: .cancelled,
                    receiptId: receiptId,
                    attemptId: attemptId
                )
            case .unsupported:
                guard YishuComputerUseReadBack.focusEditable(
                    element,
                    authorizationFence: authorizationFence
                ) else {
                    return failed(
                        "The numbered target does not support AXPress.",
                        code: .axPressUnsupported,
                        receiptId: receiptId,
                        attemptId: attemptId
                    )
                }
                if let beforeCapture,
                   let verification = await readBack(
                    before: beforeCapture,
                    system: system,
                    focusedElementBefore: focusedElementBefore,
                    windowSignatureBefore: windowSignatureBefore,
                    candidate: element,
                    candidateSnapshotBefore: before
                   ) {
                    return verifiedResult(
                        verification,
                        method: .axPress,
                        receiptId: receiptId,
                        attemptId: attemptId
                    )
                }
                return YishuComputerActionResult(
                    succeeded: true,
                    verified: false,
                    message: "The text field was focused, but the visible outcome was not confirmed.",
                    evidence: "method=ax;code=ax_press_unverified;targetId=\(targetId);focused=true",
                    status: .delivered,
                    method: .axPress,
                    code: .axPressUnverified,
                    receiptId: receiptId,
                    attemptId: attemptId
                )
            case let .attempted(actionResult):
                guard actionResult == .success else {
                    return YishuComputerActionResult(
                        succeeded: true,
                        verified: false,
                        message: "AXPress delivery is uncertain; the action was not repeated.",
                        evidence: "method=ax_press;code=ax_press_failed;delivery=unknown;targetId=\(targetId)",
                        status: .unverified,
                        method: .axPress,
                        code: .axPressUnknown,
                        receiptId: receiptId,
                        attemptId: attemptId
                    )
                }
                if let beforeCapture {
                    let verification = await readBack(
                        before: beforeCapture,
                        system: system,
                        focusedElementBefore: focusedElementBefore,
                        windowSignatureBefore: windowSignatureBefore,
                        candidate: element,
                        candidateSnapshotBefore: before
                    )
                    if let verification {
                        return verifiedResult(
                            verification,
                            method: .axPress,
                            receiptId: receiptId,
                            attemptId: attemptId
                        )
                    }
                } else if windowSignatureBefore != frontmostWindowSignature() {
                    return verifiedResult(
                        VerificationEvidence(
                            code: .verifiedAccessibilityChange,
                            evidence: "method=accessibility;code=verified_accessibility_change;targetId=\(targetId)"
                        ),
                        method: .axPress,
                        receiptId: receiptId,
                        attemptId: attemptId
                    )
                }
                return YishuComputerActionResult(
                    succeeded: true,
                    verified: false,
                    message: "AXPress was delivered, but the visible outcome was not confirmed.",
                    evidence: "method=ax;code=ax_press_unverified;targetId=\(targetId)",
                    status: .delivered,
                    method: .axPress,
                    code: .axPressUnverified,
                    receiptId: receiptId,
                    attemptId: attemptId
                )
            }
        }
    }

    private static func performSetText(
        _ request: YishuComputerActionRequest,
        receiptId: String,
        attemptId: String,
        authorizationFence: @escaping AuthorizationFence
    ) async -> YishuComputerActionResult {
        guard AXIsProcessTrusted() else {
            return failed(
                "Accessibility permission is required for text input.",
                code: .accessibilityPermissionDenied,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard request.basisFrameId.flatMap(UUID.init(uuidString:)) != nil,
              let text = request.text,
              !text.isEmpty,
              let targetBundleId = request.targetBundleId,
              let targetPid = request.targetPid else {
            return failed(
                "The text-input request is incomplete.",
                code: .targetStale,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard let frontmost = NSWorkspace.shared.frontmostApplication,
              isMatchingFrontmostTarget(
                expectedPid: targetPid,
                expectedBundleId: targetBundleId,
                livePid: frontmost.processIdentifier,
                liveBundleId: frontmost.bundleIdentifier
              ) else {
            return failed(
                "The observed app is no longer frontmost.",
                code: .frontmostChanged,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }

        let system = AXUIElementCreateSystemWide()
        guard let focused = elementAttribute(kAXFocusedUIElementAttribute as String, from: system),
              processIdentifier(of: focused) == targetPid else {
            return failed(
                "No freshly focused text element belongs to the frontmost app.",
                code: .focusedElementUnavailable,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        let role = stringAttribute(kAXRoleAttribute as String, from: focused) ?? "unknown"
        let subrole = stringAttribute(kAXSubroleAttribute as String, from: focused)
        guard !isSecureTextTarget(role: role, subrole: subrole) else {
            return failed(
                "Secure text fields cannot be filled by desktop automation.",
                code: .secureTextBlocked,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard isWritableTextTarget(
            role: role,
            subrole: subrole,
            valueSettable: isAttributeSettable(kAXValueAttribute as String, on: focused)
        ) else {
            return failed(
                "The focused element is not a writable text field.",
                code: .axSetValueUnsupported,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }

        // Revalidate app, focus identity, ownership, role, security, and writability
        // immediately before the one AXValue write. No clipboard/key fallback.
        guard let liveFrontmost = NSWorkspace.shared.frontmostApplication,
              isMatchingFrontmostTarget(
                expectedPid: targetPid,
                expectedBundleId: targetBundleId,
                livePid: liveFrontmost.processIdentifier,
                liveBundleId: liveFrontmost.bundleIdentifier
              ),
              let liveFocused = elementAttribute(kAXFocusedUIElementAttribute as String, from: system),
              sameElement(focused, liveFocused),
              processIdentifier(of: liveFocused) == targetPid,
              isWritableTextTarget(
                role: stringAttribute(kAXRoleAttribute as String, from: liveFocused) ?? "",
                subrole: stringAttribute(kAXSubroleAttribute as String, from: liveFocused),
                valueSettable: isAttributeSettable(kAXValueAttribute as String, on: liveFocused)
              ) else {
            return failed(
                "The focused text target changed before execution.",
                code: .targetStale,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }

        guard let setResult = authorizedCommit(authorizationFence, operation: {
            AXUIElementSetAttributeValue(
                liveFocused,
                kAXValueAttribute as CFString,
                text as CFTypeRef
            )
        }) else {
            return failed(
                "Text input was cancelled before commit.",
                code: .cancelled,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard setResult == .success else {
            return failed(
                "macOS rejected the AX text update.",
                code: .axSetValueFailed,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        let safeSummary = textReadbackSummary(text, role: role)
        guard let frontmostAfter = NSWorkspace.shared.frontmostApplication,
              isMatchingFrontmostTarget(
                expectedPid: targetPid,
                expectedBundleId: targetBundleId,
                livePid: frontmostAfter.processIdentifier,
                liveBundleId: frontmostAfter.bundleIdentifier
              ),
              let focusedAfter = elementAttribute(kAXFocusedUIElementAttribute as String, from: system),
              sameElement(liveFocused, focusedAfter),
              processIdentifier(of: focusedAfter) == targetPid,
              stringAttribute(kAXValueAttribute as String, from: focusedAfter) == text else {
            return YishuComputerActionResult(
                succeeded: true,
                verified: false,
                message: "Text was set, but exact AX read-back was not confirmed.",
                evidence: "method=ax_set_value;code=ax_set_value_unverified;same=false;\(safeSummary)",
                status: .delivered,
                method: .axSetValue,
                code: .axSetValueUnverified,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        return YishuComputerActionResult(
            succeeded: true,
            verified: true,
            message: "Focused text input was verified by AX read-back.",
            evidence: "method=ax_set_value;code=verified_accessibility;same=true;\(safeSummary)",
            status: .verified,
            method: .axSetValue,
            code: .verifiedAccessibility,
            receiptId: receiptId,
            attemptId: attemptId
        )
    }

    static func isMatchingFrontmostTarget(
        expectedPid: pid_t,
        expectedBundleId: String,
        livePid: pid_t,
        liveBundleId: String?
    ) -> Bool {
        expectedPid == livePid && expectedBundleId == liveBundleId
    }

    static func isSecureTextTarget(role: String, subrole: String?) -> Bool {
        role.localizedCaseInsensitiveContains("secure")
            || subrole?.localizedCaseInsensitiveContains("secure") == true
    }

    static func isWritableTextTarget(
        role: String,
        subrole: String?,
        valueSettable: Bool
    ) -> Bool {
        guard valueSettable, !isSecureTextTarget(role: role, subrole: subrole) else { return false }
        return role == (kAXTextFieldRole as String)
            || role == (kAXTextAreaRole as String)
            || role == "AXComboBox"
    }

    private static func isAttributeSettable(_ attribute: String, on element: AXUIElement) -> Bool {
        var settable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success
            && settable.boolValue
    }

    private static func processIdentifier(of element: AXUIElement) -> pid_t? {
        var processIdentifier = pid_t()
        return AXUIElementGetPid(element, &processIdentifier) == .success ? processIdentifier : nil
    }

    static func textReadbackSummary(_ text: String, role: String) -> String {
        "length=\(text.count);role=\(role)"
    }

    /// Some apps expose an entire self-drawn sidebar as AXGroup/AXScrollArea
    /// without AXPress. Quartz is the last-resort input channel for those apps.
    /// The cursor is hidden, restored immediately after mouse-up, and never
    /// left at the agent's target point.
    private static func performPointerPreservingSystemClick(
        at point: CGPoint,
        before screenCapture: CompanionScreenCapture,
        expectedFrontmostProcessIdentifier: pid_t?,
        focusedElementBefore: AXUIElement?,
        windowSignatureBefore: String?,
        receiptId: String,
        attemptId: String,
        authorizationFence: @escaping AuthorizationFence
    ) async -> YishuComputerActionResult {
        let currentFrontmostProcessIdentifier = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let targetWindowOwnerProcessIdentifier = windowOwnerProcessIdentifier(at: point)
        guard let expectedFrontmostProcessIdentifier else {
            return failed(
                "The captured frontmost application is unavailable.",
                code: .frontmostChanged,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard currentFrontmostProcessIdentifier == expectedFrontmostProcessIdentifier else {
            return failed(
                "The target no longer belongs to the captured frontmost application.",
                code: .frontmostChanged,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard targetWindowOwnerProcessIdentifier == expectedFrontmostProcessIdentifier else {
            return failed(
                "The target window is no longer owned by the captured application.",
                code: .targetWindowNotOwned,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard targetFrameIsFresh(at: point, capturedFrame: screenCapture.globalTopLeftDisplayFrame) else {
            return failed(
                "The captured target frame is stale.",
                code: .targetFrameStale,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        guard let cursorBefore = CGEvent(source: nil)?.location,
              let source = CGEventSource(stateID: .hidSystemState),
              let mouseDown = CGEvent(
                  mouseEventSource: source,
                  mouseType: .leftMouseDown,
                  mouseCursorPosition: point,
                  mouseButton: .left
              ),
              let mouseUp = CGEvent(
                  mouseEventSource: source,
                  mouseType: .leftMouseUp,
                  mouseCursorPosition: point,
                  mouseButton: .left
              ) else {
            return failed(
                "macOS could not create a desktop click event.",
                code: .quartzEventCreationFailed,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }

        mouseDown.setIntegerValueField(.mouseEventClickState, value: 1)
        mouseUp.setIntegerValueField(.mouseEventClickState, value: 1)
        guard await postPointerPreservingClick(
            mouseDown: mouseDown,
            mouseUp: mouseUp,
            cursorBefore: cursorBefore,
            targetPoint: point,
            authorizationFence: authorizationFence
        ) else {
            return failed(
                "The desktop click was cancelled before commit.",
                code: .cancelled,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }

        let verification = await readBack(
            before: screenCapture,
            system: AXUIElementCreateSystemWide(),
            focusedElementBefore: focusedElementBefore,
            windowSignatureBefore: windowSignatureBefore,
            candidate: nil,
            candidateSnapshotBefore: nil
        )
        if let verification {
            return verifiedResult(
                verification,
                method: .quartz,
                receiptId: receiptId,
                attemptId: attemptId
            )
        }
        return YishuComputerActionResult(
            succeeded: true,
            verified: false,
            message: "The click was delivered, but the visible outcome was not confirmed.",
            evidence: "method=quartz;code=quartz_click_unverified",
            status: .delivered,
            method: .quartz,
            code: .quartzClickUnverified,
            receiptId: receiptId,
            attemptId: attemptId
        )
    }

    private static func postPointerPreservingClick(
        mouseDown: CGEvent,
        mouseUp: CGEvent,
        cursorBefore: CGPoint,
        targetPoint: CGPoint,
        authorizationFence: AuthorizationFence
    ) async -> Bool {
        let displays = Set([
            displayIdentifier(containing: cursorBefore),
            displayIdentifier(containing: targetPoint),
        ].compactMap { $0 })
        let hiddenDisplays = displays.filter { CGDisplayHideCursor($0) == .success }
        defer {
            CGWarpMouseCursorPosition(cursorBefore)
            for display in hiddenDisplays {
                CGDisplayShowCursor(display)
            }
        }

        guard authorizedCommit(authorizationFence, operation: {
            mouseDown.post(tap: .cghidEventTap)
            return true
        }) != nil else { return false }
        try? await Task.sleep(nanoseconds: 35_000_000)
        // Once down is committed, up must always be paired even if ownership
        // changes during the 35ms gap; otherwise macOS can retain a stuck drag.
        mouseUp.post(tap: .cghidEventTap)
        return true
    }

    private static func displayIdentifier(containing point: CGPoint) -> CGDirectDisplayID? {
        var display = CGDirectDisplayID()
        var count: UInt32 = 0
        guard CGGetDisplaysWithPoint(point, 1, &display, &count) == .success,
              count > 0 else {
            return nil
        }
        return display
    }

    static func shouldUsePointerPreservingSystemClick(
        expectedFrontmostProcessIdentifier: pid_t?,
        currentFrontmostProcessIdentifier: pid_t?,
        targetWindowOwnerProcessIdentifier: pid_t?
    ) -> Bool {
        guard let expectedFrontmostProcessIdentifier else { return false }
        return currentFrontmostProcessIdentifier == expectedFrontmostProcessIdentifier
            && targetWindowOwnerProcessIdentifier == expectedFrontmostProcessIdentifier
    }

    static func isValidScreenSelection(
        _ oneBasedScreenNumber: Int?,
        captureCount: Int
    ) -> Bool {
        guard let oneBasedScreenNumber else { return true }
        return oneBasedScreenNumber >= 1 && oneBasedScreenNumber <= captureCount
    }

    private static func windowOwnerProcessIdentifier(at point: CGPoint) -> pid_t? {
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }
        for window in windows {
            guard (window[kCGWindowLayer as String] as? Int) == 0,
                  let rawBounds = window[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
                  bounds.contains(point),
                  let owner = window[kCGWindowOwnerPID as String] as? pid_t else {
                continue
            }
            return owner
        }
        return nil
    }

    private static func targetScreen(
        for oneBasedScreenNumber: Int?,
        in captures: [CompanionScreenCapture]
    ) -> CompanionScreenCapture? {
        if let oneBasedScreenNumber {
            guard isValidScreenSelection(oneBasedScreenNumber, captureCount: captures.count) else {
                return nil
            }
            return captures[oneBasedScreenNumber - 1]
        }
        return captures.first(where: { $0.isCursorScreen }) ?? captures.first
    }

    static func globalTopLeftPoint(
        screenshotX: Double,
        screenshotY: Double,
        screenCapture: CompanionScreenCapture
    ) -> CGPoint {
        let frame = screenCapture.globalTopLeftDisplayFrame
        let localX = CGFloat(screenshotX)
            * frame.width
            / CGFloat(screenCapture.screenshotWidthInPixels)
        let localY = CGFloat(screenshotY)
            * frame.height
            / CGFloat(screenCapture.screenshotHeightInPixels)
        return CGPoint(x: frame.origin.x + localX, y: frame.origin.y + localY)
    }

    private struct AccessibilitySnapshot {
        let selected: Bool?
        let focused: Bool?
        let value: String?
    }

    private static func snapshot(of element: AXUIElement) -> AccessibilitySnapshot {
        AccessibilitySnapshot(
            selected: boolAttribute(kAXSelectedAttribute as String, from: element),
            focused: boolAttribute(kAXFocusedAttribute as String, from: element),
            value: stringAttribute(kAXValueAttribute as String, from: element)
        )
    }

    private enum PressAttempt {
        case blocked
        case unsupported
        case attempted(AXError)
    }

    private static func performPress(
        _ element: AXUIElement,
        authorizationFence: AuthorizationFence = { true }
    ) -> PressAttempt {
        var rawActions: CFArray?
        let actionResult = AXUIElementCopyActionNames(element, &rawActions)
        if actionResult == .success,
           let actions = rawActions as? [String],
           !actions.contains(kAXPressAction as String) {
            return .unsupported
        }
        guard let result = authorizedCommit(authorizationFence, operation: {
            AXUIElementPerformAction(element, kAXPressAction as CFString)
        }) else { return .blocked }
        return .attempted(result)
    }

    private static func elementAttribute(_ attribute: String, from element: AXUIElement) -> AXUIElement? {
        var rawValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &rawValue) == .success,
              let rawValue,
              CFGetTypeID(rawValue) == AXUIElementGetTypeID() else {
            return nil
        }
        return (rawValue as! AXUIElement)
    }

    private static func boolAttribute(_ attribute: String, from element: AXUIElement) -> Bool? {
        var rawValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &rawValue) == .success,
              let number = rawValue as? NSNumber else {
            return nil
        }
        return number.boolValue
    }

    private static func stringAttribute(_ attribute: String, from element: AXUIElement) -> String? {
        var rawValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &rawValue) == .success else {
            return nil
        }
        return rawValue as? String
    }

    private static func sameElement(_ lhs: AXUIElement?, _ rhs: AXUIElement?) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil):
            return true
        case let (lhs?, rhs?):
            return CFEqual(lhs, rhs)
        default:
            return false
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

    private static func didScreenContentChange(
        before: CompanionScreenCapture,
        matching displayFrame: CGRect
    ) async -> Bool {
        guard let afterCaptures = try? await CompanionScreenCaptureUtility.captureAllScreensAsJPEG(),
              let after = afterCaptures.first(where: {
                  approximatelyEqual($0.globalTopLeftDisplayFrame, displayFrame)
              }),
              let beforeFingerprint = grayscaleFingerprint(from: before.imageData),
              let afterFingerprint = grayscaleFingerprint(from: after.imageData),
              beforeFingerprint.count == afterFingerprint.count else {
            return false
        }

        let totalDifference = zip(beforeFingerprint, afterFingerprint).reduce(0.0) { partial, pair in
            partial + abs(Double(pair.0) - Double(pair.1)) / 255.0
        }
        return totalDifference / Double(beforeFingerprint.count) >= 0.018
    }

    private static func grayscaleFingerprint(from imageData: Data) -> [UInt8]? {
        guard let image = NSImage(data: imageData),
              let sourceImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }

        let width = 64
        let height = 40
        var pixels = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else {
            return nil
        }
        context.interpolationQuality = .low
        context.draw(sourceImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        return pixels
    }

    private static func approximatelyEqual(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        abs(lhs.origin.x - rhs.origin.x) < 1
            && abs(lhs.origin.y - rhs.origin.y) < 1
            && abs(lhs.width - rhs.width) < 1
            && abs(lhs.height - rhs.height) < 1
    }

    private struct VerificationEvidence {
        let code: YishuActionCode
        let evidence: String
    }

    private static func readBack(
        before screenCapture: CompanionScreenCapture,
        system _: AXUIElement,
        focusedElementBefore: AXUIElement?,
        windowSignatureBefore: String?,
        candidate: AXUIElement?,
        candidateSnapshotBefore: AccessibilitySnapshot?
    ) async -> VerificationEvidence? {
        guard let evidence = await YishuComputerUseReadBack.wait(
            processIdentifier: NSWorkspace.shared.frontmostApplication?.processIdentifier,
            focusedElementBefore: focusedElementBefore,
            windowSignatureBefore: windowSignatureBefore,
            candidate: candidate,
            candidateBefore: candidateSnapshotBefore.map {
                YishuComputerUseReadBack.ElementSnapshot(
                    selected: $0.selected, focused: $0.focused, value: $0.value
                )
            },
            screenChanged: {
                await didScreenContentChange(
                    before: screenCapture,
                    matching: screenCapture.globalTopLeftDisplayFrame
                )
            }
        ) else { return nil }
        return VerificationEvidence(code: evidence.code, evidence: evidence.evidence)
    }

    private static func targetFrameIsFresh(at point: CGPoint, capturedFrame: CGRect) -> Bool {
        guard capturedFrame.contains(point),
              let display = displayIdentifier(containing: point) else {
            return false
        }
        // ScreenCaptureKit and CoreGraphics use the same global top-left
        // display space here. A changed display arrangement or resolution must
        // invalidate the stale coordinate rather than sending a blind click.
        return approximatelyEqual(CGDisplayBounds(display), capturedFrame)
    }

    private static func verifiedResult(
        _ verification: VerificationEvidence,
        method: YishuActionMethod,
        receiptId: String,
        attemptId: String
    ) -> YishuComputerActionResult {
        YishuComputerActionResult(
            succeeded: true,
            verified: true,
            message: "The requested control changed visible state.",
            evidence: verification.evidence,
            status: .verified,
            method: method,
            code: verification.code,
            receiptId: receiptId,
            attemptId: attemptId
        )
    }

    private static func failed(
        _ message: String,
        code: YishuActionCode,
        receiptId: String,
        attemptId: String
    ) -> YishuComputerActionResult {
        YishuComputerActionResult(
            succeeded: false,
            verified: false,
            message: message,
            evidence: "method=none;code=\(code.rawValue)",
            status: .failed,
            method: .unknown,
            code: code,
            receiptId: receiptId,
            attemptId: attemptId
        )
    }
}
