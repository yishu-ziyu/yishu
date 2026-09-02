import SwiftUI

/// Routine management surface inside the panel settings group: list with
/// enable toggle / run now / delete, plus a compact create form. Mirrors the
/// grok-bot routines panel, collapsed to the menu-bar form factor.
struct YishuRoutinesSection: View {
    @ObservedObject var companionManager: CompanionManager
    @State private var isCreateExpanded = false
    @State private var name = ""
    @State private var prompt = ""
    @State private var schedule = "0 9 * * 1-5"

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .frame(width: 16)
                Text("例程")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
                Spacer()
                Button(action: {
                    withAnimation(.easeOut(duration: 0.15)) { isCreateExpanded.toggle() }
                }) {
                    Text(isCreateExpanded ? "收起" : "新建")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.accent)
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }

            if let notice = companionManager.automationNotice {
                Text(notice)
                    .font(.system(size: 11))
                    .foregroundColor(DS.Colors.textTertiary)
            }

            if isCreateExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    TextField("名字，比如「早报」", text: $name)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                        .padding(6)
                        .background(RoundedRectangle(cornerRadius: 6).fill(DS.Colors.surface2))
                    TextField("每次要做什么", text: $prompt)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                        .padding(6)
                        .background(RoundedRectangle(cornerRadius: 6).fill(DS.Colors.surface2))
                    TextField("cron，比如 0 9 * * 1-5", text: $schedule)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12, design: .monospaced))
                        .padding(6)
                        .background(RoundedRectangle(cornerRadius: 6).fill(DS.Colors.surface2))
                    Button(action: create) {
                        Text("保存例程")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(DS.Colors.textOnAccent)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(Capsule().fill(DS.Colors.accent))
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || prompt.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }

            if companionManager.automationRecords.isEmpty {
                Text("还没有例程。例程是到点自动执行的长期指令。")
                    .font(.system(size: 11))
                    .foregroundColor(DS.Colors.textTertiary)
            } else {
                ForEach(companionManager.automationRecords) { record in
                    routineRow(record)
                }
            }
        }
        .onAppear { companionManager.refreshAutomations() }
    }

    private func routineRow(_ record: YishuAutomationRecord) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(record.name)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(DS.Colors.textPrimary)
                    Text(record.triggerDescription)
                        .font(.system(size: 10))
                        .foregroundColor(DS.Colors.textTertiary)
                    if let next = record.nextRunAt, record.isEnabled {
                        Text("下次 \(Self.relative(next))")
                            .font(.system(size: 10))
                            .foregroundColor(DS.Colors.textTertiary)
                    }
                }
                Spacer()
                Toggle("", isOn: Binding(
                    get: { record.isEnabled },
                    set: { companionManager.toggleAutomation(record, enabled: $0) }
                ))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
            }
            HStack(spacing: 8) {
                Button(action: { companionManager.runAutomationNow(record) }) {
                    Text("立即运行")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(DS.Colors.accent)
                }
                .buttonStyle(.plain)
                .pointerCursor()
                Button(action: { companionManager.deleteAutomation(record) }) {
                    Text("删除")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(DS.Colors.textTertiary)
                }
                .buttonStyle(.plain)
                .pointerCursor()
                if let last = record.runs.first {
                    Spacer()
                    Text(last.status == "ok" ? "上次成功" : "上次失败")
                        .font(.system(size: 10))
                        .foregroundColor(last.status == "ok" ? DS.Colors.success : DS.Colors.textTertiary)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func create() {
        companionManager.createAutomation(
            name: name.trimmingCharacters(in: .whitespaces),
            prompt: prompt.trimmingCharacters(in: .whitespaces),
            schedule: schedule.trimmingCharacters(in: .whitespaces)
        )
        name = ""
        prompt = ""
        isCreateExpanded = false
    }

    static func relative(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
