import Foundation

/// Three-way bullet merge for the one visible memory file.
/// The user's next text wins deletions; agent-appended bullets after the snapshot stay.
enum YishuVisibleMemoryMerge {
    static func apply(base: String, current: String, next: String) -> String {
        if current == base { return next }
        let baseFacts = facts(in: base)
        let currentFacts = facts(in: current)
        let nextFacts = facts(in: next)
        let baseSet = Set(baseFacts.map(normalize))
        let nextSet = Set(nextFacts.map(normalize))
        let deleted = Set(
            baseFacts
                .map(normalize)
                .filter { !nextSet.contains($0) }
        )
        var seen = nextSet
        var merged = nextFacts
        for fact in currentFacts {
            let key = normalize(fact)
            if baseSet.contains(key) || deleted.contains(key) || seen.contains(key) {
                continue
            }
            seen.insert(key)
            merged.append(fact)
        }
        let header = prefix(of: next).isEmpty ? (prefix(of: current).isEmpty ? YishuVisibleMemoryFile.header : prefix(of: current)) : prefix(of: next)
        if merged.isEmpty {
            return header.hasSuffix("\n") ? header : header + "\n"
        }
        let headerText = header.hasSuffix("\n") ? header : header + "\n"
        return headerText + merged.map { "- \($0)" }.joined(separator: "\n") + "\n"
    }

    private static func facts(in text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: false).compactMap { line in
            claim(from: String(line))
        }
    }

    private static func claim(from line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let body: String
        if trimmed.hasPrefix("- ") {
            body = String(trimmed.dropFirst(2))
        } else if trimmed.hasPrefix("* ") {
            body = String(trimmed.dropFirst(2))
        } else {
            return nil
        }
        let claim = body.trimmingCharacters(in: .whitespacesAndNewlines)
        return claim.isEmpty ? nil : claim
    }

    private static func normalize(_ text: String) -> String {
        let collapsed = text
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"[。.!！？?；;，,、]+$"#, with: "", options: .regularExpression)
        return collapsed.lowercased()
    }

    private static func prefix(of text: String) -> String {
        var lines: [String] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if claim(from: line) != nil { break }
            lines.append(line)
        }
        while lines.last == "" { lines.removeLast() }
        if lines.isEmpty { return "" }
        return lines.joined(separator: "\n") + "\n\n"
    }
}
