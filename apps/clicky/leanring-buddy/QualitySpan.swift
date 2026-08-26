import Foundation

struct QualitySpan {
    let name: String
    let sessionId: String
    let startedAt = Date()

    func end(status: String = "ok", attributes: [String: Any] = [:]) {
        let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        QualityEventRecorder.record(
            name: name,
            sessionId: sessionId,
            status: status,
            durationMs: durationMs,
            attributes: attributes
        )
    }
}
