import Foundation
import Testing
@testable import Clicky

struct YishuCodexApprovalTests {
    @Test func slowOtherProviderDoesNotOverwriteCodexStatus() {
        var codex = YishuProviderAccountState()
        codex.phase = .idle
        codex.message = "Codex available"
        var xai = YishuProviderAccountState()
        xai.phase = .loading
        let states = YishuProviderStatusFailureReducer.apply(
            to: [.openAICodex: codex, .xAI: xai], provider: .xAI,
            code: "unavailable", message: "查询超时")
        #expect(states[.openAICodex] == codex)
        #expect(states[.xAI]?.phase == .idle)
        #expect(states[.xAI]?.failure?.code == "unavailable")
    }

    @Test func acceptsCurrentApprovalAndRejectsMalformedPayloads() {
        let payload: [String: Any] = ["approvalId": UUID().uuidString, "message": "允许使用计算器？", "generation": 1]
        #expect(YishuCodexApproval.decode(payload) != nil)
        #expect(YishuCodexApproval.decode(["approvalId": "bad", "message": "test"]) == nil)
        #expect(YishuCodexApproval.decode(["approvalId": UUID().uuidString, "message": "test", "command": "unexpected"]) == nil)
    }

    @Test func replyRetainsOwningTurnAndApproval() throws {
        let request = UUID(), trace = UUID(), approval = UUID()
        let reply = YishuCodexApprovalReply(schemaVersion: 1, requestId: request, traceId: trace,
            payload: .init(approvalId: approval, accept: false))
        let value = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(reply)) as? [String: Any])
        #expect(value["type"] as? String == "codex.approval.reply")
        #expect(value["requestId"] as? String == request.uuidString)
        #expect(value["traceId"] as? String == trace.uuidString)
        let payload = try #require(value["payload"] as? [String: Any])
        #expect(payload["approvalId"] as? String == approval.uuidString)
        #expect(payload["accept"] as? Bool == false)
    }
}
