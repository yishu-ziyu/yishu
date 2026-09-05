import AppKit

struct YishuCodexApproval {
    let approvalId: UUID
    let message: String

    static func decode(_ payload: [String: Any]) -> Self? {
        guard Set(payload.keys).isSubset(of: ["approvalId", "message", "generation"]),
              let rawId = payload["approvalId"] as? String,
              let approvalId = UUID(uuidString: rawId),
              let message = payload["message"] as? String,
              !message.isEmpty, message.count <= 3000 else { return nil }
        return Self(approvalId: approvalId, message: message)
    }
}

struct YishuCodexApprovalReply: Encodable {
    let schemaVersion: Int
    let type = "codex.approval.reply"
    let requestId: UUID
    let traceId: UUID
    let sentAt = Date()
    let payload: Payload

    struct Payload: Encodable {
        let approvalId: UUID
        let accept: Bool
    }
}

/// One desktop task owns this dialog. Cancellation dismisses it before any late reply.
@MainActor
final class YishuCodexApprovalPresenter {
    private var alert: NSAlert?
    private var cancelled = false

    func present(_ approval: YishuCodexApproval) -> Bool {
        guard !cancelled else { return false }
        let alert = NSAlert()
        alert.messageText = "Codex 请求确认"
        alert.informativeText = approval.message
        alert.addButton(withTitle: "允许本次")
        alert.addButton(withTitle: "拒绝")
        alert.alertStyle = .informational
        self.alert = alert
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        self.alert = nil
        return !cancelled && response == .alertFirstButtonReturn
    }

    func cancel() {
        cancelled = true
        if let alert {
            NSApp.abortModal()
            alert.window.orderOut(nil)
        }
    }
}
