import Foundation
import Testing
@testable import Clicky

@MainActor
struct YishuFileDropProtocolTests {
    @Test func decodesOnlyTheRuntimeBoundFileDropContract() throws {
        let requestID = UUID()
        let traceID = UUID()
        let payload: [String: Any] = [
            "actionId": UUID().uuidString,
            "action": "drop_download_file",
            "fileName": "奕枢测试文件.txt",
            "targetId": "3",
            "targetBundleId": "com.apple.Safari",
            "targetPid": 321,
            "targetWindowNumber": 17,
            "targetFingerprint": ["AXGroup", "上传文件", "拖放到这里", "200,400,480,160"]
                .joined(separator: "\u{1e}"),
            "intentId": UUID().uuidString,
            "attemptId": UUID().uuidString,
            "basisFrameId": UUID().uuidString,
            "effectClass": "external_disclosure",
        ]

        let request = try #require(YishuAgentRuntimeClient.decodeComputerActionRequest(
            payload: payload,
            requestId: requestID,
            traceId: traceID,
            schemaVersion: NSNumber(value: 1)
        ))
        #expect(request.fileName == "奕枢测试文件.txt")
        #expect(request.targetId == "3")
        #expect(request.targetWindowNumber == 17)
        #expect(request.targetFingerprint?.contains("上传文件") == true)

        for fileName in ["../secret.txt", "folder/secret.txt", "folder\\secret.txt", ".", "..", "no-extension", "bad\u{0}.txt"] {
            var invalid = payload
            invalid["fileName"] = fileName
            #expect(YishuAgentRuntimeClient.decodeComputerActionRequest(
                payload: invalid,
                requestId: requestID,
                traceId: traceID,
                schemaVersion: NSNumber(value: 1)
            ) == nil)
        }

        let invalidFields: [(String, Any)] = [
            ("effectClass", "write"),
            ("targetId", "0"),
            ("targetWindowNumber", 0),
        ]
        for (key, value) in invalidFields {
            var invalid = payload
            invalid[key] = value
            #expect(YishuAgentRuntimeClient.decodeComputerActionRequest(
                payload: invalid,
                requestId: requestID,
                traceId: traceID,
                schemaVersion: NSNumber(value: 1)
            ) == nil)
        }

        var pathEscape = payload
        pathEscape["path"] = "/Users/me/Downloads/奕枢测试文件.txt"
        #expect(YishuAgentRuntimeClient.decodeComputerActionRequest(
            payload: pathEscape,
            requestId: requestID,
            traceId: traceID,
            schemaVersion: NSNumber(value: 1)
        ) == nil)
    }
}
