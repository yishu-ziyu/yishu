# 03 根 Swift 包：YishuContext

Type: wiki
Status: current
Verified: 34c0eaa 2026-08-15
Review: Sources/YishuContext 契约变化时

## 模块职责

根 Swift 包（[Package.swift](../../Package.swift)，包名 `Yishu`）导出唯一产物：`YishuContext` library。它拥有**可移植的证据协议**（`ContextFrame`）——跨 App 与 Runtime 的线协议契约，不拥有 UI、权限或启动生命周期。Clicky 通过 typealias 直接引用同一类型，不是第二个实现（ADR 0012：测试与构建不得创建第二个 App）。

- 平台：macOS 14+，Swift 5。
- 源码：`Sources/YishuContext/ContextFrame.swift`（单文件契约）。
- 测试：`Tests/YishuContextTests/YishuContextTests.swift`（`swift test` 运行）。

## 关键类型（ContextFrame.swift）

| 类型 | 说明 |
|------|------|
| `yishuProtocolVersion` | 协议版本常量，当前 `1` |
| `ObservedValue<Value>` | 证据包装：`value / source / capturedAt / confidence`——**每个 context 项都带来源、采集时间、置信度**（"Context is evidence"） |
| `ScreenCoordinateSpace` | `.globalTopLeft` / `.appkitBottomLeft` 两种坐标系 |
| `ScreenPoint` | 带 coordinateSpace 的点 |
| `PointerKind` | `move / drag / leftDown / leftUp / rightDown / rightUp / scroll` |
| `PointerSample` | 光标轨迹采样点 |
| `ApplicationContext` | `name / bundleIdentifier? / processIdentifier` |
| `WindowBounds` | 窗口几何 |
| `WindowContext` | `title / ownerName / processIdentifier / windowNumber? / bounds?` |
| `AccessibilityElementContext` | 光标下 AX 元素（role/subrole/title/valuePreview 等） |
| `ScreenshotContext` | 截图（base64、mediaType、维度、displayOrigin、sourceWindowNumber 等可选字段保持旧帧兼容） |
| `ContextFrame` | 顶点：`schemaVersion / frameId / capturedAt / expiresAt / cursor / pointerTrail / frontmostApplication? / activeWindow? / elementUnderCursor? / screenshots / warnings` |

## 关键函数

- `ContextFrame.init`：自动截断——`pointerTrail` 取后 240 条、`screenshots` 取前 4 张。
- `ContextFrame.validate(referenceDate:)`：fail-closed 校验，违反即抛错：
  - `unsupportedSchemaVersion`：schemaVersion 不匹配；
  - `invalidExpiry` / `expired`：有效期窗口非法或已过期（采集时 `expiresAt = capturedAt + 30s`）；
  - `invalidConfidence`：任何 confidence ∉ [0,1]；
  - `invalidScreenshot`：mediaType/base64/维度非法，或 `sourceWindowNumber` 为 0/负数。
- 自定义 `encode(to:)`：nil 字段编码为显式 `null`（而非省略），维持线协议稳定。

## 与 Clicky 的关系

`apps/clicky/leanring-buddy/YishuContextFrame.swift` 是**唯一兼容边界**：

```swift
import YishuContext
typealias YishuContextFrame = ContextFrame
typealias YishuObservedValue = ObservedValue
// …其余 Yishu* 前缀 typealias 同理
```

生产采集器 [YishuContextFrameCollector.swift](../../apps/clicky/leanring-buddy/YishuContextFrameCollector.swift) 把 ScreenCaptureKit、`NSEvent.mouseLocation`、`NSWorkspace.frontmostApplication`、AX API 的输出填入该契约并 `validate()`，失败则降级为无图 + warnings。

## 测试覆盖（YishuContextTests）

- `sourceWindowNumber = 0` 的截图被拒；
- legacy `WindowContext` / `ScreenshotContext`（缺新字段）仍可解码；
- 版本化 JSON round-trip（nil 字段编码为 NSNull）；
- 过期 frame 被拒、confidence 超界（1.1）被拒、非正维度截图被拒。
