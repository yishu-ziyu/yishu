import Foundation

struct WorkspaceBookmarkRecord: Codable, Identifiable, Equatable {
    var id: String
    var displayName: String
    var bookmark: Data
    var createdAt: Date
}

enum WorkspaceBookmarkStore {
    private static let key = "yishu.workspace.bookmarks"

    static func list(defaults: UserDefaults = .standard) -> [WorkspaceBookmarkRecord] {
        guard let data = defaults.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([WorkspaceBookmarkRecord].self, from: data)) ?? []
    }

    static func add(
        displayName: String,
        url: URL,
        defaults: UserDefaults = .standard
    ) throws -> WorkspaceBookmarkRecord {
        let standardized = url.standardizedFileURL
        var rows = list(defaults: defaults)
        for existing in rows {
            if let existingURL = try? resolve(existing),
               existingURL.standardizedFileURL == standardized {
                return existing
            }
        }
        let bookmark = try url.bookmarkData(
            options: [.withSecurityScope],
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        let record = WorkspaceBookmarkRecord(
            id: UUID().uuidString,
            displayName: displayName,
            bookmark: bookmark,
            createdAt: Date()
        )
        rows.append(record)
        defaults.set(try JSONEncoder().encode(rows), forKey: key)
        return record
    }

    @discardableResult
    static func revoke(id: String, defaults: UserDefaults = .standard) -> WorkspaceBookmarkRecord? {
        var rows = list(defaults: defaults)
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return nil }
        let removed = rows.remove(at: index)
        defaults.set(try? JSONEncoder().encode(rows), forKey: key)
        return removed
    }

    static func resolve(_ record: WorkspaceBookmarkRecord) throws -> URL {
        var stale = false
        let url = try URL(
            resolvingBookmarkData: record.bookmark,
            options: [.withSecurityScope],
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        )
        _ = url.startAccessingSecurityScopedResource()
        return url
    }
}

enum WorkspaceGrantSync {
    /// Re-ingest local bookmarks into the in-memory kernel ledger after sidecar ready.
    static func pushActiveGrants(using client: YishuAgentRuntimeClient) async {
        for record in WorkspaceBookmarkStore.list() {
            guard let id = UUID(uuidString: record.id),
                  let url = try? WorkspaceBookmarkStore.resolve(record) else { continue }
            _ = try? await client.grantWorkspace(
                id: id,
                displayName: record.displayName,
                rootPath: url.path
            )
        }
    }
}
