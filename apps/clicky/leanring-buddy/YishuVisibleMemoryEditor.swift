import SwiftUI

enum YishuVisibleMemoryEditorMetrics {
    /// Compact enough that "how to talk" stays the first job of the 320pt panel.
    static let editorHeight: CGFloat = 72
}

/// Shows the one memory file in the panel so the user can read and edit it.
struct YishuVisibleMemoryEditor: View {
    @StateObject private var draft: YishuVisibleMemoryDraft

    init(url: URL = YishuVisibleMemoryFile.fileURL) {
        _draft = StateObject(wrappedValue: YishuVisibleMemoryDraft(url: url))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("记忆")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(DS.Colors.textSecondary)

            TextEditor(text: $draft.text)
                .font(.system(size: 12))
                .foregroundColor(DS.Colors.textPrimary)
                .scrollContentBackground(.hidden)
                .padding(8)
                .frame(height: YishuVisibleMemoryEditorMetrics.editorHeight)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(DS.Colors.surface2)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(DS.Colors.borderSubtle, lineWidth: 1)
                )
                .accessibilityLabel("记忆")
                .onChange(of: draft.text) { _, _ in
                    draft.scheduleSave()
                }

            Text(draft.didFailSave ? "这次没有写下。" : "改完下次说话就会用。")
                .font(.system(size: 10))
                .foregroundColor(draft.didFailSave ? DS.Colors.warning : DS.Colors.textTertiary)
        }
        .onAppear { draft.reload() }
        .onDisappear { draft.flush() }
    }
}
