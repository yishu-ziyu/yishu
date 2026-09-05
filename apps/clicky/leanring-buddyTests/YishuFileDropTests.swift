import AppKit
import Foundation
import Testing
import YishuContext
@testable import Clicky

@MainActor
final class YishuRecordingFileDropDriver: YishuFileDropExecuting {
    private(set) var commitCount = 0
    private(set) var lastRequest: YishuFileDragRequest?
    private(set) var fenceAtCommit: Bool?
    var outcome: YishuFileDragOutcome = .committed

    func perform(
        _ request: YishuFileDragRequest,
        authorizationFence: @escaping YishuComputerUseActuator.AuthorizationFence
    ) async -> YishuFileDragOutcome {
        let allowed = authorizationFence()
        fenceAtCommit = allowed
        guard allowed else { return .blocked }
        commitCount += 1
        lastRequest = request
        return outcome
    }
}

@MainActor
struct YishuFileDropTests {
    private let fileName = "奕枢测试文件.txt"
    private let quartzFrame = CGRect(x: 100, y: 200, width: 240, height: 80)
    private let primaryHeight: CGFloat = 982
    private var fingerprint: String {
        YishuNumberedAccessibility.fingerprint(liveTarget())
    }

    @Test func resolverAcceptsOnlyTopLevelExactReadableFiles() throws {
        let root = try makeDownloads()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent(fileName)
        try Data("ok".utf8).write(to: file)

        let url = try YishuDownloadsFileResolver.resolve(fileName: fileName, downloadsDirectory: root).get()
        #expect(url.lastPathComponent == fileName)
        #expect(url.isFileURL)
        #expect(url.path.hasPrefix(root.resolvingSymlinksInPath().path))
    }

    @Test func resolverRejectsMissingDirectorySymlinkEscapeAndUnreadable() throws {
        let root = try makeDownloads()
        defer { try? FileManager.default.removeItem(at: root) }

        #expect(YishuDownloadsFileResolver.resolve(fileName: fileName, downloadsDirectory: root) == .failure(.notFound))
        #expect(YishuDownloadsFileResolver.resolve(fileName: "../secret.txt", downloadsDirectory: root) == .failure(.invalidName))

        let directory = root.appendingPathComponent("folder.bin")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        #expect(YishuDownloadsFileResolver.resolve(fileName: "folder.bin", downloadsDirectory: root) == .failure(.unreadable))

        let outside = FileManager.default.temporaryDirectory
            .appendingPathComponent("yishu-outside-\(UUID().uuidString).txt")
        try Data("secret".utf8).write(to: outside)
        defer { try? FileManager.default.removeItem(at: outside) }
        let link = root.appendingPathComponent(fileName)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
        #expect(YishuDownloadsFileResolver.resolve(fileName: fileName, downloadsDirectory: root) == .failure(.outsideDownloads))

        try FileManager.default.removeItem(at: link)
        let nestedDir = root.appendingPathComponent("inner-dir")
        try FileManager.default.createDirectory(at: nestedDir, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: nestedDir)
        #expect(YishuDownloadsFileResolver.resolve(fileName: fileName, downloadsDirectory: root) == .failure(.unreadable))

        try FileManager.default.removeItem(at: link)
        try Data("ok".utf8).write(to: link)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: link.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: link.path)
        }
        #expect(YishuDownloadsFileResolver.resolve(fileName: fileName, downloadsDirectory: root) == .failure(.unreadable))
    }

    @Test func allowedBrowserBundleIdsCoverCommonBrowsersOnly() {
        for bundleId in [
            "local.yishu.chrome-main",
            "com.apple.Safari",
            "com.apple.SafariTechnologyPreview",
            "com.google.Chrome",
            "com.google.Chrome.canary",
            "org.chromium.Chromium",
            "com.microsoft.edgemac",
            "com.microsoft.edgemac.beta",
            "org.mozilla.firefox",
            "org.mozilla.firefoxdeveloperedition",
            "company.thebrowser.Browser",
            "com.brave.Browser",
            "com.brave.Browser.beta",
        ] {
            #expect(YishuFileDropAction.isAllowedBrowserBundleId(bundleId))
        }
        for bundleId in [
            "com.apple.Notes",
            "com.apple.finder",
            "com.apple.mail",
            "com.tinyspeck.slackmacgap",
            "com.google.ChromePWA",
            "com.microsoft.Excel",
            "local.yishu.chrome-main.extra",
        ] {
            #expect(!YishuFileDropAction.isAllowedBrowserBundleId(bundleId))
        }
    }

    @Test func yishuChromeMainBundleIsAcceptedBeforeCommit() async throws {
        let env = try harness(frontmostBundleId: "local.yishu.chrome-main")
        defer { env.cleanup() }
        let result = await YishuComputerUseActuator.perform(
            dropRequest(bundleId: "local.yishu.chrome-main"),
            screenCaptures: [],
            fileDrop: env.seams
        )
        #expect(result.verified)
        #expect(result.code == .verifiedAccessibility)
        #expect(env.driver.commitCount == 1)
        assertNoPath(in: result, downloads: env.downloads)
    }

    @Test func nonBrowserBundleIsRejectedBeforeCommit() async throws {
        let env = try harness()
        defer { env.cleanup() }
        for bundleId in ["com.apple.Notes", "com.apple.finder", "com.apple.mail"] {
            let result = await YishuComputerUseActuator.perform(
                dropRequest(bundleId: bundleId),
                screenCaptures: [],
                fileDrop: env.seams
            )
            #expect(result.code == .frontmostMismatch)
            #expect(result.status == .failed)
            #expect(!result.verified)
            assertNoPath(in: result, downloads: env.downloads)
        }
        #expect(env.driver.commitCount == 0)
    }

    @Test func mousePostFailureClearsDraggingSource() {
        YishuFileDraggingSource.active = YishuFileDraggingSource()
        #expect(YishuFileDraggingSource.active != nil)
        YishuAppKitFileDragDriver.clearActiveAfterMouseFailure()
        #expect(YishuFileDraggingSource.active == nil)
    }

    @Test func overlayClickThroughRestoresBeforeDragEvents() async {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 80, height: 80),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.ignoresMouseEvents = false
        var order: [String] = []
        let outcome = await YishuAppKitFileDragDriver.finishDropAfterSessionStarted(
            restoreOverlayClickThrough: {
                window.ignoresMouseEvents = true
                order.append("restore")
            },
            postDragged: {
                order.append("dragged")
                #expect(window.ignoresMouseEvents)
                return true
            },
            postUp: {
                order.append("up")
                #expect(window.ignoresMouseEvents)
                return true
            }
        )
        #expect(outcome == .committed)
        #expect(order == ["restore", "dragged", "up"])
        #expect(window.ignoresMouseEvents)
    }

    @Test func dropZoneCandidatesStayNamedAndDoNotAdmitStaticText() {
        #expect(YishuNumberedAccessibility.isNamedDropZone(
            role: "AXGroup",
            title: "上传文件",
            description: "拖放到这里"
        ))
        #expect(!YishuNumberedAccessibility.isNamedDropZone(
            role: "AXStaticText",
            title: "上传文件",
            description: "拖放到这里"
        ))
        #expect(!YishuNumberedAccessibility.isNamedDropZone(
            role: "AXGroup",
            title: "精选",
            description: nil
        ))
        #expect(!YishuNumberedAccessibility.isNamedDropZone(
            role: "AXGroup",
            title: nil,
            description: nil
        ))
        var candidates = [
            YishuNumberedAccessibility.Candidate(
                role: "AXButton", title: "Send", description: nil, enabled: true, x: 10, y: 10, width: 40, height: 20
            ),
            YishuNumberedAccessibility.Candidate(
                role: "AXGroup",
                title: "上传文件",
                description: "拖放到这里",
                enabled: true,
                x: 80,
                y: 10,
                width: 120,
                height: 40
            ),
        ]
        candidates.append(contentsOf: (3...60).map { index in
            YishuNumberedAccessibility.Candidate(
                role: "AXButton",
                title: "Extra\(index)",
                description: nil,
                enabled: true,
                x: Double(index),
                y: 100,
                width: 20,
                height: 12
            )
        })
        let targets = YishuNumberedAccessibility.assignIds(candidates)
        #expect(targets.count == 50)
        #expect(targets[0].title == "Send")
        #expect(targets[1].title == "上传文件")
        #expect(targets[1].frame == CGRect(x: 80, y: 10, width: 120, height: 40))
    }

    @Test func successCommitsOneFileURLAndVerifiesExactBasename() async throws {
        let env = try harness(readback: [fileName])
        defer { env.cleanup() }
        let result = await YishuComputerUseActuator.perform(
            env.request,
            screenCaptures: [],
            numberedTargets: [staleFallbackTarget()],
            fileDrop: env.seams
        )
        #expect(result.verified)
        #expect(result.status == .verified)
        #expect(result.method == .appkitDrag)
        #expect(result.code == .verifiedAccessibility)
        #expect(env.driver.commitCount == 1)
        #expect(env.driver.fenceAtCommit == true)
        let drag = try #require(env.driver.lastRequest)
        #expect(drag.fileURL.isFileURL)
        #expect(drag.fileURL.lastPathComponent == fileName)
        #expect(drag.basename == fileName)
        #expect(drag.destinationPointAppKit == OverlayCoordinateSpace.appKitCenter(
            ofQuartzFrame: quartzFrame,
            primaryDisplayHeight: primaryHeight
        ))
        #expect(drag.sourcePointAppKit == YishuFileDropAction.sourcePoint(forDestination: drag.destinationPointAppKit))
        assertNoPath(in: result, downloads: env.downloads)
    }

    @Test func missingFileDoesNotStartDrag() async throws {
        let env = try harness(createFile: false)
        defer { env.cleanup() }
        let result = await YishuComputerUseActuator.perform(env.request, screenCaptures: [], fileDrop: env.seams)
        #expect(result.code == .fileNotFound)
        #expect(!result.verified)
        #expect(env.driver.commitCount == 0)
        assertNoPath(in: result, downloads: env.downloads)
    }

    @Test func directoryDoesNotStartDrag() async throws {
        let env = try harness(createFile: false)
        defer { env.cleanup() }
        try FileManager.default.createDirectory(
            at: env.downloads.appendingPathComponent(fileName),
            withIntermediateDirectories: true
        )
        let result = await YishuComputerUseActuator.perform(env.request, screenCaptures: [], fileDrop: env.seams)
        #expect(result.code == .fileUnreadable)
        #expect(env.driver.commitCount == 0)
        assertNoPath(in: result, downloads: env.downloads)
    }

    @Test func symlinkEscapeDoesNotStartDrag() async throws {
        let env = try harness(createFile: false)
        defer { env.cleanup() }
        let outside = FileManager.default.temporaryDirectory
            .appendingPathComponent("yishu-escape-\(UUID().uuidString).txt")
        try Data("no".utf8).write(to: outside)
        defer { try? FileManager.default.removeItem(at: outside) }
        try FileManager.default.createSymbolicLink(
            at: env.downloads.appendingPathComponent(fileName),
            withDestinationURL: outside
        )
        let result = await YishuComputerUseActuator.perform(env.request, screenCaptures: [], fileDrop: env.seams)
        #expect(result.code == .fileOutsideDownloads)
        #expect(env.driver.commitCount == 0)
        assertNoPath(in: result, downloads: env.downloads)
    }

    @Test func unreadableFileDoesNotStartDrag() async throws {
        let env = try harness()
        defer { env.cleanup() }
        let path = env.downloads.appendingPathComponent(fileName).path
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path) }
        let result = await YishuComputerUseActuator.perform(env.request, screenCaptures: [], fileDrop: env.seams)
        #expect(result.code == .fileUnreadable)
        #expect(env.driver.commitCount == 0)
        assertNoPath(in: result, downloads: env.downloads)
    }

    @Test func staleWindowAndTargetNeverCommit() async throws {
        let windowStale = try harness(windowNumber: 99)
        defer { windowStale.cleanup() }
        let windowResult = await YishuComputerUseActuator.perform(
            windowStale.request,
            screenCaptures: [],
            numberedTargets: [liveTarget()],
            fileDrop: windowStale.seams
        )
        #expect(windowResult.code == .targetStale)
        #expect(windowResult.status == .stale)
        #expect(windowStale.driver.commitCount == 0)

        let targetStale = try harness(liveFingerprint: ["AXGroup", "旧上传区", "gone"].joined(separator: "\u{1e}"))
        defer { targetStale.cleanup() }
        let targetResult = await YishuComputerUseActuator.perform(
            targetStale.request,
            screenCaptures: [],
            fileDrop: targetStale.seams
        )
        #expect(targetResult.code == .targetStale)
        #expect(targetResult.status == .stale)
        #expect(targetStale.driver.commitCount == 0)

        let missingSnapshot = try harness(includeLiveTarget: false)
        defer { missingSnapshot.cleanup() }
        let missing = await YishuComputerUseActuator.perform(
            missingSnapshot.request,
            screenCaptures: [],
            numberedTargets: [liveTarget()],
            fileDrop: missingSnapshot.seams
        )
        #expect(missing.code == .axLookupFailed)
        #expect(missing.status == .stale)
        #expect(missingSnapshot.driver.commitCount == 0)

        let movedTarget = try harness(liveFrame: CGRect(x: 124, y: 200, width: 240, height: 80))
        defer { movedTarget.cleanup() }
        let moved = await YishuComputerUseActuator.perform(
            movedTarget.request,
            screenCaptures: [],
            fileDrop: movedTarget.seams
        )
        #expect(moved.code == .targetStale)
        #expect(moved.status == .stale)
        #expect(movedTarget.driver.commitCount == 0)
    }

    @Test func ordinaryAxTargetIsRejectedBeforeCommit() async throws {
        #expect(YishuFileDropReadBack.isUploadDropLabel(title: "上传文件", description: "拖放到这里"))
        #expect(YishuFileDropReadBack.isUploadDropLabel(title: "Add attachment", description: nil))
        #expect(!YishuFileDropReadBack.isUploadDropLabel(title: "Send", description: "Primary"))
        let env = try harness(liveFingerprint: ["AXGroup", "Send", "Primary"].joined(separator: "\u{1e}"))
        defer { env.cleanup() }
        let request = dropRequest(fingerprint: ["AXGroup", "Send", "Primary"].joined(separator: "\u{1e}"))
        let result = await YishuComputerUseActuator.perform(request, screenCaptures: [], fileDrop: env.seams)
        #expect(result.code == .targetStale)
        #expect(result.status == .stale)
        #expect(env.driver.commitCount == 0)
        assertNoPath(in: result, downloads: env.downloads)
    }

    @Test func fenceBlocksPhysicalCommit() async throws {
        let env = try harness()
        defer { env.cleanup() }
        let result = await YishuComputerUseActuator.perform(
            env.request,
            screenCaptures: [],
            authorizationFence: { false },
            fileDrop: env.seams
        )
        #expect(result.code == .cancelled)
        #expect(result.status == .cancelled)
        #expect(env.driver.commitCount == 0)
        #expect(env.driver.fenceAtCommit == false)
        assertNoPath(in: result, downloads: env.downloads)
    }

    @Test func readbackPollsUntilBasenameCountIncreases() async throws {
        let env = try harness(baselineTexts: [fileName], readback: [fileName])
        defer { env.cleanup() }
        var remaining = 2
        var seams = env.seams
        seams.attachmentBasenames = {
            if env.driver.commitCount == 0 { return [self.fileName] }
            remaining -= 1
            return remaining <= 0 ? [self.fileName, self.fileName] : [self.fileName]
        }
        seams.readbackBudgetNanoseconds = 400_000_000
        let result = await YishuComputerUseActuator.perform(env.request, screenCaptures: [], fileDrop: seams)
        #expect(result.verified)
        #expect(result.code == .verifiedAccessibility)
        #expect(env.driver.commitCount == 1)
    }

    @Test func existingSameBasenameWithoutCountIncreaseIsNotVerified() async throws {
        let env = try harness(baselineTexts: [fileName], readback: [fileName])
        defer { env.cleanup() }
        let result = await YishuComputerUseActuator.perform(env.request, screenCaptures: [], fileDrop: env.seams)
        #expect(env.driver.commitCount == 1)
        #expect(!result.verified)
        #expect(result.status == .delivered)
        #expect(result.code == .dropUnverified)
        assertNoPath(in: result, downloads: env.downloads)
    }

    @Test func basenameCountIncreaseVerifiesEvenWhenNameAlreadyPresent() async throws {
        let env = try harness(baselineTexts: [fileName], readback: [fileName, fileName])
        defer { env.cleanup() }
        let result = await YishuComputerUseActuator.perform(env.request, screenCaptures: [], fileDrop: env.seams)
        #expect(result.verified)
        #expect(result.code == .verifiedAccessibility)
        #expect(env.driver.commitCount == 1)
    }

    @Test func missingExactBasenameReadbackIsNotVerified() async throws {
        let env = try harness(readback: ["other.txt", "prefix-\(fileName)"])
        defer { env.cleanup() }
        let result = await YishuComputerUseActuator.perform(env.request, screenCaptures: [], fileDrop: env.seams)
        #expect(env.driver.commitCount == 1)
        #expect(!result.verified)
        #expect(result.status == .delivered)
        #expect(result.code == .dropUnverified)
        #expect(result.method == .appkitDrag)
        assertNoPath(in: result, downloads: env.downloads)
    }

    @Test func exactBasenameCountIgnoresPrefixAndRequiresIncrease() {
        #expect(YishuFileDropReadBack.exactBasenameCount(fileName, in: []) == 0)
        #expect(YishuFileDropReadBack.exactBasenameCount(fileName, in: [fileName, "prefix-\(fileName)", fileName]) == 2)
        #expect(YishuFileDropReadBack.exactBasenameCount(fileName, in: ["other.txt"]) == 0)
    }

    private struct Harness {
        let downloads: URL
        let request: YishuComputerActionRequest
        let seams: YishuFileDropSeams
        let driver: YishuRecordingFileDropDriver
        let cleanup: () -> Void
    }

    private func harness(
        createFile: Bool = true,
        windowNumber: Int = 17,
        includeLiveTarget: Bool = true,
        liveFingerprint: String? = nil,
        liveFrame: CGRect? = nil,
        baselineTexts: [String] = [],
        readback: [String] = ["奕枢测试文件.txt"],
        frontmostBundleId: String = "com.apple.Safari"
    ) throws -> Harness {
        let downloads = try makeDownloads()
        if createFile {
            try Data("ok".utf8).write(to: downloads.appendingPathComponent(fileName))
        }
        let driver = YishuRecordingFileDropDriver()
        let source = NSView(frame: NSRect(x: 0, y: 0, width: 100, height: 100))
        let target = liveTarget(fingerprint: liveFingerprint, frame: liveFrame ?? quartzFrame)
        let snapshot = YishuNumberedAccessibility.Snapshot(
            targets: includeLiveTarget ? [target] : [],
            permissionDenied: false
        )
        let seams = YishuFileDropSeams(
            downloadsDirectory: downloads,
            resolver: nil,
            snapshot: { _ in snapshot },
            frontmost: { (pid: 321, bundleId: frontmostBundleId) },
            windowNumber: { _ in windowNumber },
            sourceView: { source },
            primaryDisplayHeight: primaryHeight,
            drag: driver,
            attachmentBasenames: { driver.commitCount == 0 ? baselineTexts : readback }
        )
        return Harness(
            downloads: downloads,
            request: dropRequest(),
            seams: seams,
            driver: driver,
            cleanup: { try? FileManager.default.removeItem(at: downloads) }
        )
    }

    private func dropRequest(fingerprint: String? = nil, bundleId: String? = nil) -> YishuComputerActionRequest {
        YishuComputerActionRequest(
            requestId: UUID(),
            traceId: UUID(),
            actionId: UUID(),
            action: "drop_download_file",
            x: 0,
            y: 0,
            targetId: "1",
            fileName: fileName,
            targetBundleId: bundleId ?? "com.apple.Safari",
            targetPid: 321,
            targetWindowNumber: 17,
            targetFingerprint: fingerprint ?? self.fingerprint,
            intentId: UUID().uuidString,
            attemptId: UUID().uuidString,
            basisFrameId: UUID().uuidString,
            effectClass: "external_disclosure"
        )
    }

    private func liveTarget(
        fingerprint: String? = nil,
        frame: CGRect? = nil
    ) -> NumberedAccessibilityTarget {
        let resolvedFrame = frame ?? quartzFrame
        if let fingerprint {
            let parts = fingerprint.split(separator: "\u{1e}", omittingEmptySubsequences: false).map(String.init)
            return NumberedAccessibilityTarget(
                id: "1",
                role: parts[safe: 0].flatMap { $0.isEmpty ? nil : $0 },
                title: parts[safe: 1].flatMap { $0.isEmpty ? nil : $0 },
                description: parts[safe: 2].flatMap { $0.isEmpty ? nil : $0 },
                enabled: true,
                frame: resolvedFrame
            )
        }
        return NumberedAccessibilityTarget(
            id: "1",
            role: "AXGroup",
            title: "上传文件",
            description: "拖放到这里",
            enabled: true,
            frame: resolvedFrame
        )
    }

    private func staleFallbackTarget() -> NumberedAccessibilityTarget {
        NumberedAccessibilityTarget(
            id: "1",
            role: "AXGroup",
            title: "上传文件",
            description: "拖放到这里",
            enabled: true,
            frame: quartzFrame
        )
    }

    private func makeDownloads() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("yishu-downloads-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func assertNoPath(in result: YishuComputerActionResult, downloads: URL) {
        let haystack = (result.message + (result.evidence ?? "")).lowercased()
        #expect(!haystack.contains(downloads.path.lowercased()))
        #expect(!haystack.contains("file://"))
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
