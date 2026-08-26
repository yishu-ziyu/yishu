import Foundation

struct WorkspaceBookmarkRecord: Codable, Identifiable {
    var id: String
    var displayName: String
    var bookmark: Data
    var createdAt: Date
}

enum WorkspaceBookmarkStore {
    private static let key = "yishu.workspace.bookmarks"

    static func list() -> [WorkspaceBookmarkRecord] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([WorkspaceBookmarkRecord].self, from: data)) ?? []
    }

    static func add(displayName: String, url: URL) throws -> WorkspaceBookmarkRecord {
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
        var rows = list()
        rows.append(record)
        UserDefaults.standard.set(try JSONEncoder().encode(rows), forKey: key)
        return record
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
