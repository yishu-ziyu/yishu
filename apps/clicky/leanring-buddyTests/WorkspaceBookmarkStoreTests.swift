import Foundation
import Testing
@testable import Clicky

struct WorkspaceBookmarkStoreTests {
    @Test func addListRevokeUsesIsolatedDefaults() throws {
        let suiteName = "yishu.workspace.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("yishu-ws-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        #expect(WorkspaceBookmarkStore.list(defaults: defaults).isEmpty)
        let added = try WorkspaceBookmarkStore.add(
            displayName: "验收",
            url: dir,
            defaults: defaults
        )
        #expect(WorkspaceBookmarkStore.list(defaults: defaults).map(\.id) == [added.id])
        let resolved = try WorkspaceBookmarkStore.resolve(added)
        #expect(resolved.standardizedFileURL == dir.standardizedFileURL)

        let duplicate = try WorkspaceBookmarkStore.add(
            displayName: "验收",
            url: dir,
            defaults: defaults
        )
        #expect(duplicate.id == added.id)
        #expect(WorkspaceBookmarkStore.list(defaults: defaults).count == 1)

        let removed = WorkspaceBookmarkStore.revoke(id: added.id, defaults: defaults)
        #expect(removed?.id == added.id)
        #expect(WorkspaceBookmarkStore.list(defaults: defaults).isEmpty)
        #expect(WorkspaceBookmarkStore.revoke(id: added.id, defaults: defaults) == nil)
    }
}
