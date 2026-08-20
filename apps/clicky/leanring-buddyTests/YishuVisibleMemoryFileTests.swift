import Foundation
import Testing
@testable import Clicky

struct YishuVisibleMemoryFileTests {
    @Test func productPathIsTheOneDocumentsFile() {
        let url = YishuVisibleMemoryFile.resolvedFileURL(environment: [:])
        #expect(url.lastPathComponent == "记忆.md")
        #expect(url.path.contains("/Documents/Yishu/记忆.md"))
        #expect(!url.path.contains("/Documents/Yishu/Memory/"))
    }

    @Test func envOverrideUsesTheSameKeyAsTheKernel() {
        let overridden = YishuVisibleMemoryFile.resolvedFileURL(
            environment: [
                YishuVisibleMemoryFile.visibleMemoryFileEnvironmentKey: "~/tmp/yishu-override.md",
            ]
        )
        #expect(overridden.path.hasSuffix("/tmp/yishu-override.md"))
        #expect(!overridden.path.contains("/Documents/Yishu/记忆.md"))

        let blank = YishuVisibleMemoryFile.resolvedFileURL(
            environment: [YishuVisibleMemoryFile.visibleMemoryFileEnvironmentKey: "   "]
        )
        #expect(blank.path.contains("/Documents/Yishu/记忆.md"))
    }

    @Test func headerTellsTheUserTheyCanEdit() {
        let header = YishuVisibleMemoryFile.header
        #expect(header.contains("# 记忆"))
        #expect(header.contains("你可以直接改、删、加一行"))
        #expect(header.contains("- "))
        #expect(!header.contains("保存在"))
        #expect(!header.contains("我的"))
        #expect(!header.contains("项目"))
    }

    @Test func ensureCreatesHeaderOnlyOnce() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("yishu-visible-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("记忆.md")
        let first = YishuVisibleMemoryFile.ensureFile(at: url)
        try "user line\n".write(to: url, atomically: true, encoding: .utf8)
        _ = YishuVisibleMemoryFile.ensureFile(at: first)
        let text = try String(contentsOf: url, encoding: .utf8)
        #expect(text == "user line\n")
    }

    @Test func readWriteRoundTripIsTheSameFile() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("yishu-visible-io-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("记忆.md")
        try YishuVisibleMemoryFile.writeText("- 周末去爬山\n", at: url)
        #expect(YishuVisibleMemoryFile.readText(at: url) == "- 周末去爬山\n")
    }

    @Test @MainActor func panelDraftShowsFileAndWritesEditsBack() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("yishu-visible-draft-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("记忆.md")
        try YishuVisibleMemoryFile.writeText("- 邮箱是 a@b.com\n", at: url)

        let draft = YishuVisibleMemoryDraft(url: url)
        draft.reload()
        #expect(draft.text.contains("邮箱是 a@b.com"))

        draft.text = "- 喜欢编号列表\n"
        draft.flush()
        #expect(YishuVisibleMemoryFile.readText(at: url) == "- 喜欢编号列表\n")
        #expect(draft.didFailSave == false)
    }

    @Test func mergeKeepsAgentAppendAndHonorsUserDelete() {
        let header = YishuVisibleMemoryFile.header
        let base = header + "- 邮箱是 a@b.com\n- 喜欢爬山\n"
        let current = header + "- 邮箱是 a@b.com\n- 喜欢爬山\n- 周四把钥匙放在抽屉\n"
        let next = header + "- 喜欢爬山\n"
        let merged = YishuVisibleMemoryMerge.apply(base: base, current: current, next: next)
        #expect(merged.contains("喜欢爬山"))
        #expect(merged.contains("周四把钥匙放在抽屉"))
        #expect(!merged.contains("邮箱是"))
    }

    @Test @MainActor func stalePanelSaveDoesNotDropAnAgentAppend() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("yishu-visible-merge-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("记忆.md")
        let header = YishuVisibleMemoryFile.header
        try YishuVisibleMemoryFile.writeText(header + "- 邮箱是 a@b.com\n- 喜欢爬山\n", at: url)

        let draft = YishuVisibleMemoryDraft(url: url)
        draft.reload()
        try YishuVisibleMemoryFile.writeText(
            header + "- 邮箱是 a@b.com\n- 喜欢爬山\n- 周四把钥匙放在抽屉\n",
            at: url
        )
        draft.text = header + "- 喜欢爬山\n"
        draft.flush()

        let saved = YishuVisibleMemoryFile.readText(at: url)
        #expect(saved.contains("喜欢爬山"))
        #expect(saved.contains("周四把钥匙放在抽屉"))
        #expect(!saved.contains("邮箱是"))
        #expect(draft.didFailSave == false)
    }
}
