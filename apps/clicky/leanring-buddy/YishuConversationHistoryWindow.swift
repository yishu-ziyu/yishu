//
//  YishuConversationHistoryWindow.swift
//  leanring-buddy
//
//  On-demand conversation management window: full durable history list with
//  archive/restore and continue. The presence layer (cursor companion, task
//  chip) stays ephemeral; this window is the durable, look-back surface.
//  It is a regular SwiftUI window of the same App — no second identity.
//

import AppKit
import SwiftUI

@MainActor
final class YishuConversationHistoryWindowManager: NSObject, NSWindowDelegate {
    static let shared = YishuConversationHistoryWindowManager()

    private var window: NSWindow?

    func show(companionManager: CompanionManager) {
        if let window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            companionManager.refreshPersonalHistory()
            return
        }

        let contentView = YishuConversationHistoryView(
            companionManager: companionManager,
            onContinued: { [weak self] in self?.hide() }
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 640),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "会话历史"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(DS.Colors.background)
        window.contentView = NSHostingView(rootView: contentView)
        window.center()
        window.minSize = NSSize(width: 380, height: 420)
        window.setFrameAutosaveName("yishu.conversationHistory.window.v1")
        window.isReleasedWhenClosed = false
        window.delegate = self
        self.window = window

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        companionManager.refreshPersonalHistory()
    }

    func hide() {
        window?.orderOut(nil)
    }

    nonisolated func windowWillClose(_ notification: Notification) {
        Task { @MainActor in
            self.window = nil
        }
    }
}

struct YishuConversationHistoryView: View {
    @ObservedObject var companionManager: CompanionManager
    /// Called after a successful "continue this conversation" so the window
    /// steps back and the presence layer takes over.
    var onContinued: () -> Void

    @State private var isArchivedSectionExpanded = false
    @State private var detailItem: YishuHistoryListItem?

    private var activeItems: [YishuHistoryListItem] {
        companionManager.personalHistoryItems.filter { $0.status != "archived" }
    }

    private var archivedItems: [YishuHistoryListItem] {
        companionManager.personalHistoryItems.filter { $0.status == "archived" }
    }

    var body: some View {
        Group {
            if let detailItem {
                YishuHistoryDetailView(companionManager: companionManager, item: detailItem) {
                    self.detailItem = nil
                }
            } else {
                VStack(spacing: 0) {
                    header

                    Divider()
                        .background(DS.Colors.borderSubtle)

                    if let notice = companionManager.historyNotice {
                        Text(notice)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(DS.Colors.warningText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                            .background(DS.Colors.surface1)
                    }

                    content
                }
                .background(DS.Colors.background)
                .onAppear {
                    companionManager.refreshPersonalHistory()
                }
            }
        }
        .alert(
            "归档这段对话？",
            isPresented: deleteConfirmationBinding,
            presenting: companionManager.historyDeleteCandidate
        ) { _ in
            Button("归档", role: .destructive) {
                companionManager.confirmDeletePersonalHistory()
            }
            Button("取消", role: .cancel) {
                companionManager.cancelDeletePersonalHistory()
            }
        } message: { item in
            Text("「\(item.title)」会移入已归档，随时可以恢复。")
        }
        .alert(
            "恢复这段对话？",
            isPresented: restoreConfirmationBinding,
            presenting: companionManager.historyRestoreCandidate
        ) { _ in
            Button("恢复") {
                companionManager.confirmRestorePersonalHistory()
            }
            Button("取消", role: .cancel) {
                companionManager.cancelRestorePersonalHistory()
            }
        } message: { item in
            Text("「\(item.title)」会回到对话列表。")
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Text("会话历史")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(DS.Colors.textPrimary)

            Text("说过的事都记得，需要时再打开。")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(DS.Colors.textTertiary)
                .lineLimit(1)

            Spacer()

            Button(action: {
                companionManager.beginNewPersonalConversation()
            }) {
                HStack(spacing: 4) {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .semibold))
                    Text("新对话")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundColor(DS.Colors.textOnAccent)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Capsule().fill(DS.Colors.accent))
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel("开始新对话")
        }
        .padding(.horizontal, 16)
        .padding(.top, 44)
        .padding(.bottom, 12)
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if companionManager.personalHistoryLoading && companionManager.personalHistoryItems.isEmpty {
            Spacer()
            ProgressView()
                .controlSize(.small)
            Spacer()
        } else if companionManager.personalHistoryEmpty {
            emptyState
        } else {
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 0) {
                    if !activeItems.isEmpty {
                        sectionLabel("对话")
                        ForEach(activeItems) { item in
                            historyRow(item)
                            Divider()
                                .background(DS.Colors.borderSubtle.opacity(0.5))
                                .padding(.leading, 16)
                        }
                    }

                    if !archivedItems.isEmpty {
                        archivedSection
                    }

                    Spacer()
                        .frame(height: 16)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Spacer()
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 24, weight: .light))
                .foregroundColor(DS.Colors.textTertiary)
            Text("还没有对话历史")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(DS.Colors.textSecondary)
            Text("和奕枢说过的事会记在这里。")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(DS.Colors.textTertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(DS.Colors.textTertiary)
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 4)
    }

    // MARK: - Archived Section

    private var archivedSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: {
                withAnimation(.easeOut(duration: 0.15)) {
                    isArchivedSectionExpanded.toggle()
                }
            }) {
                HStack(spacing: 6) {
                    Image(systemName: isArchivedSectionExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(DS.Colors.textTertiary)
                    Text("已归档 · \(archivedItems.count)")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textTertiary)
                }
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 4)
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityElement(children: .combine)
            .accessibilityLabel("已归档")
            .accessibilityValue(isArchivedSectionExpanded ? "已展开" : "已收起")

            if isArchivedSectionExpanded {
                ForEach(archivedItems) { item in
                    historyRow(item)
                    Divider()
                        .background(DS.Colors.borderSubtle.opacity(0.5))
                        .padding(.leading, 16)
                }
            }
        }
    }

    // MARK: - Row

    private func historyRow(_ item: YishuHistoryListItem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.title.isEmpty ? "未命名对话" : item.title)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(DS.Colors.textPrimary)
                        .lineLimit(1)

                    if item.id == companionManager.currentConversationId {
                        Text("当前")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(DS.Colors.accentText)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(DS.Colors.accentSubtle))
                    }

                    Spacer(minLength: 0)

                    Text(Self.relativeTime(item.updatedAt))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(DS.Colors.textTertiary)
                }

                if !item.summary.isEmpty {
                    Text(item.summary)
                        .font(.system(size: 11, weight: .regular))
                        .foregroundColor(DS.Colors.textSecondary)
                        .lineLimit(2)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture {
                detailItem = item
            }
            .pointerCursor()

            VStack(alignment: .trailing, spacing: 4) {
                Button(action: {
                    companionManager.continuePersonalHistory(item) { succeeded in
                        if succeeded {
                            onContinued()
                        }
                    }
                }) {
                    Text("继续")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textOnAccent)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(DS.Colors.accent))
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .accessibilityLabel("继续这段对话")

                if item.status == "archived" {
                    Button(action: {
                        companionManager.requestRestorePersonalHistory(item)
                    }) {
                        Text("恢复")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(DS.Colors.textSecondary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(Capsule().stroke(DS.Colors.borderSubtle, lineWidth: 0.8))
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                    .accessibilityLabel("恢复这段对话")
                } else {
                    Button(action: {
                        companionManager.requestDeletePersonalHistory(item)
                    }) {
                        Text("归档")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(DS.Colors.textTertiary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(Capsule().stroke(DS.Colors.borderSubtle, lineWidth: 0.8))
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                    .accessibilityLabel("归档这段对话")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - Confirmation Bindings

    private var deleteConfirmationBinding: Binding<Bool> {
        Binding(
            get: { companionManager.historyDeleteCandidate != nil },
            set: { visible in
                if !visible {
                    companionManager.cancelDeletePersonalHistory()
                }
            }
        )
    }

    private var restoreConfirmationBinding: Binding<Bool> {
        Binding(
            get: { companionManager.historyRestoreCandidate != nil },
            set: { visible in
                if !visible {
                    companionManager.cancelRestorePersonalHistory()
                }
            }
        )
    }

    // MARK: - Relative Time

    private static func relativeTime(_ date: Date) -> String {
        if date == Date.distantPast { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        formatter.locale = Locale(identifier: "zh_CN")
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
