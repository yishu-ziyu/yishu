import Combine
import Foundation

/// In-panel draft of the one visible memory file. Writes back to that file.
@MainActor
final class YishuVisibleMemoryDraft: ObservableObject {
    @Published var text: String = ""
    @Published private(set) var didFailSave = false

    let url: URL
    private var lastWritten: String = ""
    private var saveTask: Task<Void, Never>?

    init(url: URL = YishuVisibleMemoryFile.fileURL) {
        self.url = url
    }

    func reload() {
        saveTask?.cancel()
        let loaded = YishuVisibleMemoryFile.readText(at: url)
        text = loaded
        lastWritten = loaded
        didFailSave = false
    }

    func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard let self, !Task.isCancelled else { return }
            self.flush()
        }
    }

    func flush() {
        saveTask?.cancel()
        if text == lastWritten { return }
        do {
            let current = YishuVisibleMemoryFile.readText(at: url)
            let merged = YishuVisibleMemoryMerge.apply(
                base: lastWritten,
                current: current,
                next: text
            )
            try YishuVisibleMemoryFile.writeText(merged, at: url)
            text = merged
            lastWritten = merged
            didFailSave = false
        } catch {
            didFailSave = true
        }
    }
}
