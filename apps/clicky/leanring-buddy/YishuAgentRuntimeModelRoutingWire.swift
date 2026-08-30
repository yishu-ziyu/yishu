import Foundation

struct YishuModelPreference: Encodable, Equatable {
    let provider: String
    let model: String
}

struct YishuTurnStartCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuTurnStartPayload
}

struct YishuTurnStartPayload: Encodable {
    let utterance: String
    let contextFrame: YishuContextFrame
    let capabilityProfile: String
    let conversationId: UUID
    let sessionScope: YishuSessionScope
    let modelPreference: YishuModelPreference
    let modelRouting: YishuModelRouting
}
