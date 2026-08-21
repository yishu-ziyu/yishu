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
    /// Quartz window identity. Optional so frames produced before this was
    /// captured remain wire-compatible.
    public let windowNumber: Int?
    public let bounds: WindowBounds?

    public init(
        title: String?,
        ownerName: String,
        processIdentifier: Int,
        windowNumber: Int? = nil,
        bounds: WindowBounds?
    ) {
        self.title = title
        self.ownerName = ownerName
        self.processIdentifier = processIdentifier
        self.windowNumber = windowNumber
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

/// A pressable control in the focused window, numbered in visual order.
/// Ids are recomputed from a fresh AX walk at click time; they are not AX
/// pointers and must not be treated as stable across window changes.
public struct NumberedAccessibilityTarget: Codable, Equatable, Sendable {
    public let id: String
    public let role: String?
    public let title: String?
    public let description: String?
    public let enabled: Bool?

    public init(
        id: String,
        role: String?,
        title: String?,
        description: String?,
        enabled: Bool?
    ) {
        self.id = id
        self.role = role
        self.title = title
        self.description = description
        self.enabled = enabled
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
    /// Global display origin, in the same coordinate space as the frame cursor.
    /// Optional so protocol-v1 frames produced before multi-display origins were
    /// added remain decodable.
    public let displayOriginXPoints: Double?
    public let displayOriginYPoints: Double?
    /// Present only for an exact frontmost-window capture. Display captures
    /// keep the legacy shape so click-coordinate consumers cannot mistake
    /// this image for a whole display.
    public let sourceWindowNumber: Int?

    public init(
        label: String,
        mediaType: String = "image/jpeg",
        base64Data: String,
        displayWidthPoints: Int,
        displayHeightPoints: Int,
        screenshotWidthPixels: Int,
        screenshotHeightPixels: Int,
        displayOriginXPoints: Double? = nil,
        displayOriginYPoints: Double? = nil,
        sourceWindowNumber: Int? = nil
    ) {
        self.label = label
        self.mediaType = mediaType
        self.base64Data = base64Data
        self.displayWidthPoints = displayWidthPoints
        self.displayHeightPoints = displayHeightPoints
        self.screenshotWidthPixels = screenshotWidthPixels
        self.screenshotHeightPixels = screenshotHeightPixels
        self.displayOriginXPoints = displayOriginXPoints
        self.displayOriginYPoints = displayOriginYPoints
        self.sourceWindowNumber = sourceWindowNumber
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
    public let numberedTargets: [NumberedAccessibilityTarget]
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
        numberedTargets: [NumberedAccessibilityTarget] = [],
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
        self.numberedTargets = Array(numberedTargets.prefix(50))
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
        guard screenshots.allSatisfy({ screenshot in
            let originIsValid: Bool = switch (
                screenshot.displayOriginXPoints,
                screenshot.displayOriginYPoints
            ) {
            case (nil, nil): true
            case let (x?, y?): x.isFinite && y.isFinite
            default: false
            }
            return screenshot.mediaType == "image/jpeg" &&
                !screenshot.base64Data.isEmpty &&
                screenshot.displayWidthPoints > 0 &&
                screenshot.displayHeightPoints > 0 &&
                screenshot.screenshotWidthPixels > 0 &&
                screenshot.screenshotHeightPixels > 0 &&
                originIsValid &&
                screenshotIdentityIsValid(screenshot)
        }) else {
            throw ContextFrameValidationError.invalidScreenshot
        }
    }
}

private func screenshotIdentityIsValid(_ screenshot: ScreenshotContext) -> Bool {
    screenshot.sourceWindowNumber == nil || screenshot.sourceWindowNumber! > 0
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
        case windowNumber
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
        try container.encodeIfPresent(windowNumber, forKey: .windowNumber)
        if let bounds {
            try container.encode(bounds, forKey: .bounds)
        } else {
            try container.encodeNil(forKey: .bounds)
        }
    }
}

extension ScreenshotContext {
    private enum CodingKeys: String, CodingKey {
        case label
        case mediaType
        case base64Data
        case displayWidthPoints
        case displayHeightPoints
        case screenshotWidthPixels
        case screenshotHeightPixels
        case displayOriginXPoints
        case displayOriginYPoints
        case sourceWindowNumber
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(label, forKey: .label)
        try container.encode(mediaType, forKey: .mediaType)
        try container.encode(base64Data, forKey: .base64Data)
        try container.encode(displayWidthPoints, forKey: .displayWidthPoints)
        try container.encode(displayHeightPoints, forKey: .displayHeightPoints)
        try container.encode(screenshotWidthPixels, forKey: .screenshotWidthPixels)
        try container.encode(screenshotHeightPixels, forKey: .screenshotHeightPixels)
        try container.encodeIfPresent(displayOriginXPoints, forKey: .displayOriginXPoints)
        try container.encodeIfPresent(displayOriginYPoints, forKey: .displayOriginYPoints)
        try container.encodeIfPresent(sourceWindowNumber, forKey: .sourceWindowNumber)
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

extension NumberedAccessibilityTarget {
    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id
        case role
        case title
        case description
        case enabled
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encodeNullable(role, forKey: .role)
        try container.encodeNullable(title, forKey: .title)
        try container.encodeNullable(description, forKey: .description)
        try container.encodeNullable(enabled, forKey: .enabled)
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
        case numberedTargets
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
        if !numberedTargets.isEmpty {
            try container.encode(numberedTargets, forKey: .numberedTargets)
        }
        try container.encode(warnings, forKey: .warnings)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            schemaVersion: try container.decode(Int.self, forKey: .schemaVersion),
            frameId: try container.decode(UUID.self, forKey: .frameId),
            capturedAt: try container.decode(Date.self, forKey: .capturedAt),
            expiresAt: try container.decode(Date.self, forKey: .expiresAt),
            cursor: try container.decode(ObservedValue<ScreenPoint>.self, forKey: .cursor),
            pointerTrail: try container.decode([PointerSample].self, forKey: .pointerTrail),
            frontmostApplication: try container.decodeIfPresent(
                ObservedValue<ApplicationContext>.self,
                forKey: .frontmostApplication
            ),
            activeWindow: try container.decodeIfPresent(
                ObservedValue<WindowContext>.self,
                forKey: .activeWindow
            ),
            elementUnderCursor: try container.decodeIfPresent(
                ObservedValue<AccessibilityElementContext>.self,
                forKey: .elementUnderCursor
            ),
            screenshots: try container.decode([ScreenshotContext].self, forKey: .screenshots),
            numberedTargets: try container.decodeIfPresent(
                [NumberedAccessibilityTarget].self,
                forKey: .numberedTargets
            ) ?? [],
            warnings: try container.decode([String].self, forKey: .warnings)
        )
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
