import Foundation

public let yishuProtocolVersion = 1

public enum ScreenCoordinateSpace: String, Codable, Sendable {
    case globalTopLeft = "global-top-left"
    case appKitBottomLeft = "appkit-bottom-left"
}

public struct ScreenPoint: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let coordinateSpace: ScreenCoordinateSpace

    public init(x: Double, y: Double, coordinateSpace: ScreenCoordinateSpace) {
        self.x = x
        self.y = y
        self.coordinateSpace = coordinateSpace
    }
}

public enum PointerKind: String, Codable, Sendable {
    case move
    case drag
    case leftDown
    case leftUp
    case rightDown
    case rightUp
    case scroll
}

public struct PointerSample: Codable, Equatable, Sendable {
    public let capturedAt: Date
    public let point: ScreenPoint
    public let kind: PointerKind

    public init(capturedAt: Date, point: ScreenPoint, kind: PointerKind) {
        self.capturedAt = capturedAt
        self.point = point
        self.kind = kind
    }
}

public struct ObservedValue<Value: Codable & Sendable>: Codable, Sendable {
    public let value: Value
    public let source: String
    public let capturedAt: Date
    public let confidence: Double

    public init(value: Value, source: String, capturedAt: Date, confidence: Double) {
        self.value = value
        self.source = source
        self.capturedAt = capturedAt
        self.confidence = confidence
    }
}

public struct ApplicationContext: Codable, Equatable, Sendable {
    public let name: String
    public let bundleIdentifier: String?
    public let processIdentifier: Int

    public init(name: String, bundleIdentifier: String?, processIdentifier: Int) {
        self.name = name
        self.bundleIdentifier = bundleIdentifier
        self.processIdentifier = processIdentifier
    }
}

public struct WindowBounds: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct WindowContext: Codable, Equatable, Sendable {
    public let title: String?
    public let ownerName: String
    public let processIdentifier: Int
    public let bounds: WindowBounds?

    public init(title: String?, ownerName: String, processIdentifier: Int, bounds: WindowBounds?) {
        self.title = title
        self.ownerName = ownerName
        self.processIdentifier = processIdentifier
        self.bounds = bounds
    }
}

public struct AccessibilityElementContext: Codable, Equatable, Sendable {
    public let role: String?
    public let subrole: String?
    public let title: String?
    public let description: String?
    public let valuePreview: String?

    public init(
        role: String?,
        subrole: String?,
        title: String?,
        description: String?,
        valuePreview: String?
    ) {
        self.role = role
        self.subrole = subrole
        self.title = title
        self.description = description
        self.valuePreview = valuePreview
    }
}

public struct ScreenshotContext: Codable, Equatable, Sendable {
    public let label: String
    public let mediaType: String
    public let base64Data: String
    public let displayWidthPoints: Int
    public let displayHeightPoints: Int
    public let screenshotWidthPixels: Int
    public let screenshotHeightPixels: Int

    public init(
        label: String,
        mediaType: String = "image/jpeg",
        base64Data: String,
        displayWidthPoints: Int,
        displayHeightPoints: Int,
        screenshotWidthPixels: Int,
        screenshotHeightPixels: Int
    ) {
        self.label = label
        self.mediaType = mediaType
        self.base64Data = base64Data
        self.displayWidthPoints = displayWidthPoints
        self.displayHeightPoints = displayHeightPoints
        self.screenshotWidthPixels = screenshotWidthPixels
        self.screenshotHeightPixels = screenshotHeightPixels
    }
}

public struct ContextFrame: Codable, Sendable {
    public let schemaVersion: Int
    public let frameId: UUID
    public let capturedAt: Date
    public let expiresAt: Date
    public let cursor: ObservedValue<ScreenPoint>
    public let pointerTrail: [PointerSample]
    public let frontmostApplication: ObservedValue<ApplicationContext>?
    public let activeWindow: ObservedValue<WindowContext>?
    public let elementUnderCursor: ObservedValue<AccessibilityElementContext>?
    public let screenshots: [ScreenshotContext]
    public let warnings: [String]

    public init(
        schemaVersion: Int = yishuProtocolVersion,
        frameId: UUID = UUID(),
        capturedAt: Date,
        expiresAt: Date,
        cursor: ObservedValue<ScreenPoint>,
        pointerTrail: [PointerSample],
        frontmostApplication: ObservedValue<ApplicationContext>?,
        activeWindow: ObservedValue<WindowContext>?,
        elementUnderCursor: ObservedValue<AccessibilityElementContext>?,
        screenshots: [ScreenshotContext],
        warnings: [String]
    ) {
        self.schemaVersion = schemaVersion
        self.frameId = frameId
        self.capturedAt = capturedAt
        self.expiresAt = expiresAt
        self.cursor = cursor
        self.pointerTrail = Array(pointerTrail.suffix(240))
        self.frontmostApplication = frontmostApplication
        self.activeWindow = activeWindow
        self.elementUnderCursor = elementUnderCursor
        self.screenshots = Array(screenshots.prefix(4))
        self.warnings = warnings
    }

    public func validate(referenceDate: Date = Date()) throws {
        guard schemaVersion == yishuProtocolVersion else {
            throw ContextFrameValidationError.unsupportedSchemaVersion(schemaVersion)
        }
        guard expiresAt > capturedAt else {
            throw ContextFrameValidationError.invalidExpiry
        }
        guard expiresAt > referenceDate else {
            throw ContextFrameValidationError.expired
        }
        let confidences = [
            cursor.confidence,
            frontmostApplication?.confidence,
            activeWindow?.confidence,
            elementUnderCursor?.confidence,
        ].compactMap { $0 }
        if let invalidConfidence = confidences.first(where: { !(0...1).contains($0) }) {
            throw ContextFrameValidationError.invalidConfidence(invalidConfidence)
        }
        guard screenshots.allSatisfy({
            $0.mediaType == "image/jpeg" &&
                !$0.base64Data.isEmpty &&
                $0.displayWidthPoints > 0 &&
                $0.displayHeightPoints > 0 &&
                $0.screenshotWidthPixels > 0 &&
                $0.screenshotHeightPixels > 0
        }) else {
            throw ContextFrameValidationError.invalidScreenshot
        }
    }
}

public enum ContextFrameValidationError: Error, Equatable {
    case unsupportedSchemaVersion(Int)
    case invalidExpiry
    case expired
    case invalidConfidence(Double)
    case invalidScreenshot
}

extension ApplicationContext {
    private enum CodingKeys: String, CodingKey {
        case name
        case bundleIdentifier
        case processIdentifier
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        if let bundleIdentifier {
            try container.encode(bundleIdentifier, forKey: .bundleIdentifier)
        } else {
            try container.encodeNil(forKey: .bundleIdentifier)
        }
        try container.encode(processIdentifier, forKey: .processIdentifier)
    }
}

extension WindowContext {
    private enum CodingKeys: String, CodingKey {
        case title
        case ownerName
        case processIdentifier
        case bounds
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let title {
            try container.encode(title, forKey: .title)
        } else {
            try container.encodeNil(forKey: .title)
        }
        try container.encode(ownerName, forKey: .ownerName)
        try container.encode(processIdentifier, forKey: .processIdentifier)
        if let bounds {
            try container.encode(bounds, forKey: .bounds)
        } else {
            try container.encodeNil(forKey: .bounds)
        }
    }
}

extension AccessibilityElementContext {
    private enum CodingKeys: String, CodingKey, CaseIterable {
        case role
        case subrole
        case title
        case description
        case valuePreview
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeNullable(role, forKey: .role)
        try container.encodeNullable(subrole, forKey: .subrole)
        try container.encodeNullable(title, forKey: .title)
        try container.encodeNullable(description, forKey: .description)
        try container.encodeNullable(valuePreview, forKey: .valuePreview)
    }
}

extension ContextFrame {
    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case frameId
        case capturedAt
        case expiresAt
        case cursor
        case pointerTrail
        case frontmostApplication
        case activeWindow
        case elementUnderCursor
        case screenshots
        case warnings
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(frameId, forKey: .frameId)
        try container.encode(capturedAt, forKey: .capturedAt)
        try container.encode(expiresAt, forKey: .expiresAt)
        try container.encode(cursor, forKey: .cursor)
        try container.encode(pointerTrail, forKey: .pointerTrail)
        try container.encodeNullable(frontmostApplication, forKey: .frontmostApplication)
        try container.encodeNullable(activeWindow, forKey: .activeWindow)
        try container.encodeNullable(elementUnderCursor, forKey: .elementUnderCursor)
        try container.encode(screenshots, forKey: .screenshots)
        try container.encode(warnings, forKey: .warnings)
    }
}

private extension KeyedEncodingContainer {
    mutating func encodeNullable<Value: Encodable>(_ value: Value?, forKey key: Key) throws {
        if let value {
            try encode(value, forKey: key)
        } else {
            try encodeNil(forKey: key)
        }
    }
}
