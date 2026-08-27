import Foundation

struct YishuAuthStatusCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuAuthStatusPayload
}

struct YishuAuthStatusPayload: Encodable {
    let provider: String?

    private enum CodingKeys: String, CodingKey {
        case provider
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(provider, forKey: .provider)
    }
}

struct YishuAuthLoginStartCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuAuthLoginStartPayload
}

struct YishuAuthLoginStartPayload: Encodable {
    let provider: String
    let authType: String
}

struct YishuAuthPromptReplyCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuAuthPromptReplyPayload
}

struct YishuAuthPromptReplyPayload: Encodable {
    let provider: String
    let promptId: String
    let value: String
}

struct YishuAuthLoginCancelCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuAuthLoginCancelPayload
}

struct YishuAuthLoginCancelPayload: Encodable {
    let provider: String
    let reason: String?

    private enum CodingKeys: String, CodingKey {
        case provider
        case reason
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(provider, forKey: .provider)
        try container.encodeIfPresent(reason, forKey: .reason)
    }
}

struct YishuAuthLogoutCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuAuthLogoutPayload
}

struct YishuAuthLogoutPayload: Encodable {
    let provider: String
}
