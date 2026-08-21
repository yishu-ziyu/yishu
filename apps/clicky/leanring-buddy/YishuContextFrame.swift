import YishuContext

// Yishu's production collector keeps its established Yishu-prefixed names,
// while the portable evidence schema and validation live in YishuContext.
// These aliases are the only compatibility boundary; they do not define a
// second wire model or validation implementation.
let yishuRuntimeProtocolVersion = yishuProtocolVersion

typealias YishuScreenCoordinateSpace = ScreenCoordinateSpace
typealias YishuScreenPoint = ScreenPoint
typealias YishuPointerKind = PointerKind
typealias YishuPointerSample = PointerSample
typealias YishuObservedValue<Value: Codable & Sendable> = ObservedValue<Value>
typealias YishuApplicationContext = ApplicationContext
typealias YishuWindowBounds = WindowBounds
typealias YishuWindowContext = WindowContext
typealias YishuAccessibilityElementContext = AccessibilityElementContext
typealias YishuNumberedAccessibilityTarget = NumberedAccessibilityTarget
typealias YishuScreenshotContext = ScreenshotContext
typealias YishuContextFrame = ContextFrame
typealias YishuContextFrameValidationError = ContextFrameValidationError
