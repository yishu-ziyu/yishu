import Foundation

enum YishuRuntimeTransportError: Error, Equatable {
    case launchFailed
    case notRunning
}

struct YishuRuntimeTransportLaunch: Equatable {
    let executable: URL
    let arguments: [String]
    let workingDirectory: URL
    let environment: [String: String]
}

/// Newline framing for one stdout stream. Chunk boundaries are not semantic;
/// a complete line is delivered exactly once, and a trailing partial stays
/// buffered until the rest arrives.
struct YishuRuntimeStdoutFramer: Equatable {
    private(set) var buffer = Data()

    var pendingByteCount: Int { buffer.count }

    mutating func ingest(_ chunk: Data) -> [Data] {
        guard !chunk.isEmpty else { return [] }
        buffer.append(chunk)
        var lines: [Data] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            lines.append(Data(buffer[..<newline]))
            buffer.removeSubrange(...newline)
        }
        return lines
    }

    mutating func reset() {
        buffer.removeAll(keepingCapacity: false)
    }
}

enum YishuRuntimeStdinFraming {
    static func frame(_ payload: Data) -> Data {
        var framed = payload
        framed.append(0x0A)
        return framed
    }
}

/// Owns the Node sidecar process and stdio pipes. It does not decode Yishu
/// protocol events or own request/turn semantics.
@MainActor
final class YishuRuntimeStdioTransport {
    var onStdoutLine: ((Data) -> Void)?
    var onTerminated: ((Int32) -> Void)?

    private var process: Process?
    private var inputHandle: FileHandle?
    private var outputHandle: FileHandle?
    private var errorHandle: FileHandle?
    private var framer = YishuRuntimeStdoutFramer()
    private var didReportTermination = false

    var isRunning: Bool { process?.isRunning == true }

    var processIdentifier: Int32? {
        guard let process, process.isRunning else { return nil }
        return process.processIdentifier
    }

    func start(launch: YishuRuntimeTransportLaunch) throws {
        if process?.isRunning == true { return }
        if process != nil { reset() }

        let runtimeProcess = Process()
        let inputPipe = Pipe()
        let outputPipe = Pipe()
        let errorPipe = Pipe()

        runtimeProcess.executableURL = launch.executable
        runtimeProcess.arguments = launch.arguments
        runtimeProcess.currentDirectoryURL = launch.workingDirectory
        runtimeProcess.environment = launch.environment
        runtimeProcess.standardInput = inputPipe
        runtimeProcess.standardOutput = outputPipe
        runtimeProcess.standardError = errorPipe

        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor in
                self?.deliverStdout(data)
            }
        }

        // Runtime stderr can contain provider request fragments. Consume it but
        // never mirror it into Console or the user-visible overlay.
        errorPipe.fileHandleForReading.readabilityHandler = { handle in
            _ = handle.availableData
        }

        runtimeProcess.terminationHandler = { [weak self] terminatedProcess in
            let exitCode = terminatedProcess.terminationStatus
            Task { @MainActor in
                self?.handleTermination(
                    of: terminatedProcess,
                    exitCode: exitCode
                )
            }
        }

        do {
            try runtimeProcess.run()
        } catch {
            outputPipe.fileHandleForReading.readabilityHandler = nil
            errorPipe.fileHandleForReading.readabilityHandler = nil
            throw YishuRuntimeTransportError.launchFailed
        }

        didReportTermination = false
        process = runtimeProcess
        inputHandle = inputPipe.fileHandleForWriting
        outputHandle = outputPipe.fileHandleForReading
        errorHandle = errorPipe.fileHandleForReading
    }

    func stop() {
        inputHandle?.closeFile()
        inputHandle = nil
        if let process, process.isRunning {
            process.terminate()
        } else {
            reset()
        }
    }

    func send(_ payload: Data) throws {
        guard let inputHandle, process?.isRunning == true else {
            throw YishuRuntimeTransportError.notRunning
        }
        try inputHandle.write(contentsOf: YishuRuntimeStdinFraming.frame(payload))
    }

    private func deliverStdout(_ data: Data) {
        for line in framer.ingest(data) {
            onStdoutLine?(line)
        }
    }

    private func handleTermination(of terminatedProcess: Process, exitCode: Int32) {
        guard process == nil || process === terminatedProcess else { return }
        guard !didReportTermination else { return }
        didReportTermination = true
        reset()
        onTerminated?(exitCode)
    }

    private func reset() {
        outputHandle?.readabilityHandler = nil
        errorHandle?.readabilityHandler = nil
        process = nil
        inputHandle = nil
        outputHandle = nil
        errorHandle = nil
        framer.reset()
    }
}
