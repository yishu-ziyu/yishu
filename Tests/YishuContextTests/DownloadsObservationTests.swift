import Foundation
import XCTest
@testable import YishuContext

final class DownloadsObservationTests: XCTestCase {
    func testSpokenNamesResolveFromRealDirectoryWithoutFixtureAliases() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        for name in ["奕枢测试文件.txt", "会议记录.md", "日程.pdf"] {
            try Data("fixture".utf8).write(to: root.appendingPathComponent(name))
        }
        for utterance in ["把下载里的易书测试文件点.txt拖到上传框", "把下载里的奕枢测试文件拖到这个框"] {
            let observation = try XCTUnwrap(DownloadsObservation.capture(utterance: utterance, directory: root))
            XCTAssertEqual(observation.status, .available)
            XCTAssertEqual(observation.candidates, ["奕枢测试文件.txt"])
        }
        let renamed = try XCTUnwrap(DownloadsObservation.capture(
            utterance: "把下载里的会义记录点md上传", directory: root
        ))
        XCTAssertEqual(renamed.candidates, ["会议记录.md"])
    }

    func testAmbiguityMissingAndUnrelatedInputRemainDistinct() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        for name in ["会议记录.md", "会义记录.txt"] {
            try Data("fixture".utf8).write(to: root.appendingPathComponent(name))
        }
        let ambiguous = try XCTUnwrap(DownloadsObservation.capture(utterance: "把下载里的会忆记录上传", directory: root))
        XCTAssertEqual(ambiguous.candidates.count, 2)
        let missing = try XCTUnwrap(DownloadsObservation.capture(utterance: "把下载里的年度报告上传", directory: root))
        XCTAssertEqual(missing.status, .available)
        XCTAssertEqual(missing.candidates, [])
        XCTAssertNil(DownloadsObservation.capture(utterance: "今天星期几", directory: root))
        XCTAssertNil(DownloadsObservation.capture(utterance: "不要把下载里的会议记录上传", directory: root))
    }

    func testDirectoriesAndEscapingSymlinksAreNotFileCandidates() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("会议记录.md"), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("会议记录.txt"), withDestinationURL: URL(fileURLWithPath: "/etc/hosts"))
        let observation = try XCTUnwrap(DownloadsObservation.capture(utterance: "把下载里的会议记录上传", directory: root))
        XCTAssertEqual(observation.candidates, [])
        let unavailable = try XCTUnwrap(DownloadsObservation.capture(utterance: "把下载里的会议记录上传", directory: root.appendingPathComponent("absent")))
        XCTAssertEqual(unavailable.status, .unavailable)
    }

    func testPermissionClassificationAndObservationWireRoundTrip() throws {
        XCTAssertEqual(DownloadsObservation.status(for: NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoPermissionError)), .permissionDenied)
        let value = DownloadsObservation(status: .available, capturedAt: Date(), candidates: ["会议记录.md"], truncated: false)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(value)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        XCTAssertEqual(try decoder.decode(DownloadsObservation.self, from: data).candidates, value.candidates)
    }

    func testOptionalObservationSurvivesCanonicalFrameWireAndLegacyFrames() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var frame = ContextFrame(capturedAt: now, expiresAt: now.addingTimeInterval(30),
            cursor: ObservedValue(value: ScreenPoint(x: 0, y: 0, coordinateSpace: .globalTopLeft), source: "test", capturedAt: now, confidence: 1),
            pointerTrail: [], frontmostApplication: nil, activeWindow: nil, elementUnderCursor: nil, screenshots: [], warnings: [])
        let encoder = JSONEncoder(), decoder = JSONDecoder()
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
        XCTAssertNil(try decoder.decode(ContextFrame.self, from: encoder.encode(frame)).downloadFiles)
        frame.downloadFiles = DownloadsObservation(status: .available, capturedAt: now, candidates: ["会议记录.md"], truncated: false)
        let decoded = try decoder.decode(ContextFrame.self, from: encoder.encode(frame))
        XCTAssertEqual(decoded.schemaVersion, 1)
        XCTAssertEqual(decoded.downloadFiles?.candidates, ["会议记录.md"])
    }
}
