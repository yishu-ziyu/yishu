//
//  AgentPresence.swift
//  leanring-buddy
//
//  A visible projection of delegated TaskTruth. Runtime events own every
//  status; this file only owns presentation lifecycle such as open/seen.
//

import AppKit
import Combine
import SwiftUI

enum YishuDelegatedTaskStatus: String, Equatable {
    case running
    case blocked
    case done
    case failed
    case cancelled
}

enum YishuDelegatedResultKind: String, Equatable {
    case succeeded
    case completed
    case unverified
    case failed
    case cancelled
}

struct YishuDelegatedTaskPresenceEvent: Identifiable, Equatable {
    let id: UUID
    let parentId: UUID
    let mainConversationId: UUID
    let title: String
    let status: YishuDelegatedTaskStatus
    let createdAt: Date
    let updatedAt: Date
    let provider: String?
    let model: String?
    let resultKind: YishuDelegatedResultKind?
    let summary: String?

    var workerLabel: String {
        guard let model else { return "Research" }
        let name: String
        switch model {
        case "gpt-5.6-terra": name = "Terra"
        case "gpt-5.6-luna": name = "Luna"
        case "gpt-5.6-sol": name = "Sol"
        case "grok-4.5": name = "Grok 4.5"
        default:
            name = model
                .replacingOccurrences(of: "gpt-", with: "GPT ")
                .replacingOccurrences(of: "-", with: " ")
                .capitalized
        }
        return "Research · \(name)"
    }

    var statusLabel: String {
        switch status {
        case .running: return "正在研究"
        case .blocked: return "需要确认"
        case .done: return "结果已就绪"
        case .failed: return "未完成"
        case .cancelled: return "已停止"
        }
    }

    @MainActor
    static func decode(_ raw: [String: Any]) -> Self? {
        guard raw["type"] as? String == "task.presence.updated",
              YishuAgentRuntimeClient.isValidSchemaVersionValue(raw["schemaVersion"]),
              (raw["eventId"] as? String).flatMap(UUID.init(uuidString:)) != nil,
              (raw["requestId"] as? String).flatMap(UUID.init(uuidString:)) != nil,
              (raw["traceId"] as? String).flatMap(UUID.init(uuidString:)) != nil,
              let envelopeConversationId = (raw["conversationId"] as? String)
                .flatMap(UUID.init(uuidString:)),
              let payload = raw["payload"] as? [String: Any],
              let taskId = (payload["taskId"] as? String).flatMap(UUID.init(uuidString:)),
              let parentId = (payload["parentId"] as? String).flatMap(UUID.init(uuidString:)),
              let mainConversationId = (payload["mainConversationId"] as? String)
                .flatMap(UUID.init(uuidString:)),
              mainConversationId == envelopeConversationId,
              let rawTitle = payload["title"] as? String,
              let statusRaw = payload["status"] as? String,
              let status = YishuDelegatedTaskStatus(rawValue: statusRaw),
              let createdAt = parseISO8601(payload["createdAt"] as? String),
              let updatedAt = parseISO8601(payload["updatedAt"] as? String),
              updatedAt >= createdAt else {
            return nil
        }

        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...160).contains(title.count) else { return nil }

        let provider = boundedOptionalString(payload["provider"], maximum: 120)
        let model = boundedOptionalString(payload["model"], maximum: 120)
        guard (payload["provider"] == nil || provider != nil),
              (payload["model"] == nil || model != nil) else {
            return nil
        }

        let resultKind = (payload["resultKind"] as? String)
            .flatMap(YishuDelegatedResultKind.init(rawValue:))
        let summary = boundedOptionalString(payload["summary"], maximum: 500)
        let isTerminal = status != .running
        guard (provider == nil) == (model == nil),
              isTerminal == (resultKind != nil && summary != nil),
              resultMatchesStatus(resultKind, status: status) else {
            return nil
        }

        return Self(
            id: taskId,
            parentId: parentId,
            mainConversationId: mainConversationId,
            title: title,
            status: status,
            createdAt: createdAt,
            updatedAt: updatedAt,
            provider: provider,
            model: model,
            resultKind: resultKind,
            summary: summary
        )
    }

    private static func boundedOptionalString(_ value: Any?, maximum: Int) -> String? {
        guard let value else { return nil }
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...maximum).contains(trimmed.count) else { return nil }
        return trimmed
    }

    private static func parseISO8601(_ value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }

    private static func resultMatchesStatus(
        _ result: YishuDelegatedResultKind?,
        status: YishuDelegatedTaskStatus
    ) -> Bool {
        switch status {
        case .running: return result == nil
        case .done: return result == .succeeded || result == .completed
        case .blocked: return result == .unverified
        case .failed: return result == .failed
        case .cancelled: return result == .cancelled
        }
    }
}

@MainActor
final class AgentPresenceViewModel: ObservableObject {
    @Published private(set) var tasks: [YishuDelegatedTaskPresenceEvent] = []

    var hasTasks: Bool { !tasks.isEmpty }

    func apply(_ event: YishuDelegatedTaskPresenceEvent) {
        if let index = tasks.firstIndex(where: { $0.id == event.id }) {
            guard event.updatedAt >= tasks[index].updatedAt else { return }
            tasks[index] = event
        } else {
            tasks.append(event)
        }
        tasks.sort { $0.createdAt > $1.createdAt }
    }

    func acknowledge(_ taskId: UUID) {
        tasks.removeAll { $0.id == taskId }
    }

    func reset() {
        tasks.removeAll()
    }
}

private final class AgentPresencePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class AgentPresenceWindowManager: NSObject {
    let viewModel = AgentPresenceViewModel()

    var onCancelTask: ((YishuDelegatedTaskPresenceEvent) -> Void)?
    var onPresentResult: ((YishuDelegatedTaskPresenceEvent) -> Void)?

    private var anchorPoint: NSPoint?
    private var anchorPanel: NSPanel?
    private var pocketPanel: NSPanel?
    private var labelPanel: NSPanel?
    private var satellitePanels: [UUID: NSPanel] = [:]
    private var tasksCancellable: AnyCancellable?
    private var outsideClickMonitor: Any?
    private var labelHideWorkItem: DispatchWorkItem?

    override init() {
        super.init()
        tasksCancellable = viewModel.$tasks
            .receive(on: RunLoop.main)
            .sink { [weak self] tasks in
                self?.synchronizeWindows(with: tasks)
            }
    }

    deinit {
        if let outsideClickMonitor { NSEvent.removeMonitor(outsideClickMonitor) }
    }

    func apply(_ event: YishuDelegatedTaskPresenceEvent) {
        viewModel.apply(event)
    }

    func stop() {
        viewModel.reset()
        hidePocket()
        hideLabel()
        anchorPanel?.orderOut(nil)
        anchorPanel = nil
        satellitePanels.values.forEach { $0.orderOut(nil) }
        satellitePanels.removeAll()
        anchorPoint = nil
    }

    private func synchronizeWindows(with tasks: [YishuDelegatedTaskPresenceEvent]) {
        guard !tasks.isEmpty else {
            returnSatellitesAndHideAnchor()
            return
        }
        if anchorPoint == nil { anchorPoint = makeAnchorPoint() }
        showAnchor(taskCount: tasks.count)

        let visibleTasks = Array(tasks.prefix(3))
        let visibleIDs = Set(visibleTasks.map(\.id))
        let removedIDs = satellitePanels.keys.filter { !visibleIDs.contains($0) }
        for taskId in removedIDs {
            guard let panel = satellitePanels.removeValue(forKey: taskId) else { continue }
            animateSatelliteHome(panel)
        }
        for (index, task) in visibleTasks.enumerated() {
            showSatellite(for: task, index: index)
        }
        if pocketPanel?.isVisible == true { showPocket() }
    }

    private func showAnchor(taskCount: Int) {
        guard let anchorPoint else { return }
        let size = CGSize(width: 46, height: 46)
        let panel = anchorPanel ?? makePanel(size: size)
        panel.contentView = hostingView(
            AgentPresenceAnchorButton(taskCount: taskCount) { [weak self] in
                self?.togglePocket()
            },
            size: size
        )
        panel.setFrameOrigin(NSPoint(x: anchorPoint.x - size.width / 2, y: anchorPoint.y - size.height / 2))
        if anchorPanel == nil {
            anchorPanel = panel
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                panel.animator().alphaValue = 1
            }
        }
    }

    private func showSatellite(for task: YishuDelegatedTaskPresenceEvent, index: Int) {
        guard let anchorPoint else { return }
        let size = CGSize(width: 34, height: 34)
        let destination = satelliteCenter(index: index, around: anchorPoint)
        let isNew = satellitePanels[task.id] == nil
        let panel = satellitePanels[task.id] ?? makePanel(size: size)
        panel.contentView = hostingView(
            AgentPresenceSatelliteButton(
                task: task,
                onOpen: { [weak self] in self?.showPocket(selecting: task.id) },
                onHover: { [weak self] hovering in
                    self?.handleSatelliteHover(hovering, task: task, center: destination)
                }
            ),
            size: size
        )

        if isNew {
            satellitePanels[task.id] = panel
            panel.setFrameOrigin(NSPoint(x: anchorPoint.x - size.width / 2, y: anchorPoint.y - size.height / 2))
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.48
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().setFrameOrigin(
                    NSPoint(x: destination.x - size.width / 2, y: destination.y - size.height / 2)
                )
                panel.animator().alphaValue = 1
            }
            showLabel(for: task, near: destination, autoHideAfter: 1.8)
        } else {
            panel.setFrameOrigin(NSPoint(x: destination.x - size.width / 2, y: destination.y - size.height / 2))
        }
    }

    private func togglePocket() {
        pocketPanel?.isVisible == true ? hidePocket() : showPocket()
    }

    private func showPocket(selecting _: UUID? = nil) {
        guard let anchorPoint else { return }
        let tasks = viewModel.tasks
        let width: CGFloat = 326
        let height = min(CGFloat(66 + tasks.count * 92), 386)
        let size = CGSize(width: width, height: max(height, 138))
        let panel = pocketPanel ?? makePanel(size: size)
        panel.contentView = hostingView(
            AgentPresencePocketView(
                viewModel: viewModel,
                onClose: { [weak self] in self?.hidePocket() },
                onCancel: { [weak self] task in self?.onCancelTask?(task) },
                onResult: { [weak self] task in
                    guard let self else { return }
                    self.onPresentResult?(task)
                    self.viewModel.acknowledge(task.id)
                }
            ),
            size: size
        )
        panel.setContentSize(size)
        panel.setFrameOrigin(pocketOrigin(size: size, anchor: anchorPoint))
        let wasVisible = panel.isVisible
        pocketPanel = panel
        if !wasVisible {
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            panel.makeKey()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.16
                panel.animator().alphaValue = 1
            }
        }
        installOutsideClickMonitor()
    }

    private func hidePocket() {
        pocketPanel?.orderOut(nil)
        removeOutsideClickMonitor()
    }

    private func returnSatellitesAndHideAnchor() {
        hidePocket()
        guard anchorPoint != nil else { return }
        for panel in satellitePanels.values { animateSatelliteHome(panel) }
        satellitePanels.removeAll()
        let anchorPanel = self.anchorPanel
        self.anchorPanel = nil
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.22
            anchorPanel?.animator().alphaValue = 0
        }, completionHandler: {
            anchorPanel?.orderOut(nil)
        })
        self.anchorPoint = nil
    }

    private func animateSatelliteHome(_ panel: NSPanel) {
        guard let anchorPoint else {
            panel.orderOut(nil)
            return
        }
        let size = panel.frame.size
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.28
            panel.animator().setFrameOrigin(
                NSPoint(x: anchorPoint.x - size.width / 2, y: anchorPoint.y - size.height / 2)
            )
            panel.animator().alphaValue = 0
        }, completionHandler: {
            panel.orderOut(nil)
        })
    }

    private func handleSatelliteHover(
        _ hovering: Bool,
        task: YishuDelegatedTaskPresenceEvent,
        center: NSPoint
    ) {
        if hovering {
            showLabel(for: task, near: center, autoHideAfter: nil)
        } else {
            showLabel(for: task, near: center, autoHideAfter: 0.18)
        }
    }

    private func showLabel(
        for task: YishuDelegatedTaskPresenceEvent,
        near center: NSPoint,
        autoHideAfter delay: TimeInterval?
    ) {
        labelHideWorkItem?.cancel()
        let size = CGSize(width: 190, height: 30)
        let panel = labelPanel ?? makePanel(size: size, ignoresMouseEvents: true)
        panel.contentView = hostingView(AgentPresenceLabel(text: task.workerLabel), size: size)
        panel.setFrameOrigin(NSPoint(x: center.x - size.width / 2, y: center.y + 22))
        labelPanel = panel
        panel.alphaValue = 1
        panel.orderFrontRegardless()
        if let delay {
            let work = DispatchWorkItem { [weak self] in self?.hideLabel() }
            labelHideWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        }
    }

    private func hideLabel() {
        labelHideWorkItem?.cancel()
        labelHideWorkItem = nil
        labelPanel?.orderOut(nil)
    }

    private func makeAnchorPoint() -> NSPoint {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main
        let frame = screen?.visibleFrame ?? .zero
        let proposed = NSPoint(x: mouse.x + 35, y: mouse.y - 25)
        return NSPoint(
            x: min(max(proposed.x, frame.minX + 32), frame.maxX - 32),
            y: min(max(proposed.y, frame.minY + 32), frame.maxY - 32)
        )
    }

    private func satelliteCenter(index: Int, around anchor: NSPoint) -> NSPoint {
        let screen = NSScreen.screens.first(where: { $0.frame.contains(anchor) }) ?? NSScreen.main
        let frame = screen?.visibleFrame ?? .zero
        let right = anchor.x + 105 < frame.maxX ? CGFloat(1) : -1
        let up = anchor.y + 90 < frame.maxY ? CGFloat(1) : -1
        let offsets = [CGPoint(x: 38, y: 42), CGPoint(x: 72, y: 25), CGPoint(x: 88, y: -9)]
        let offset = offsets[min(index, offsets.count - 1)]
        return NSPoint(x: anchor.x + offset.x * right, y: anchor.y + offset.y * up)
    }

    private func pocketOrigin(size: CGSize, anchor: NSPoint) -> NSPoint {
        let screen = NSScreen.screens.first(where: { $0.frame.contains(anchor) }) ?? NSScreen.main
        let frame = screen?.visibleFrame ?? .zero
        let preferredX = anchor.x - size.width + 22
        let preferredY = anchor.y + 34
        return NSPoint(
            x: min(max(preferredX, frame.minX + 10), frame.maxX - size.width - 10),
            y: min(max(preferredY, frame.minY + 10), frame.maxY - size.height - 10)
        )
    }

    private func makePanel(size: CGSize, ignoresMouseEvents: Bool = false) -> NSPanel {
        let panel = AgentPresencePanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1)
        panel.isFloatingPanel = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isExcludedFromWindowsMenu = true
        panel.ignoresMouseEvents = ignoresMouseEvents
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        return panel
    }

    private func hostingView<Content: View>(_ root: Content, size: CGSize) -> NSHostingView<Content> {
        let hosting = NSHostingView(rootView: root)
        hosting.frame = NSRect(origin: .zero, size: size)
        hosting.wantsLayer = true
        hosting.layer?.backgroundColor = .clear
        return hosting
    }

    private func installOutsideClickMonitor() {
        removeOutsideClickMonitor()
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) {
            [weak self] _ in
            guard let self, let pocketPanel, pocketPanel.isVisible else { return }
            let point = NSEvent.mouseLocation
            if pocketPanel.frame.contains(point) || self.anchorPanel?.frame.contains(point) == true {
                return
            }
            self.hidePocket()
        }
    }

    private func removeOutsideClickMonitor() {
        if let outsideClickMonitor {
            NSEvent.removeMonitor(outsideClickMonitor)
            self.outsideClickMonitor = nil
        }
    }
}

private struct AgentPresenceAnchorButton: View {
    let taskCount: Int
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Circle()
                    .fill(DS.Colors.overlayCursorBlue.opacity(hovered ? 0.20 : 0.10))
                    .frame(width: 38, height: 38)
                    .blur(radius: hovered ? 1 : 3)
                Triangle()
                    .fill(
                        LinearGradient(
                            colors: [Color.white.opacity(0.92), DS.Colors.overlayCursorBlue],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 18, height: 18)
                    .rotationEffect(.degrees(-35))
                    .shadow(color: DS.Colors.overlayCursorBlue.opacity(0.8), radius: hovered ? 9 : 6)
                if taskCount > 1 {
                    Text("\(taskCount)")
                        .font(.system(size: 9, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                        .frame(width: 16, height: 16)
                        .background(DS.Colors.overlaySpectralViolet, in: Circle())
                        .offset(x: 3, y: -2)
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .scaleEffect(hovered ? 1.06 : 1)
        .animation(.easeOut(duration: 0.16), value: hovered)
        .help("管理后台任务")
        .accessibilityLabel("管理后台任务，\(taskCount) 项")
    }
}

private struct AgentPresenceSatelliteButton: View {
    let task: YishuDelegatedTaskPresenceEvent
    let onOpen: () -> Void
    let onHover: (Bool) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    var body: some View {
        Button(action: onOpen) {
            Triangle()
                .fill(fillColor)
                .frame(width: 14, height: 14)
                .rotationEffect(.degrees(-35))
                .scaleEffect(breathing ? activeScale : 0.94)
                .shadow(color: glowColor, radius: breathing ? 8 : 4)
                .frame(width: 32, height: 32)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover(perform: onHover)
        .onAppear {
            guard !reduceMotion else { breathing = true; return }
            withAnimation(.easeInOut(duration: pulseDuration).repeatForever(autoreverses: true)) {
                breathing = true
            }
        }
        .help("\(task.title) · \(task.statusLabel)")
        .accessibilityLabel("\(task.title)，\(task.statusLabel)")
    }

    private var activeScale: CGFloat { task.status == .done ? 1.12 : 1.04 }
    private var pulseDuration: Double { task.status == .done ? 0.72 : 1.2 }
    private var glowColor: Color {
        switch task.status {
        case .running, .done: return DS.Colors.overlayCursorBlue.opacity(0.82)
        case .blocked: return DS.Colors.overlaySpectralAmber.opacity(0.72)
        case .failed: return Color.red.opacity(0.58)
        case .cancelled: return Color.gray.opacity(0.35)
        }
    }
    private var fillColor: Color {
        switch task.status {
        case .running: return DS.Colors.overlayCursorBlue
        case .done: return Color.white
        case .blocked: return DS.Colors.overlaySpectralAmber
        case .failed: return Color.red.opacity(0.86)
        case .cancelled: return Color.gray.opacity(0.68)
        }
    }
}

private struct AgentPresenceLabel: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .medium, design: .rounded))
            .foregroundStyle(DS.Colors.overlayResponseInk.opacity(0.82))
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.72), lineWidth: 0.7))
            .shadow(color: Color.black.opacity(0.12), radius: 10, y: 4)
    }
}

private struct AgentPresencePocketView: View {
    @ObservedObject var viewModel: AgentPresenceViewModel
    let onClose: () -> Void
    let onCancel: (YishuDelegatedTaskPresenceEvent) -> Void
    let onResult: (YishuDelegatedTaskPresenceEvent) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("后台任务")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                Text("\(viewModel.tasks.count)")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundStyle(DS.Colors.overlayCursorBlue)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(DS.Colors.overlayCursorBlue.opacity(0.10), in: Capsule())
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .frame(width: 26, height: 26)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(DS.Colors.overlayResponseInk.opacity(0.56))
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 12)

            Divider().opacity(0.42)

            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(viewModel.tasks) { task in
                        AgentPresenceTaskRow(task: task, onCancel: onCancel, onResult: onResult)
                    }
                }
                .padding(10)
            }
            .scrollIndicators(.hidden)
        }
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 20, style: .continuous).fill(.ultraThinMaterial)
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(DS.Colors.overlayResponsePearl.opacity(0.90))
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [Color.white, DS.Colors.overlayCursorBlue.opacity(0.32)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 0.8
                    )
            }
            .shadow(color: Color.black.opacity(0.16), radius: 22, y: 9)
        }
        .padding(10)
    }
}

private struct AgentPresenceTaskRow: View {
    let task: YishuDelegatedTaskPresenceEvent
    let onCancel: (YishuDelegatedTaskPresenceEvent) -> Void
    let onResult: (YishuDelegatedTaskPresenceEvent) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 9) {
                Triangle()
                    .fill(DS.Colors.overlayCursorBlue)
                    .frame(width: 13, height: 13)
                    .rotationEffect(.degrees(-35))
                    .padding(.top, 3)
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.title)
                        .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                        .foregroundStyle(DS.Colors.overlayResponseInk)
                        .lineLimit(2)
                    Text(task.workerLabel)
                        .font(.system(size: 10.5, weight: .medium, design: .rounded))
                        .foregroundStyle(DS.Colors.overlayResponseInk.opacity(0.52))
                }
                Spacer(minLength: 4)
            }

            HStack(spacing: 7) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 6, height: 6)
                    .shadow(color: statusColor.opacity(0.48), radius: 4)
                Text(task.statusLabel)
                    .font(.system(size: 10.5, weight: .medium, design: .rounded))
                    .foregroundStyle(DS.Colors.overlayResponseInk.opacity(0.62))
                Spacer()
                Button(action: { task.status == .running ? onCancel(task) : onResult(task) }) {
                    Text(actionLabel)
                        .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(buttonTint.opacity(0.10), in: Capsule())
                        .overlay(Capsule().strokeBorder(buttonTint.opacity(0.24), lineWidth: 0.7))
                }
                .buttonStyle(.plain)
                .foregroundStyle(buttonTint)
            }
        }
        .padding(11)
        .background(Color.white.opacity(0.58), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(DS.Colors.overlayCursorBlue.opacity(0.10), lineWidth: 0.6)
        )
    }

    private var actionLabel: String {
        switch task.status {
        case .running: return "停止"
        case .done, .blocked: return "查看结果"
        case .failed, .cancelled: return "查看详情"
        }
    }
    private var buttonTint: Color { task.status == .running ? .red.opacity(0.78) : DS.Colors.overlayCursorBlue }
    private var statusColor: Color {
        switch task.status {
        case .running, .done: return DS.Colors.overlayCursorBlue
        case .blocked: return DS.Colors.overlaySpectralAmber
        case .failed: return .red.opacity(0.78)
        case .cancelled: return .gray
        }
    }
}
