import Foundation
import YishuContext

enum RuntimeClientEvent {
    case ready(mode: String)
    case turnStarted(requestId: UUID)
    case responseDelta(requestId: UUID, text: String)
    case responseCompleted(requestId: UUID, text: String, verified: Bool)
    case toolStarted(requestId: UUID, name: String)
    case toolCompleted(requestId: UUID, name: String, isError: Bool)
    case turnCancelled(requestId: UUID)
    case failed(requestId: UUID?, message: String)
    case stopped(exitCode: Int32)
}

enum RuntimeClientError: LocalizedError {
    case runtimeEntryMissing
    case nodeExecutableMissing
    case launchFailed(String)
    case runtimeNotRunning

    var errorDescription: String? {
        switch self {
        case .runtimeEntryMissing: return "找不到奕枢 Runtime。"
        case .nodeExecutableMissing: return "找不到 Node.js 22.19 或更高版本。"
        case let .launchFailed(message): return "Runtime 启动失败：\(message)"
        case .runtimeNotRunning: return "奕枢 Runtime 尚未运行。"
        }
    }
}

@MainActor
final class YishuRuntimeClient {
    var onEvent: ((RuntimeClientEvent) -> Void)?

    private var process: Process?
    private var inputHandle: FileHandle?
    private var outputHandle: FileHandle?
    private var errorHandle: FileHandle?
    private var outputBuffer = Data()
    private var stopping = false

    var isRunning: Bool { process?.isRunning == true }

    func start() throws {
        guard process == nil else { return }
        let configuration = try resolveConfiguration()
        let runtimeProcess = Process()
        let inputPipe = Pipe()
        let outputPipe = Pipe()
        let errorPipe = Pipe()

        runtimeProcess.executableURL = configuration.nodeExecutable
        runtimeProcess.arguments = [configuration.runtimeEntry.path]
        runtimeProcess.currentDirectoryURL = configuration.workingDirectory
        var environment = ProcessInfo.processInfo.environment
        environment["YISHU_RUNTIME_MODE"] = configuration.mode
        environment["NO_COLOR"] = "1"
        runtimeProcess.environment = environment
        runtimeProcess.standardInput = inputPipe
        runtimeProcess.standardOutput = outputPipe
        runtimeProcess.standardError = errorPipe

        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor in self?.ingest(data) }
        }

        // Deliberately do not mirror stderr. Provider output can contain paths or
        // request fragments; the structured protocol is the sole UI event source.
        errorPipe.fileHandleForReading.readabilityHandler = { handle in
            _ = handle.availableData
        }

        runtimeProcess.terminationHandler = { [weak self] terminatedProcess in
            Task { @MainActor in
                guard let self else { return }
                let wasStopping = self.stopping
                self.resetProcessReferences()
                if !wasStopping {
                    self.onEvent?(.stopped(exitCode: terminatedProcess.terminationStatus))
                }
            }
        }

        do {
            try runtimeProcess.run()
        } catch {
            outputPipe.fileHandleForReading.readabilityHandler = nil
            errorPipe.fileHandleForReading.readabilityHandler = nil
            throw RuntimeClientError.launchFailed(error.localizedDescription)
        }

        stopping = false
        process = runtimeProcess
        inputHandle = inputPipe.fileHandleForWriting
        outputHandle = outputPipe.fileHandleForReading
        errorHandle = errorPipe.fileHandleForReading
    }

    @discardableResult
    func startTurn(
        utterance: String,
        contextFrame: ContextFrame,
        capabilityProfile: String = "conversation"
    ) throws -> UUID {
        let requestId = UUID()
        let command = TurnStartCommand(
            schemaVersion: yishuProtocolVersion,
            type: "turn.start",
            requestId: requestId,
            traceId: UUID(),
            sentAt: Date(),
            payload: TurnStartPayload(
                utterance: utterance,
                contextFrame: contextFrame,
                capabilityProfile: capabilityProfile
            )
        )
        try send(command)
        return requestId
    }

    func cancelTurn(requestId: UUID, reason: String = "user-interrupted") throws {
        let command = TurnCancelCommand(
            schemaVersion: yishuProtocolVersion,
            type: "turn.cancel",
            requestId: requestId,
            traceId: UUID(),
            sentAt: Date(),
            payload: TurnCancelPayload(reason: reason)
        )
        try send(command)
    }

    func stop() {
        stopping = true
        inputHandle?.closeFile()
        inputHandle = nil
        if let process, process.isRunning {
            process.terminate()
        } else {
            resetProcessReferences()
        }
    }

    private func send<Command: Encodable>(_ command: Command) throws {
        guard let inputHandle, process?.isRunning == true else {
            throw RuntimeClientError.runtimeNotRunning
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        var data = try encoder.encode(command)
        data.append(0x0A)
        try inputHandle.write(contentsOf: data)
    }

    private func ingest(_ data: Data) {
        outputBuffer.append(data)
        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            let line = outputBuffer[..<newline]
            outputBuffer.removeSubrange(...newline)
            guard !line.isEmpty,
                  let object = try? JSONSerialization.jsonObject(with: Data(line)),
                  let dictionary = object as? [String: Any],
                  let event = Self.parseEvent(dictionary) else {
                continue
            }
            Task { @MainActor [weak self] in self?.onEvent?(event) }
        }
    }

    private nonisolated static func parseEvent(_ raw: [String: Any]) -> RuntimeClientEvent? {
        guard let type = raw["type"] as? String else { return nil }
        let requestId = (raw["requestId"] as? String).flatMap(UUID.init(uuidString:))
        let payload = raw["payload"] as? [String: Any] ?? [:]

        switch type {
        case "runtime.ready":
            return .ready(mode: payload["mode"] as? String ?? "unknown")
        case "turn.started":
            guard let requestId else { return nil }
            return .turnStarted(requestId: requestId)
        case "response.delta":
            guard let requestId, let text = payload["text"] as? String else { return nil }
            return .responseDelta(requestId: requestId, text: text)
        case "response.completed":
            guard let requestId, let text = payload["text"] as? String else { return nil }
            return .responseCompleted(
                requestId: requestId,
                text: text,
                verified: payload["verified"] as? Bool ?? false
            )
        case "tool.started":
            guard let requestId else { return nil }
            return .toolStarted(requestId: requestId, name: payload["toolName"] as? String ?? "tool")
        case "tool.completed":
            guard let requestId else { return nil }
            return .toolCompleted(
                requestId: requestId,
                name: payload["toolName"] as? String ?? "tool",
                isError: payload["isError"] as? Bool ?? false
            )
        case "turn.cancelled":
            guard let requestId else { return nil }
            return .turnCancelled(requestId: requestId)
        case "turn.failed", "runtime.error":
            return .failed(
                requestId: requestId,
                message: payload["message"] as? String ?? "Runtime 返回了未知错误。"
            )
        default:
            return nil
        }
    }

    private func resolveConfiguration() throws -> RuntimeConfiguration {
        let environment = ProcessInfo.processInfo.environment
        let info = Bundle.main.infoDictionary ?? [:]

        let runtimeEntry: URL
        if let rawEntry = environment["YISHU_RUNTIME_ENTRY"] ?? environment["HANAKO_RUNTIME_ENTRY"], !rawEntry.isEmpty {
            runtimeEntry = URL(fileURLWithPath: rawEntry)
        } else if let bundledEntry = Bundle.main.resourceURL?
            .appendingPathComponent("packages/runtime/dist/stdio-server.js"),
                  FileManager.default.fileExists(atPath: bundledEntry.path) {
            runtimeEntry = bundledEntry
        } else {
            let localEntry = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
                .appendingPathComponent("packages/runtime/dist/stdio-server.js")
            guard FileManager.default.fileExists(atPath: localEntry.path) else {
                throw RuntimeClientError.runtimeEntryMissing
            }
            runtimeEntry = localEntry
        }
        guard FileManager.default.fileExists(atPath: runtimeEntry.path) else {
            throw RuntimeClientError.runtimeEntryMissing
        }

        let nodeCandidates = [
            environment["YISHU_NODE_EXECUTABLE"],
            info["YishuNodeExecutable"] as? String,
            environment["HANAKO_NODE_EXECUTABLE"],
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
        ].compactMap { $0 }.filter { !$0.isEmpty }
        guard let nodePath = nodeCandidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw RuntimeClientError.nodeExecutableMissing
        }

        let configuredWorkingDirectory = [
            environment["YISHU_WORKING_DIRECTORY"],
            info["YishuWorkingDirectory"] as? String,
            environment["HANAKO_WORKING_DIRECTORY"],
        ].compactMap { $0 }.first(where: { !$0.isEmpty })
        let workingDirectoryPath: String
        if let configuredWorkingDirectory {
            workingDirectoryPath = configuredWorkingDirectory
        } else {
            let applicationSupport = try FileManager.default.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            let runtimeWorkspace = applicationSupport
                .appendingPathComponent("Yishu", isDirectory: true)
                .appendingPathComponent("RuntimeWorkspace", isDirectory: true)
            try FileManager.default.createDirectory(
                at: runtimeWorkspace,
                withIntermediateDirectories: true
            )
            workingDirectoryPath = runtimeWorkspace.path
        }
        let workingDirectory = URL(fileURLWithPath: workingDirectoryPath, isDirectory: true)
        let mode = environment["YISHU_RUNTIME_MODE"]
            ?? info["YishuRuntimeMode"] as? String
            ?? environment["HANAKO_RUNTIME_MODE"]
            ?? "mock"

        return RuntimeConfiguration(
            nodeExecutable: URL(fileURLWithPath: nodePath),
            runtimeEntry: runtimeEntry,
            workingDirectory: workingDirectory,
            mode: mode
        )
    }

    private func resetProcessReferences() {
        outputHandle?.readabilityHandler = nil
        errorHandle?.readabilityHandler = nil
        process = nil
        inputHandle = nil
        outputHandle = nil
        errorHandle = nil
        stopping = false
        outputBuffer.removeAll(keepingCapacity: false)
    }
}

private struct RuntimeConfiguration {
    let nodeExecutable: URL
    let runtimeEntry: URL
    let workingDirectory: URL
    let mode: String
}

private struct TurnStartCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: TurnStartPayload
}

private struct TurnStartPayload: Encodable {
    let utterance: String
    let contextFrame: ContextFrame
    let capabilityProfile: String
}

private struct TurnCancelCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: TurnCancelPayload
}

private struct TurnCancelPayload: Encodable {
    let reason: String
}
