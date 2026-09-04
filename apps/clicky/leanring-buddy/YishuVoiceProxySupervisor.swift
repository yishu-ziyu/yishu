//
//  YishuVoiceProxySupervisor.swift
//  leanring-buddy
//
//  Owns the local 奕枢 voice proxy on 127.0.0.1:8787 (transcribe / tts / chat).
//  Starts exactly one healthy instance with the app, surfaces real status to
//  the panel, and never logs or packages API secrets.
//

import Combine
import Darwin
import Foundation
import Security

/// Public health snapshot used by the panel and transcription availability.
enum YishuVoiceProxyAvailability: Equatable {
    case starting
    case ready
    case missingBundle
    case missingNode
    case missingCredentials(pathHint: String)
    case portBusy
    case launchFailed(summary: String)
    case unhealthy(summary: String)
    case stopped

    var isReady: Bool {
        if case .ready = self { return true }
        return false
    }

    /// Short status chip for the panel header. Never "在线" unless ready.
    var statusChip: String {
        switch self {
        case .starting:
            return "启动中"
        case .ready:
            return "在线"
        case .missingBundle, .missingNode, .missingCredentials, .portBusy, .launchFailed, .unhealthy:
            return "语音不可用"
        case .stopped:
            return "已停止"
        }
    }

    /// User-visible explanation with a concrete recovery action. No secrets.
    var recoveryMessage: String {
        switch self {
        case .starting:
            return "正在启动本机语音服务…"
        case .ready:
            return "语音服务就绪。"
        case .missingBundle:
            return "这份应用里没有语音服务文件。请完全退出，打开 /Applications/奕枢.app。不要打开临时编译出来的奕枢。"
        case .missingNode:
            return "应用缺少 Node 运行时。请用正式安装包重新安装奕枢。"
        case .missingCredentials(let pathHint):
            return "本机缺少语音密钥配置。把密钥文件放到 \(pathHint) 后点「重试」。不要把密钥提交到仓库。"
        case .portBusy:
            return "本机 8787 端口已被其他进程占用（可能是仍在运行的开发/测试语音服务）。结束后点「重试」。"
        case .launchFailed(let summary):
            return "语音服务启动失败（\(summary)）。点「重试」；若反复失败请重新安装奕枢。"
        case .unhealthy(let summary):
            return "语音服务无响应（\(summary)）。点「重试」恢复。"
        case .stopped:
            return "语音服务已停止。"
        }
    }
}

/// Pure classification for 8787 listeners. Safe for unit tests; no process I/O.
enum YishuVoiceProxyListenerDisposition: Equatable {
    /// Command line is the entry path this app instance would launch.
    case preferred
    /// Confirmed Clicky/Yishu voice proxy whose parent is gone (PPID=1 or dead) — safe to reclaim.
    case reclaimableOrphan
    /// Yishu voice proxy still owned by a live parent (shell worker, other Clicky/dev). Do not kill.
    case liveParentOwned
    /// Port holder is not a Yishu voice proxy.
    case foreign
    /// Empty / unreadable command line.
    case unknown
}

/// Parent liveness facts for reclaim decisions. Pure input — callers gather via `ps`/`kill`.
struct YishuVoiceProxyParentFacts: Equatable {
    /// Process parent PID (from `ps -o ppid=`). Valid only when `parentKnown`.
    var parentPID: Int32
    /// Whether that parent PID currently exists as a live process.
    /// Launchd (1) is always "alive" but still counts as orphan ownership for reclaim.
    var parentIsAlive: Bool
    /// False when PPID could not be read. Fail closed: never reclaim as orphan.
    var parentKnown: Bool

    init(parentPID: Int32, parentIsAlive: Bool, parentKnown: Bool = true) {
        self.parentPID = parentPID
        self.parentIsAlive = parentIsAlive
        self.parentKnown = parentKnown
    }

    /// PPID unreadable / invalid — refuse reclaim and refuse adopt.
    static func unknown() -> YishuVoiceProxyParentFacts {
        YishuVoiceProxyParentFacts(parentPID: 0, parentIsAlive: false, parentKnown: false)
    }

    /// True when the process has been reparented to launchd / init, or the recorded parent is gone.
    /// Unknown PPID and parentPID ≤ 0 never count as orphan (fail closed).
    var isOrphanedFromParent: Bool {
        guard parentKnown else { return false }
        // parentPID 0 is invalid residue, not launchd — never orphan.
        if parentPID <= 0 { return false }
        if parentPID == 1 { return true }
        return !parentIsAlive
    }
}

enum YishuVoiceProxyProcessPolicy {
    /// Marker that appears only on Clicky-bundled or worker voice proxy entrypoints.
    static let voiceProxyMarker = "YishuVoiceProxy/local-server.mjs"
    static let workerEntryMarker = "apps/clicky/worker/local-server.mjs"

    /// True when `commandLine` is a known 奕枢 voice proxy process (not arbitrary Node).
    static func isYishuVoiceProxyCommandLine(_ commandLine: String) -> Bool {
        let line = commandLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return false }
        if line.contains(voiceProxyMarker) { return true }
        if line.contains(workerEntryMarker) { return true }
        return false
    }

    /// Extract the `local-server.mjs` path from a process command line when present.
    static func entryPath(fromCommandLine commandLine: String) -> String? {
        let parts = commandLine.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        return parts.first(where: {
            $0.hasSuffix("/local-server.mjs") || $0.hasSuffix("local-server.mjs")
        })
    }

    /// Path-only match: is this the entry this app instance would launch?
    static func isPreferredEntry(
        commandLine: String,
        preferredEntryPath: String?
    ) -> Bool {
        let trimmed = commandLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let preferredEntryPath, !preferredEntryPath.isEmpty else {
            return false
        }
        let preferred = URL(fileURLWithPath: preferredEntryPath).standardizedFileURL.path
        if let entry = entryPath(fromCommandLine: trimmed) {
            let actual = URL(fileURLWithPath: entry).standardizedFileURL.path
            if actual == preferred { return true }
        }
        return trimmed.contains(preferred)
    }

    /// Classify a 8787 listener.
    ///
    /// Ownership rules (Codex rework):
    /// - Preferred path alone does **not** mean this app instance owns the listener.
    /// - Manage (`.preferred`) only when parent PID is the current process, or parent facts
    ///   are omitted (path-only classification for pure tests — still not safe to reclaim).
    /// - Preferred path owned by another live parent → `.liveParentOwned` (portBusy, no adopt/kill).
    /// - Preferred path that is a true orphan → `.reclaimableOrphan`.
    /// - Unknown PPID (`parentKnown == false`) → fail closed as `.liveParentOwned` (no kill).
    /// - Non-preferred Yishu: reclaim only when parent facts prove orphanhood.
    /// Path strings alone never authorize kill.
    static func disposition(
        commandLine: String,
        preferredEntryPath: String?,
        parent: YishuVoiceProxyParentFacts? = nil,
        currentProcessPID: Int32 = ProcessInfo.processInfo.processIdentifier
    ) -> YishuVoiceProxyListenerDisposition {
        let trimmed = commandLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .unknown }
        guard isYishuVoiceProxyCommandLine(trimmed) else { return .foreign }

        let preferred = isPreferredEntry(commandLine: trimmed, preferredEntryPath: preferredEntryPath)

        if let parent, !parent.parentKnown {
            // PPID unreadable: never adopt, never reclaim.
            return .liveParentOwned
        }

        if preferred {
            if let parent {
                if parent.isOrphanedFromParent {
                    // Dead/launchd parent on preferred path — reclaim, do not adopt as owned.
                    return .reclaimableOrphan
                }
                if parent.parentPID == currentProcessPID {
                    return .preferred
                }
                // Another live Clicky/shell owns this preferred-path proxy.
                return .liveParentOwned
            }
            // Path-only match (unit tests without parent facts). Not safe to reclaim.
            return .preferred
        }

        // Non-preferred Yishu proxy: kill only true orphans (PPID==1 or dead parent).
        if let parent, parent.isOrphanedFromParent {
            return .reclaimableOrphan
        }
        // Live parent, or missing parent facts → preserve (shell worker / other Clicky).
        return .liveParentOwned
    }

    /// Whether terminate is allowed for this classified listener.
    static func isSafeToReclaim(_ disposition: YishuVoiceProxyListenerDisposition) -> Bool {
        disposition == .reclaimableOrphan
    }

    /// Whether this app may adopt/stop the listener as its session proxy.
    /// Preferred path alone is not enough — parent must be this process.
    static func isOwnedByCurrentProcess(
        disposition: YishuVoiceProxyListenerDisposition,
        parent: YishuVoiceProxyParentFacts?,
        currentProcessPID: Int32 = ProcessInfo.processInfo.processIdentifier
    ) -> Bool {
        guard disposition == .preferred else { return false }
        guard let parent, parent.parentKnown else { return false }
        return parent.parentPID == currentProcessPID
    }

    /// Daily product install. Scratch / DerivedData / orb builds are never this path.
    static let formalAppBundlePath = "/Applications/奕枢.app"

    static func isFormalAppBundlePath(_ path: String) -> Bool {
        URL(fileURLWithPath: path).standardizedFileURL.path == formalAppBundlePath
    }

    /// Paths under DerivedData / repo `.build` / local scratch are never the formal install.
    static func looksLikeBuildProductPath(_ path: String) -> Bool {
        path.contains("/.build/")
            || path.contains("/DerivedData/")
            || path.contains("/clicky-derived-data/")
            || path.contains("/.jcode/")
    }

    static let nonFormalInstallWarning =
        "当前打开的不是应用程序文件夹里的正式奕枢。请完全退出这个，再打开 /Applications/奕枢.app。"
}

@MainActor
final class YishuVoiceProxySupervisor: ObservableObject {
    static let shared = YishuVoiceProxySupervisor()

    static let defaultHost = "127.0.0.1"
    static let defaultPort = 8787
    static let healthURL = URL(string: "http://127.0.0.1:8787/health")!

    /// Per-App-process loopback capability. It is passed only through child
    /// environment and request headers; never persisted or logged.
    nonisolated private static let proxyToken = {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        precondition(status == errSecSuccess, "Unable to create voice proxy capability")
        return Data(bytes).base64EncodedString()
    }()

    nonisolated static func authorize(_ request: inout URLRequest) {
        request.setValue("Bearer \(proxyToken)", forHTTPHeaderField: "Authorization")
    }

    nonisolated static func authorizeChildEnvironment(_ environment: inout [String: String]) {
        environment["YISHU_VOICE_PROXY_TOKEN"] = proxyToken
    }

    /// Thread-safe snapshot for sync callers (e.g. `isConfigured`) off the main actor.
    nonisolated private static let readySnapshotLock = NSLock()
    nonisolated(unsafe) private static var _readySnapshot = false
    nonisolated private static let recoverySnapshotLock = NSLock()
    nonisolated(unsafe) private static var _recoverySnapshot = "语音服务尚未就绪。"

    nonisolated static var isReadySnapshot: Bool {
        readySnapshotLock.lock()
        defer { readySnapshotLock.unlock() }
        return _readySnapshot
    }

    nonisolated static var recoverySnapshot: String {
        recoverySnapshotLock.lock()
        defer { recoverySnapshotLock.unlock() }
        return _recoverySnapshot
    }

    nonisolated private static func publishSnapshots(ready: Bool, recovery: String) {
        readySnapshotLock.lock()
        _readySnapshot = ready
        readySnapshotLock.unlock()
        recoverySnapshotLock.lock()
        _recoverySnapshot = recovery
        recoverySnapshotLock.unlock()
    }

    @Published private(set) var availability: YishuVoiceProxyAvailability = .stopped {
        didSet {
            Self.publishSnapshots(
                ready: availability.isReady,
                recovery: availability.recoveryMessage
            )
        }
    }
    @Published private(set) var lastCheckedAt: Date?

    private var process: Process?
    private var errorPipe: Pipe?
    private var outputPipe: Pipe?
    private var healthPollTask: Task<Void, Never>?
    private var ownsRunningProcess = false
    /// Listener PID adopted when a preferred-path proxy was already healthy (no Process handle).
    private var adoptedListenerPID: Int32?
    private var isEnsuring = false
    private var automaticRestartAttempts: [Date] = []

    private let fileManager: FileManager
    private let session: URLSession

    init(
        fileManager: FileManager = .default,
        session: URLSession = YishuLoopbackSession.make()
    ) {
        self.fileManager = fileManager
        self.session = session
        Self.publishSnapshots(
            ready: false,
            recovery: YishuVoiceProxyAvailability.stopped.recoveryMessage
        )
    }

    deinit {
        healthPollTask?.cancel()
    }

    /// Unit tests and XCTest host must never start a real 8787 listener.
    ///
    /// Swift Testing / app-hosted XCTest can omit some XCTest* env keys while
    /// still launching the full Clicky host. Detect all known test seams so
    /// `xcodebuild test` cannot leave a `.build` / DerivedData VoiceProxy orphan
    /// on 8787 after the host is torn down.
    nonisolated static var shouldSkipRealProxyLifecycle: Bool {
        let env = ProcessInfo.processInfo.environment
        if env["YISHU_VOICE_PROXY_DISABLE"] == "1" { return true }
        if env["XCTestConfigurationFilePath"] != nil { return true }
        if env["XCTestBundlePath"] != nil { return true }
        if env["XCTestSessionIdentifier"] != nil { return true }
        if env["XCTestBundleInjection"] != nil { return true }
        // XCTest framework linked into the process (app-hosted unit tests).
        if NSClassFromString("XCTestCase") != nil { return true }
        if NSClassFromString("XCTestConfiguration") != nil { return true }
        // Process / argv markers used by xcodebuild test runners.
        let processName = ProcessInfo.processInfo.processName.lowercased()
        if processName.contains("xctest") { return true }
        for arg in ProcessInfo.processInfo.arguments {
            let lower = arg.lowercased()
            if lower.contains("xctest") || lower.hasSuffix(".xctest") {
                return true
            }
        }
        // Bundle path under test products is never the formal install lifecycle.
        let bundlePath = Bundle.main.bundlePath
        if bundlePath.contains("/PlugIns/") && bundlePath.contains(".xctest") {
            return true
        }
        return false
    }

    /// Canonical secrets file for the installed app. Never inside the app bundle.
    nonisolated static func preferredCredentialsURL(fileManager: FileManager = .default) -> URL {
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support
            .appendingPathComponent("Yishu", isDirectory: true)
            .appendingPathComponent("Worker", isDirectory: true)
            .appendingPathComponent(".dev.vars", isDirectory: false)
    }

    /// Resolve the env file path without reading or logging its contents.
    func resolveCredentialsURL() -> URL? {
        let environment = ProcessInfo.processInfo.environment
        if let configured = environment["YISHU_WORKER_ENV_FILE"], !configured.isEmpty {
            if fileManager.fileExists(atPath: configured) {
                return URL(fileURLWithPath: configured)
            }
        }

        let preferred = Self.preferredCredentialsURL(fileManager: fileManager)
        if fileManager.fileExists(atPath: preferred.path) {
            return preferred
        }

        // Development-only fallbacks when running a local tree build.
        if let runtimeRoot = environment["YISHU_RUNTIME_ROOT"], !runtimeRoot.isEmpty {
            let candidate = URL(fileURLWithPath: runtimeRoot)
                .appendingPathComponent("apps/clicky/worker/.dev.vars")
            if fileManager.fileExists(atPath: candidate.path) {
                return candidate
            }
        }

        return nil
    }

    func ensureStarted() async {
        guard !isEnsuring else { return }
        isEnsuring = true
        defer { isEnsuring = false }

        if Self.shouldSkipRealProxyLifecycle {
            availability = .stopped
            return
        }

        if case .ready = availability, await hasUsablePreferredListener() {
            startHealthPollingIfNeeded()
            return
        }

        availability = .starting
        lastCheckedAt = Date()

        // Always inspect who holds 8787 before adopting health==200.
        // Debug/test orphans (`.build` / DerivedData) must not look like formal ready.
        let reclaimResult = reclaimForeignYishuListenersIfNeeded()
        if reclaimResult == .foreignBusy {
            availability = .portBusy
            startHealthPollingIfNeeded()
            return
        }

        let probe = await probeHealth()
        if probe.isReady, await hasUsablePreferredListener() {
            if process?.isRunning != true {
                ownsRunningProcess = false
            }
            availability = .ready
            startHealthPollingIfNeeded()
            return
        }

        if probe.portOpen && !probe.isReady {
            // Still occupied after reclaim attempt — not our healthy proxy.
            availability = .portBusy
            startHealthPollingIfNeeded()
            return
        }

        if probe.isReady {
            // Healthy but not preferred: only orphans are reclaimed above.
            // If a live foreign/other-Yishu still holds the port, surface busy — never kill it.
            availability = .portBusy
            startHealthPollingIfNeeded()
            return
        }

        do {
            try launchProcess()
        } catch let error as LaunchError {
            availability = error.availability
            startHealthPollingIfNeeded()
            return
        } catch {
            availability = .launchFailed(summary: "无法启动进程")
            startHealthPollingIfNeeded()
            return
        }

        // Wait for health after spawn.
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            let health = await probeHealth()
            if health.isReady {
                availability = .ready
                startHealthPollingIfNeeded()
                return
            }
            if !(process?.isRunning ?? false) {
                availability = .launchFailed(summary: "进程立刻退出")
                clearProcessHandles()
                startHealthPollingIfNeeded()
                return
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }

        if await probeHealth().isReady {
            availability = .ready
        } else {
            availability = .unhealthy(summary: "启动超时")
        }
        startHealthPollingIfNeeded()
    }

    func retry() {
        Task { @MainActor in
            automaticRestartAttempts.removeAll()
            stopOwnedProcess()
            // Brief pause so the port releases before relaunch.
            try? await Task.sleep(nanoseconds: 300_000_000)
            await ensureStarted()
        }
    }

    func stop() {
        healthPollTask?.cancel()
        healthPollTask = nil
        stopOwnedProcess()
        // Extra safety: after owned/adopted stop, only reclaim true orphans (PPID≤1).
        _ = reclaimForeignYishuListenersIfNeeded()
        availability = .stopped
    }

    // MARK: - Health

    struct HealthProbe: Equatable {
        var portOpen: Bool
        var isReady: Bool
        var serviceName: String?
        var asrConfigured: Bool
        var ttsConfigured: Bool
    }

    func probeHealth() async -> HealthProbe {
        lastCheckedAt = Date()
        var request = URLRequest(url: Self.healthURL)
        request.httpMethod = "GET"
        Self.authorize(&request)
        request.timeoutInterval = 1.2
        request.cachePolicy = .reloadIgnoringLocalCacheData

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return HealthProbe(
                    portOpen: true,
                    isReady: false,
                    serviceName: nil,
                    asrConfigured: false,
                    ttsConfigured: false
                )
            }
            let payload = try JSONDecoder().decode(HealthPayload.self, from: data)
            let serviceOK = payload.service == "yishu-proxy-local" && payload.ok == true
            let asrOK = payload.asr?.configured == true
            let ttsOK = payload.tts?.configured == true
            // Voice path needs ASR + TTS. Chat may use a separate path.
            let ready = serviceOK && asrOK && ttsOK
            return HealthProbe(
                portOpen: true,
                isReady: ready,
                serviceName: payload.service,
                asrConfigured: asrOK,
                ttsConfigured: ttsOK
            )
        } catch {
            return HealthProbe(
                portOpen: false,
                isReady: false,
                serviceName: nil,
                asrConfigured: false,
                ttsConfigured: false
            )
        }
    }

    // MARK: - Launch

    private enum LaunchError: Error {
        case missingBundle
        case missingNode
        case missingCredentials(String)
        case spawnFailed

        var availability: YishuVoiceProxyAvailability {
            switch self {
            case .missingBundle: return .missingBundle
            case .missingNode: return .missingNode
            case .missingCredentials(let path): return .missingCredentials(pathHint: path)
            case .spawnFailed: return .launchFailed(summary: "进程启动失败")
            }
        }
    }

    private func launchProcess() throws {
        stopOwnedProcess()

        guard let entry = resolveEntryURL() else {
            throw LaunchError.missingBundle
        }
        guard let node = resolveNodeURL() else {
            throw LaunchError.missingNode
        }
        guard let credentials = resolveCredentialsURL() else {
            let hint = Self.preferredCredentialsURL(fileManager: fileManager).path
            throw LaunchError.missingCredentials(hint)
        }
        try fileManager.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: credentials.path
        )

        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()

        process.executableURL = node
        process.arguments = [entry.path]
        process.currentDirectoryURL = entry.deletingLastPathComponent()

        let parentEnvironment = ProcessInfo.processInfo.environment
        var environment = Self.minimumChildEnvironment(from: parentEnvironment)
        environment["YISHU_WORKER_ENV_FILE"] = credentials.path
        Self.authorizeChildEnvironment(&environment)
        environment["PORT"] = String(Self.defaultPort)
        environment["HOST"] = Self.defaultHost
        environment["NO_COLOR"] = "1"
        // Never inject secret values into the environment map from Swift.
        process.environment = environment
        process.standardOutput = stdout
        process.standardError = stderr

        // Drain pipes so the child never blocks; do not mirror to Console
        // because stdout can mention which keys are set (already boolean-only).
        stdout.fileHandleForReading.readabilityHandler = { handle in
            _ = handle.availableData
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in
            _ = handle.availableData
        }

        process.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.clearProcessHandles()
                if self.availability.isReady || self.availability == .starting {
                    self.availability = .unhealthy(summary: "进程退出")
                }
            }
        }

        do {
            try process.run()
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            throw LaunchError.spawnFailed
        }

        self.process = process
        self.outputPipe = stdout
        self.errorPipe = stderr
        self.ownsRunningProcess = true
    }

    /// Child processes receive only execution plumbing and explicit Yishu
    /// configuration. Provider credentials stay in the canonical env file.
    nonisolated static func minimumChildEnvironment(
        from parent: [String: String]
    ) -> [String: String] {
        let allowed = [
            "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
        ]
        var result: [String: String] = [:]
        for key in allowed {
            if let value = parent[key], !value.isEmpty {
                result[key] = value
            }
        }
        return result
    }

    private func resolveEntryURL() -> URL? {
        let environment = ProcessInfo.processInfo.environment
        var candidates: [URL] = []

        if let configured = environment["YISHU_VOICE_PROXY_ENTRY"], !configured.isEmpty {
            candidates.append(URL(fileURLWithPath: configured))
        }
        if let resources = Bundle.main.resourceURL {
            candidates.append(
                resources.appendingPathComponent("YishuVoiceProxy/local-server.mjs")
            )
        }
        if let runtimeRoot = environment["YISHU_RUNTIME_ROOT"], !runtimeRoot.isEmpty {
            candidates.append(
                URL(fileURLWithPath: runtimeRoot)
                    .appendingPathComponent("apps/clicky/worker/local-server.mjs")
            )
        }

        return candidates.first(where: { fileManager.fileExists(atPath: $0.path) })
    }

    private func resolveNodeURL() -> URL? {
        let environment = ProcessInfo.processInfo.environment
        let candidates = [
            environment["YISHU_NODE_EXECUTABLE"],
            Bundle.main.resourceURL?
                .appendingPathComponent("YishuRuntime/bin/node")
                .path,
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
        ].compactMap { $0 }.filter { !$0.isEmpty }

        return candidates
            .first(where: { fileManager.isExecutableFile(atPath: $0) })
            .map { URL(fileURLWithPath: $0) }
    }

    private enum ReclaimResult {
        case free
        case preferredReady
        case foreignBusy
    }

    /// Preferred path means this app's resolved entry (bundle Resources or explicit env).
    private func preferredEntryPathString() -> String? {
        resolveEntryURL()?.standardizedFileURL.path
    }

    private func hasUsablePreferredListener() async -> Bool {
        guard await probeHealth().isReady else { return false }
        if process?.isRunning == true, ownsRunningProcess {
            return true
        }
        let preferred = preferredEntryPathString()
        let selfPID = ProcessInfo.processInfo.processIdentifier
        let listeners = Self.listPort8787Listeners()
        for listener in listeners {
            let disposition = YishuVoiceProxyProcessPolicy.disposition(
                commandLine: listener.commandLine,
                preferredEntryPath: preferred,
                parent: listener.parentFacts,
                currentProcessPID: selfPID
            )
            // Adopt only when parent is this Clicky process — preferred path alone is not ownership.
            if YishuVoiceProxyProcessPolicy.isOwnedByCurrentProcess(
                disposition: disposition,
                parent: listener.parentFacts,
                currentProcessPID: selfPID
            ) {
                adoptedListenerPID = listener.pid
                return true
            }
        }
        // Owned process may still be starting and not yet listed; allow only when we own it.
        return false
    }

    @discardableResult
    private func reclaimForeignYishuListenersIfNeeded() -> ReclaimResult {
        let preferred = preferredEntryPathString()
        let selfPID = ProcessInfo.processInfo.processIdentifier
        let listeners = Self.listPort8787Listeners()
        if listeners.isEmpty {
            return .free
        }

        var sawPreferredOwned = false
        var sawBusy = false
        var killedAny = false

        for listener in listeners {
            let disposition = YishuVoiceProxyProcessPolicy.disposition(
                commandLine: listener.commandLine,
                preferredEntryPath: preferred,
                parent: listener.parentFacts,
                currentProcessPID: selfPID
            )
            switch disposition {
            case .preferred:
                // Only adopt when this process is the parent.
                if YishuVoiceProxyProcessPolicy.isOwnedByCurrentProcess(
                    disposition: disposition,
                    parent: listener.parentFacts,
                    currentProcessPID: selfPID
                ) {
                    sawPreferredOwned = true
                    adoptedListenerPID = listener.pid
                } else {
                    // Preferred path without proven ownership → treat as busy.
                    sawBusy = true
                }
            case .reclaimableOrphan:
                // Only true orphans (PPID==1 or dead parent). Path alone never kills.
                if Self.terminatePID(listener.pid, requireOrphanProof: true) {
                    killedAny = true
                }
            case .liveParentOwned:
                // Active shell worker / other Clicky tree — preserve; port stays busy.
                sawBusy = true
            case .foreign, .unknown:
                // Unknown or non-Yishu holder: never kill.
                sawBusy = true
            }
        }

        if killedAny {
            // Wait briefly for the kernel to release the port.
            let deadline = Date().addingTimeInterval(1.5)
            while Date() < deadline {
                if Self.listPort8787Listeners().isEmpty {
                    break
                }
                Thread.sleep(forTimeInterval: 0.05)
            }
        }

        if sawBusy, !Self.listPort8787Listeners().isEmpty {
            let remaining = Self.listPort8787Listeners()
            let stillBlocking = remaining.contains { listener in
                let d = YishuVoiceProxyProcessPolicy.disposition(
                    commandLine: listener.commandLine,
                    preferredEntryPath: preferred,
                    parent: listener.parentFacts,
                    currentProcessPID: selfPID
                )
                switch d {
                case .foreign, .unknown, .liveParentOwned:
                    return true
                case .preferred:
                    // Preferred but not owned by us still blocks the port.
                    return !YishuVoiceProxyProcessPolicy.isOwnedByCurrentProcess(
                        disposition: d,
                        parent: listener.parentFacts,
                        currentProcessPID: selfPID
                    )
                case .reclaimableOrphan:
                    return false
                }
            }
            if stillBlocking {
                return .foreignBusy
            }
        }

        if sawPreferredOwned {
            return .preferredReady
        }
        return .free
    }

    private struct PortListener: Equatable {
        var pid: Int32
        var commandLine: String
        var parentFacts: YishuVoiceProxyParentFacts
    }

    /// Read-only: PIDs listening on 127.0.0.1:8787 with command lines and parent facts.
    nonisolated private static func listPort8787Listeners() -> [PortListener] {
        let lsof = Process()
        lsof.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        lsof.arguments = ["-nP", "-iTCP:8787", "-sTCP:LISTEN", "-Fpc"]
        let out = Pipe()
        lsof.standardOutput = out
        lsof.standardError = Pipe()
        do {
            try lsof.run()
        } catch {
            return []
        }
        lsof.waitUntilExit()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        guard let text = String(data: data, encoding: .utf8), !text.isEmpty else {
            return []
        }

        var pids: [Int32] = []
        for line in text.split(separator: "\n") {
            if line.hasPrefix("p"), let value = Int32(line.dropFirst()) {
                pids.append(value)
            }
        }

        var result: [PortListener] = []
        for pid in Set(pids) {
            let commandLine = commandLine(forPID: pid)
            let parentFacts = parentFacts(forPID: pid)
            result.append(
                PortListener(pid: pid, commandLine: commandLine, parentFacts: parentFacts)
            )
        }
        return result.sorted { $0.pid < $1.pid }
    }

    nonisolated private static func commandLine(forPID pid: Int32) -> String {
        let ps = Process()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-p", String(pid), "-o", "args="]
        let out = Pipe()
        ps.standardOutput = out
        ps.standardError = Pipe()
        do {
            try ps.run()
        } catch {
            return ""
        }
        ps.waitUntilExit()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// Parent PID + liveness for reclaim policy. Pure facts; no kill of the child.
    /// On read failure returns `.unknown()` — fail closed (never orphan via parentPID=0).
    nonisolated private static func parentFacts(forPID pid: Int32) -> YishuVoiceProxyParentFacts {
        let ps = Process()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-p", String(pid), "-o", "ppid="]
        let out = Pipe()
        ps.standardOutput = out
        ps.standardError = Pipe()
        do {
            try ps.run()
        } catch {
            // Cannot read parent → unknown. Never map to parentPID=0 orphan.
            return .unknown()
        }
        ps.waitUntilExit()
        if ps.terminationStatus != 0 {
            // ps failed (process may have exited). If child is also gone, reclaim is a no-op
            // at terminate time. If child still lives, refuse orphan classification.
            if kill(pid, 0) != 0 {
                // Child gone — report as orphaned so empty cleanup paths stay simple.
                return YishuVoiceProxyParentFacts(parentPID: 1, parentIsAlive: false, parentKnown: true)
            }
            return .unknown()
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        let text = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let ppid = Int32(text), ppid > 0 else {
            // Empty/unparseable PPID while process may still live → fail closed.
            if kill(pid, 0) != 0 {
                return YishuVoiceProxyParentFacts(parentPID: 1, parentIsAlive: false, parentKnown: true)
            }
            return .unknown()
        }
        if ppid == 1 {
            return YishuVoiceProxyParentFacts(parentPID: 1, parentIsAlive: true, parentKnown: true)
        }
        let alive = kill(ppid, 0) == 0
        return YishuVoiceProxyParentFacts(parentPID: ppid, parentIsAlive: alive, parentKnown: true)
    }

    /// Terminate only a PID already classified as a true orphan Yishu voice proxy.
    /// Re-checks command line **and** parent orphanhood immediately before signal.
    nonisolated private static func terminatePID(
        _ pid: Int32,
        requireOrphanProof: Bool = true
    ) -> Bool {
        guard pid > 1 else { return false }
        // Re-check command line immediately before signal (TOCTOU narrow window).
        let commandLine = commandLine(forPID: pid)
        guard YishuVoiceProxyProcessPolicy.isYishuVoiceProxyCommandLine(commandLine) else {
            return false
        }
        if requireOrphanProof {
            let facts = parentFacts(forPID: pid)
            // Live parent → refuse. Path markers alone are never enough.
            if !facts.isOrphanedFromParent {
                return false
            }
        }
        let result = kill(pid, SIGTERM)
        if result != 0 {
            return false
        }
        let deadline = Date().addingTimeInterval(1.2)
        while Date() < deadline {
            if kill(pid, 0) != 0 {
                return true
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        if kill(pid, 0) == 0 {
            _ = kill(pid, SIGKILL)
        }
        return true
    }

    private func stopOwnedProcess() {
        let selfPID = ProcessInfo.processInfo.processIdentifier
        if ownsRunningProcess, let process {
            if process.isRunning {
                process.terminationHandler = nil
                process.terminate()
                // Give it a moment; avoid kill -9 unless still running.
                let deadline = Date().addingTimeInterval(1.5)
                while process.isRunning && Date() < deadline {
                    Thread.sleep(forTimeInterval: 0.05)
                }
                if process.isRunning {
                    process.interrupt()
                }
            }
        } else if let adopted = adoptedListenerPID {
            // Only set when parent was this process at adopt time. Re-check before kill.
            let facts = Self.parentFacts(forPID: adopted)
            if facts.parentKnown, facts.parentPID == selfPID || facts.isOrphanedFromParent {
                _ = Self.terminateOwnedPreferredPID(adopted)
            }
            // Else: another parent owns it — leave alone.
        } else {
            // Best-effort: only kill proxies this process owns, or true orphans.
            // Never kill preferred path owned by another live Clicky.
            let preferred = preferredEntryPathString()
            for listener in Self.listPort8787Listeners() {
                let disposition = YishuVoiceProxyProcessPolicy.disposition(
                    commandLine: listener.commandLine,
                    preferredEntryPath: preferred,
                    parent: listener.parentFacts,
                    currentProcessPID: selfPID
                )
                switch disposition {
                case .preferred:
                    if YishuVoiceProxyProcessPolicy.isOwnedByCurrentProcess(
                        disposition: disposition,
                        parent: listener.parentFacts,
                        currentProcessPID: selfPID
                    ) {
                        _ = Self.terminateOwnedPreferredPID(listener.pid)
                    }
                case .reclaimableOrphan:
                    _ = Self.terminatePID(listener.pid, requireOrphanProof: true)
                case .liveParentOwned, .foreign, .unknown:
                    break
                }
            }
        }
        clearProcessHandles()
    }

    /// Stop preferred-path proxy this app adopted/owns. Bypasses orphan-only gate
    /// only after command-line re-check; caller must already prove ownership.
    nonisolated private static func terminateOwnedPreferredPID(_ pid: Int32) -> Bool {
        guard pid > 1 else { return false }
        let commandLine = commandLine(forPID: pid)
        guard YishuVoiceProxyProcessPolicy.isYishuVoiceProxyCommandLine(commandLine) else {
            return false
        }
        let result = kill(pid, SIGTERM)
        if result != 0 {
            return false
        }
        let deadline = Date().addingTimeInterval(1.2)
        while Date() < deadline {
            if kill(pid, 0) != 0 {
                return true
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        if kill(pid, 0) == 0 {
            _ = kill(pid, SIGKILL)
        }
        return true
    }

    private func clearProcessHandles() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        errorPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        errorPipe = nil
        process = nil
        ownsRunningProcess = false
        adoptedListenerPID = nil
    }

    private func startHealthPollingIfNeeded() {
        healthPollTask?.cancel()
        healthPollTask = Task { @MainActor [weak self] in
            while let self, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard !Task.isCancelled else { return }
                let health = await self.probeHealth()
                if health.isReady {
                    if !self.availability.isReady {
                        // Do not flip to ready if only a foreign/orphan path answers.
                        if await self.hasUsablePreferredListener()
                            || (self.ownsRunningProcess && self.process?.isRunning == true)
                        {
                            self.availability = .ready
                        }
                    }
                } else if self.availability.isReady {
                    if health.portOpen {
                        self.availability = .unhealthy(summary: "健康检查失败")
                    } else if self.ownsRunningProcess, self.process?.isRunning != true {
                        self.availability = .unhealthy(summary: "进程退出")
                        self.clearProcessHandles()
                    } else {
                        self.availability = .unhealthy(summary: "连接失败")
                    }
                }
                if !health.portOpen,
                   !self.availability.isReady,
                   await self.shouldAttemptAutomaticRestart()
                {
                    await self.ensureStarted()
                    if !self.availability.isReady {
                        self.startHealthPollingIfNeeded()
                    }
                    return
                }
            }
        }
    }

    private func shouldAttemptAutomaticRestart() async -> Bool {
        let now = Date()
        automaticRestartAttempts.removeAll {
            now.timeIntervalSince($0) > 60
        }
        guard automaticRestartAttempts.count < 3 else {
            availability = .unhealthy(summary: "连续退出，请手动重试")
            return false
        }
        let delay = min(pow(2, Double(automaticRestartAttempts.count)) * 0.4, 2.0)
        automaticRestartAttempts.append(now)
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        return !Task.isCancelled
    }
}

// MARK: - Health JSON (no secret fields)

private struct HealthPayload: Decodable {
    let ok: Bool?
    let service: String?
    let asr: ConfiguredFlag?
    let tts: ConfiguredFlag?

    struct ConfiguredFlag: Decodable {
        let configured: Bool?
    }
}
