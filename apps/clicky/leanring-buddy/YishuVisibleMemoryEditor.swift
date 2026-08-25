import AppKit
import SwiftUI

enum YishuVisibleMemoryEditorMetrics {
    /// Compact enough that "how to talk" stays the first job of the 320pt panel.
    static let editorHeight: CGFloat = 72
}

/// Clean NSTextView wrapper: no system decorations, no scroll indicators,
/// no loading spinner, exact text-container insets.
private struct YishuMemoryTextEditor: NSViewRepresentable {
    @Binding var text: String

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.scrollerStyle = .overlay
        scrollView.drawsBackground = false
        scrollView.autohidesScrollers = true
        scrollView.verticalScrollElasticity = .automatic

        let textView = scrollView.documentView as! NSTextView
        textView.isRichText = false
        textView.drawsBackground = false
        textView.backgroundColor = .clear
        textView.font = NSFont.systemFont(ofSize: 12)
        textView.textColor = NSColor(DS.Colors.textPrimary)
        textView.textContainerInset = NSSize(width: 2, height: 2)
        textView.textContainer?.lineFragmentPadding = 0
        textView.isEditable = true
        textView.isSelectable = true
        textView.delegate = context.coordinator
        textView.string = text
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        if textView.string != text {
            textView.string = text
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        private let parent: YishuMemoryTextEditor

        init(_ parent: YishuMemoryTextEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }
    }
}

/// Shows the one memory file in the panel so the user can read and edit it.
struct YishuVisibleMemoryEditor: View {
    @StateObject private var draft: YishuVisibleMemoryDraft

    init(url: URL = YishuVisibleMemoryFile.fileURL) {
        _draft = StateObject(wrappedValue: YishuVisibleMemoryDraft(url: url))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "book.closed")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(DS.Colors.accent)
                Text("记忆")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(DS.Colors.textPrimary)
            }

            YishuMemoryTextEditor(text: $draft.text)
                .frame(height: YishuVisibleMemoryEditorMetrics.editorHeight)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(DS.Colors.surface2)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
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
