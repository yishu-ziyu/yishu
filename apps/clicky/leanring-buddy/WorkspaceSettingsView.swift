import AppKit
import SwiftUI

enum WorkspaceSettingsCopy {
    static let title = "文件夹工作区"
    static let add = "添加文件夹"
    static let revoke = "撤销"
    static let empty = "还没有文件夹。加上之后，我可以在里面查找和改文件。"
    static let pickMessage = "选择一个文件夹，奕枢可以在里面查找和改文件。"
    static let allowTrash = "允许移入废纸篓"
    static let trashCaption = "移入废纸篓要在这里确认一次，任务才不会卡住。"
    static let added = "已加上这个文件夹。"
    static let revoked = "已撤销。"
    static let pickCancelled = "没有选到文件夹。"
    static let failed = "这次没有改成。"
    static let runtimeDown = "后台还没接上，文件夹先记在这里。"
}

struct WorkspaceSettingsView: View {
    @State private var rows: [WorkspaceBookmarkRecord] = []
    @State private var notice: String?
    @State private var trashAllowed = false
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "folder")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .frame(width: 16)

                Text(WorkspaceSettingsCopy.title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)

                Spacer()

                Button(action: addFolder) {
                    Text(WorkspaceSettingsCopy.add)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textOnAccent)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 5)
                        .background(Capsule().fill(DS.Colors.accent))
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .pointerCursor()
                .accessibilityLabel(WorkspaceSettingsCopy.add)
            }

            if rows.isEmpty {
                Text(WorkspaceSettingsCopy.empty)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(spacing: 4) {
                    ForEach(rows) { record in
                        workspaceRow(record)
                    }
                }

                HStack {
                    HStack(spacing: 8) {
                        Image(systemName: "trash")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(DS.Colors.textTertiary)
                            .frame(width: 16)

                        Text(WorkspaceSettingsCopy.allowTrash)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(DS.Colors.textSecondary)
                    }

                    Spacer()

                    Toggle("", isOn: Binding(
                        get: { trashAllowed },
                        set: { setTrashAllowed($0) }
                    ))
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .tint(DS.Colors.accent)
                    .scaleEffect(0.8)
                    .disabled(busy)
                    .accessibilityLabel(WorkspaceSettingsCopy.allowTrash)
                }
                .padding(.vertical, 4)

                Text(WorkspaceSettingsCopy.trashCaption)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let notice {
                Text(notice)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, 4)
        .onAppear {
            refreshRows()
            Task { await ingestAndRefresh() }
        }
    }

    private func workspaceRow(_ record: WorkspaceBookmarkRecord) -> some View {
        HStack(spacing: 8) {
            Text(record.displayName)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(DS.Colors.textPrimary)
                .lineLimit(1)

            Spacer()

            Button(action: { revoke(record) }) {
                Text(WorkspaceSettingsCopy.revoke)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(DS.Colors.textSecondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(
                        Capsule().stroke(DS.Colors.borderSubtle, lineWidth: 0.8)
                    )
            }
            .buttonStyle(.plain)
            .disabled(busy)
            .pointerCursor()
            .accessibilityLabel("\(WorkspaceSettingsCopy.revoke) \(record.displayName)")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.white.opacity(0.03))
        )
    }

    private func refreshRows() {
        rows = WorkspaceBookmarkStore.list()
    }

    private func addFolder() {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = WorkspaceSettingsCopy.add
        panel.message = WorkspaceSettingsCopy.pickMessage
        guard panel.runModal() == .OK, let url = panel.url else {
            notice = WorkspaceSettingsCopy.pickCancelled
            return
        }
        let name = url.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = name.isEmpty ? WorkspaceSettingsCopy.title : name
        do {
            let record = try WorkspaceBookmarkStore.add(displayName: displayName, url: url)
            refreshRows()
            busy = true
            Task {
                defer { busy = false }
                guard let client = YishuAgentRuntimeClient.active,
                      let id = UUID(uuidString: record.id) else {
                    notice = WorkspaceSettingsCopy.runtimeDown
                    return
                }
                do {
                    _ = try await client.grantWorkspace(
                        id: id,
                        displayName: record.displayName,
                        rootPath: url.path
                    )
                    if trashAllowed {
                        _ = try? await client.approveWorkspaceTrash(id: id, allowed: true)
                    }
                    notice = WorkspaceSettingsCopy.added
                } catch {
                    notice = error.localizedDescription
                }
            }
        } catch {
            notice = WorkspaceSettingsCopy.failed
        }
    }

    private func revoke(_ record: WorkspaceBookmarkRecord) {
        busy = true
        Task {
            defer { busy = false }
            if let client = YishuAgentRuntimeClient.active,
               let id = UUID(uuidString: record.id) {
                _ = try? await client.revokeWorkspace(id: id)
            }
            WorkspaceBookmarkStore.revoke(id: record.id)
            refreshRows()
            notice = WorkspaceSettingsCopy.revoked
        }
    }

    private func setTrashAllowed(_ allowed: Bool) {
        trashAllowed = allowed
        busy = true
        Task {
            defer { busy = false }
            guard let client = YishuAgentRuntimeClient.active else { return }
            for record in rows {
                guard let id = UUID(uuidString: record.id) else { continue }
                _ = try? await client.approveWorkspaceTrash(id: id, allowed: allowed)
            }
        }
    }

    private func ingestAndRefresh() async {
        refreshRows()
        guard let client = YishuAgentRuntimeClient.active else { return }
        await WorkspaceGrantSync.pushActiveGrants(using: client)
        if trashAllowed {
            for record in rows {
                guard let id = UUID(uuidString: record.id) else { continue }
                _ = try? await client.approveWorkspaceTrash(id: id, allowed: true)
            }
        }
    }
}
