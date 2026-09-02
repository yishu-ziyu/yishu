//
//  YishuConversationHistoryDetail.swift
//  leanring-buddy
//
//  Detail page for one durable conversation: the visible turns plus the
//  delegated tasks that belonged to it. Read-only look-back surface.
//

import Combine
import SwiftUI

@MainActor
final class YishuHistoryDetailModel: ObservableObject {
    @Published var turns: [YishuHistoryVisibleTurn] = []
    @Published var tasks: [YishuDelegatedTaskPresenceEvent] = []
    @Published var loading = false
    @Published var notice: String?

    func load(item: YishuHistoryListItem, client: YishuAgentRuntimeClient) {
        loading = true
        notice = nil
        turns = []
        tasks = []
        Task {
            do {
                let result = try await client.openHistory(
                    conversationId: item.id,
                    scope: .personal
                )
                turns = result.turns
            } catch {
                notice = error.localizedDescription
                turns = []
            }
            tasks = (try? await client.listDelegatedTasks(mainConversationId: item.id)) ?? []
            loading = false
        }
    }
}

struct YishuHistoryDetailView: View {
    @ObservedObject var companionManager: CompanionManager
    let item: YishuHistoryListItem
    var onBack: () -> Void

    @StateObject private var model = YishuHistoryDetailModel()

    var body: some View {
        VStack(spacing: 0) {
            header

            Divider()
                .background(DS.Colors.borderSubtle)

            if let notice = model.notice {
                Text(notice)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(DS.Colors.warningText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(DS.Colors.surface1)
            }

            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 0) {
                    if model.loading {
                        ProgressView()
                            .controlSize(.small)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 48)
                    } else if model.turns.isEmpty {
                        Text("这段对话没有可展示的内容。")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(DS.Colors.textTertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 48)
                    } else {
                        sectionLabel("对话")
                        turnsSection

                        if !model.tasks.isEmpty {
                            sectionLabel("这段对话里的任务")
                            tasksSection
                        }
                    }

                    Spacer()
                        .frame(height: 16)
                }
            }
        }
        .background(DS.Colors.background)
        .onAppear {
            model.load(item: item, client: companionManager.yishuAgentRuntimeClient)
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 8) {
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(DS.Colors.textSecondary)
                    .frame(width: 24, height: 24)
                    .background(Circle().fill(DS.Colors.surface1))
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel("返回对话列表")

            Text(item.title.isEmpty ? "未命名对话" : item.title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(DS.Colors.textPrimary)
                .lineLimit(1)

            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.top, 44)
        .padding(.bottom, 12)
    }

    // MARK: - Turns

    private var turnsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(model.turns.enumerated()), id: \.offset) { _, turn in
                turnBlock(label: "你", text: turn.userInput)
                turnBlock(label: "奕枢", text: turn.assistantOutput)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
    }

    private func turnBlock(label: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(DS.Colors.textTertiary)

            Text(text)
                .font(.system(size: 12))
                .foregroundColor(DS.Colors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 8).fill(DS.Colors.surface1))
        }
    }

    // MARK: - Tasks

    private var tasksSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(model.tasks) { task in
                taskRow(task)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
    }

    private func taskRow(_ task: YishuDelegatedTaskPresenceEvent) -> some View {
        let mark = resultMark(for: task)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(task.title)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(DS.Colors.textPrimary)
                    .lineLimit(2)

                Text(mark.text)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(mark.color)

                Spacer(minLength: 0)
            }

            if let summary = task.summary, !summary.isEmpty {
                Text(summary)
                    .font(.system(size: 11, weight: .regular))
                    .foregroundColor(DS.Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(DS.Colors.surface1))
    }

    private func resultMark(for task: YishuDelegatedTaskPresenceEvent) -> (text: String, color: Color) {
        switch task.resultKind {
        case .succeeded, .completed:
            return ("已验证", DS.Colors.success)
        case .unverified:
            return ("未验证", DS.Colors.warningText)
        case .failed:
            return ("没做成", DS.Colors.destructiveText)
        case .cancelled:
            return ("已取消", DS.Colors.textTertiary)
        case nil:
            return ("进行中", DS.Colors.textSecondary)
        }
    }

    // MARK: - Section Label

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(DS.Colors.textTertiary)
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 4)
    }
}
