import ApplicationServices
import Foundation

enum YishuDownloadsFileResolver {
    enum Failure: Error, Equatable, Sendable {
        case invalidName
        case notFound
        case ambiguous
        case unreadable
        case outsideDownloads
    }

    static func isExactBasename(_ fileName: String) -> Bool {
        guard fileName == fileName.trimmingCharacters(in: .whitespacesAndNewlines),
              !fileName.isEmpty,
              fileName != ".",
              fileName != "..",
              fileName.count <= 255,
              fileName.rangeOfCharacter(from: CharacterSet(charactersIn: "/\\").union(.controlCharacters)) == nil,
              !fileName.contains("\u{7f}") else {
            return false
        }
        let lastDot = fileName.lastIndex(of: ".")
        guard let lastDot, lastDot > fileName.startIndex else { return false }
        return fileName.index(after: lastDot) < fileName.endIndex
    }

    static func resolve(fileName: String, downloadsDirectory: URL) -> Result<URL, Failure> {
        guard isExactBasename(fileName) else { return .failure(.invalidName) }
        let root = downloadsDirectory.standardizedFileURL
        let entries: [URL]
        do {
            entries = try FileManager.default.contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey],
                options: []
            )
        } catch {
            return .failure(.unreadable)
        }
        let matches = entries.filter { $0.lastPathComponent == fileName }
        if matches.isEmpty { return .failure(.notFound) }
        if matches.count > 1 { return .failure(.ambiguous) }
        let url = matches[0]
        let values: URLResourceValues
        do {
            values = try url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey])
        } catch {
            return .failure(.unreadable)
        }
        if values.isDirectory == true && values.isSymbolicLink != true {
            return .failure(.unreadable)
        }
        let resolved = url.standardizedFileURL.resolvingSymlinksInPath()
        let resolvedRoot = root.resolvingSymlinksInPath()
        guard isInsideDownloads(resolved, root: resolvedRoot) else {
            return .failure(.outsideDownloads)
        }
        let resolvedValues: URLResourceValues
        do {
            resolvedValues = try resolved.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey])
        } catch {
            return .failure(.unreadable)
        }
        guard resolvedValues.isRegularFile == true, resolvedValues.isDirectory != true else {
            return .failure(.unreadable)
        }
        guard FileManager.default.isReadableFile(atPath: resolved.path) else {
            return .failure(.unreadable)
        }
        return .success(resolved)
    }

    private static func isInsideDownloads(_ url: URL, root: URL) -> Bool {
        let path = url.path
        let rootPath = root.path
        return path == rootPath || path.hasPrefix(rootPath.hasSuffix("/") ? rootPath : rootPath + "/")
    }
}

enum YishuFileDropReadBack {
    static let budgetNanoseconds: UInt64 = 1_000_000_000
    static let pollNanoseconds: UInt64 = 100_000_000

    static func exactBasenameCount(_ basename: String, in texts: [String]) -> Int {
        texts.reduce(into: 0) { count, text in
            if text.trimmingCharacters(in: .whitespacesAndNewlines) == basename {
                count += 1
            }
        }
    }

    static func containsExactBasename(_ basename: String, in texts: [String]) -> Bool {
        exactBasenameCount(basename, in: texts) > 0
    }

    static func isUploadDropLabel(title: String?, description: String?) -> Bool {
        let haystack = [title, description]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .lowercased()
        guard !haystack.isEmpty else { return false }
        return ["上传", "拖放", "附件", "文件", "upload", "drop", "attach"].contains { haystack.contains($0) }
    }

    static func waitForBasenameCountIncrease(
        _ fileName: String,
        baseline: Int,
        budgetNanoseconds: UInt64,
        names: () async -> [String]
    ) async -> Bool {
        let started = DispatchTime.now().uptimeNanoseconds
        while true {
            if exactBasenameCount(fileName, in: await names()) > baseline {
                return true
            }
            let elapsed = DispatchTime.now().uptimeNanoseconds &- started
            guard elapsed < budgetNanoseconds else { return false }
            try? await Task.sleep(nanoseconds: pollNanoseconds)
        }
    }

    static func liveAttachmentStrings(processIdentifier: pid_t) -> [String] {
        let app = AXUIElementCreateApplication(processIdentifier)
        var windowRef: CFTypeRef?
        let windowResult = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &windowRef)
        let window: AXUIElement?
        if windowResult == .success, let windowRef, CFGetTypeID(windowRef) == AXUIElementGetTypeID() {
            window = unsafeBitCast(windowRef, to: AXUIElement.self)
        } else {
            var mainRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute as CFString, &mainRef) == .success,
                  let mainRef,
                  CFGetTypeID(mainRef) == AXUIElementGetTypeID() else {
                return []
            }
            window = unsafeBitCast(mainRef, to: AXUIElement.self)
        }
        guard let root = window else { return [] }
        var texts: [String] = []
        var stack = [root]
        var visited = 0
        while let current = stack.popLast(), visited < 1_200, texts.count < 80 {
            visited += 1
            for attribute in [kAXTitleAttribute as String, kAXDescriptionAttribute as String, kAXValueAttribute as String] {
                var value: CFTypeRef?
                if AXUIElementCopyAttributeValue(current, attribute as CFString, &value) == .success,
                   let string = value as? String {
                    texts.append(string)
                }
            }
            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(current, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let childrenRef,
               CFGetTypeID(childrenRef) == CFArrayGetTypeID() {
                let cfArray = unsafeBitCast(childrenRef, to: CFArray.self)
                let count = CFArrayGetCount(cfArray)
                var children: [AXUIElement] = []
                for index in 0..<count {
                    guard let pointer = CFArrayGetValueAtIndex(cfArray, index) else { continue }
                    children.append(unsafeBitCast(pointer, to: AXUIElement.self))
                }
                stack.append(contentsOf: children.reversed())
            }
        }
        return texts
    }
}
