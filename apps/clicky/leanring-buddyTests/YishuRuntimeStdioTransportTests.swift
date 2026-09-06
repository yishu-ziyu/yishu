import Foundation
import Testing
@testable import Clicky

struct YishuRuntimeStdoutFramerTests {
    @Test func fragmentedChunksBecomeOneLineExactlyOnce() {
        var framer = YishuRuntimeStdoutFramer()
        #expect(framer.ingest(Data("hel".utf8)).isEmpty)
        #expect(framer.pendingByteCount == 3)
        let lines = framer.ingest(Data("lo\n".utf8))
        #expect(lines == [Data("hello".utf8)])
        #expect(framer.pendingByteCount == 0)
        #expect(framer.ingest(Data("lo\n".utf8)) == [Data("lo".utf8)])
    }

    @Test func batchedChunkDeliversLinesInOrderExactlyOnce() {
        var framer = YishuRuntimeStdoutFramer()
        let lines = framer.ingest(Data("alpha\nbeta\n".utf8))
        #expect(lines == [Data("alpha".utf8), Data("beta".utf8)])
        #expect(framer.pendingByteCount == 0)
        #expect(framer.ingest(Data()).isEmpty)
    }

    @Test func trailingPartialStaysBufferedUntilNewline() {
        var framer = YishuRuntimeStdoutFramer()
        #expect(framer.ingest(Data("keep".utf8)).isEmpty)
        #expect(framer.pendingByteCount == 4)
        #expect(framer.ingest(Data("ing".utf8)).isEmpty)
        #expect(framer.pendingByteCount == 7)
        #expect(framer.ingest(Data("\nmore".utf8)) == [Data("keeping".utf8)])
        #expect(framer.pendingByteCount == 4)
        #expect(framer.ingest(Data("\n".utf8)) == [Data("more".utf8)])
        #expect(framer.pendingByteCount == 0)
    }
}

struct YishuRuntimeStdinFramingTests {
    @Test func frameAppendsExactlyOneNewlineWithoutMutatingPayload() {
        let payload = Data("{\"type\":\"turn.start\"}".utf8)
        let original = payload
        let framed = YishuRuntimeStdinFraming.frame(payload)
        #expect(payload == original)
        #expect(framed == original + Data([0x0A]))
        #expect(framed.filter { $0 == 0x0A }.count == 1)
    }
}

@MainActor
struct YishuRuntimeStdioTransportTests {
    @Test func repeatedStartWhileRunningKeepsOneProcess() throws {
        let transport = YishuRuntimeStdioTransport()
        try transport.start(launch: Self.catLaunch)
        let first = try #require(transport.processIdentifier)
        try transport.start(launch: Self.catLaunch)
        #expect(transport.processIdentifier == first)
        #expect(transport.isRunning)
        transport.stop()
    }

    @Test func stopClearsLiveTransportOwnership() async throws {
        let transport = YishuRuntimeStdioTransport()
        try transport.start(launch: Self.catLaunch)
        #expect(transport.isRunning)
        transport.stop()
        await waitUntil { !transport.isRunning }
        #expect(!transport.isRunning)
        #expect(transport.processIdentifier == nil)
        #expect(throws: YishuRuntimeTransportError.notRunning) {
            try transport.send(Data("late".utf8))
        }
    }

    @Test func terminationReachesBoundaryExactlyOnce() async throws {
        let transport = YishuRuntimeStdioTransport()
        var exitCodes: [Int32] = []
        transport.onTerminated = { exitCodes.append($0) }
        try transport.start(launch: Self.catLaunch)
        transport.stop()
        await waitUntil { !exitCodes.isEmpty && !transport.isRunning }
        #expect(exitCodes.count == 1)
        transport.stop()
        try? await Task.sleep(nanoseconds: 30_000_000)
        #expect(exitCodes.count == 1)
    }

    @Test func sendWritesOneNewlineDelimitedMessageAndCatEchoesItOnce() async throws {
        let transport = YishuRuntimeStdioTransport()
        var lines: [Data] = []
        transport.onStdoutLine = { lines.append($0) }
        try transport.start(launch: Self.catLaunch)
        let payload = Data("abc".utf8)
        try transport.send(payload)
        await waitUntil { lines == [payload] }
        #expect(lines == [payload])
        transport.stop()
    }

    @Test func stderrIsDrainedAndNeverForwardedAsStdout() async throws {
        let transport = YishuRuntimeStdioTransport()
        var lines: [Data] = []
        transport.onStdoutLine = { lines.append($0) }
        try transport.start(launch: Self.stderrThenCatLaunch)
        try transport.send(Data("ok".utf8))
        await waitUntil { lines == [Data("ok".utf8)] }
        #expect(!lines.contains(where: { String(data: $0, encoding: .utf8)?.contains("secret-fragment") == true }))
        #expect(lines == [Data("ok".utf8)])
        transport.stop()
    }

    private static var catLaunch: YishuRuntimeTransportLaunch {
        YishuRuntimeTransportLaunch(
            executable: URL(fileURLWithPath: "/bin/cat"),
            arguments: [],
            workingDirectory: FileManager.default.temporaryDirectory,
            environment: ["PATH": "/bin:/usr/bin"]
        )
    }

    private static var stderrThenCatLaunch: YishuRuntimeTransportLaunch {
        YishuRuntimeTransportLaunch(
            executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "printf 'secret-fragment\\n' >&2; exec cat"],
            workingDirectory: FileManager.default.temporaryDirectory,
            environment: ["PATH": "/bin:/usr/bin"]
        )
    }

    private func waitUntil(
        _ condition: @escaping @MainActor () -> Bool
    ) async {
        for _ in 0..<100 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}
