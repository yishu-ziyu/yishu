import Foundation

/// Native, request-scoped metadata. File contents and unrelated names never enter the model frame.
public struct DownloadsObservation: Codable, Sendable {
    public enum Status: String, Codable, Sendable {
        case available
        case permissionDenied = "permission_denied"
        case unavailable
    }

    public let status: Status
    public let capturedAt: Date
    public let candidates: [String]
    public let truncated: Bool

    public init(status: Status, capturedAt: Date, candidates: [String], truncated: Bool) {
        self.status = status
        self.capturedAt = capturedAt
        self.candidates = candidates
        self.truncated = truncated
    }

    public static func capture(utterance: String, directory: URL) -> Self? {
        guard let reference = reference(in: utterance) else { return nil }
        let manager = FileManager.default
        do {
            let entries = try manager.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey],
                options: [.skipsHiddenFiles]
            )
            var matches: [String] = []
            let normalizedReference = normalize(reference)
            let spokenReference = pronunciation(reference)
            for entry in entries {
                let name = entry.lastPathComponent
                guard !entry.pathExtension.isEmpty, name.count <= 255,
                      !name.contains(".."), !name.contains("\\"),
                      !name.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
                      let values = try? entry.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
                      values.isRegularFile == true, values.isSymbolicLink != true,
                      manager.isReadableFile(atPath: entry.path) else { continue }
                let stem = entry.deletingPathExtension().lastPathComponent
                let extensionName = entry.pathExtension
                // Both omitted extensions and spoken dots are ordinary speech, not exact path syntax.
                let plainStem = normalize(stem), plainExtension = normalize(extensionName)
                let spokenStem = pronunciation(stem), spokenExtension = pronunciation(extensionName)
                if [plainStem, plainStem + plainExtension, plainStem + "点" + plainExtension].contains(normalizedReference)
                    || [spokenStem, spokenStem + spokenExtension, spokenStem + "dian" + spokenExtension].contains(spokenReference) {
                    matches.append(name)
                    if matches.count > 20 { break }
                }
            }
            return Self(status: .available, capturedAt: Date(), candidates: Array(matches.sorted().prefix(20)), truncated: matches.count > 20)
        } catch {
            return Self(status: status(for: error as NSError), capturedAt: Date(), candidates: [], truncated: false)
        }
    }

    public static func status(for error: NSError) -> Status {
        if (error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoPermissionError)
            || (error.domain == NSPOSIXErrorDomain && [Int(EACCES), Int(EPERM)].contains(error.code)) {
            return .permissionDenied
        }
        return .unavailable
    }

    private static func reference(in utterance: String) -> String? {
        guard utterance.range(of: "下载|downloads?", options: [.regularExpression, .caseInsensitive]) != nil,
              utterance.range(of: "拖|上传|放到", options: .regularExpression) != nil,
              utterance.range(of: "怎么|如何|为什么|是否|能否|可以.*吗|[?？]", options: .regularExpression) == nil,
              utterance.range(of: "不要|别(?:给我)?(?:拖|上传)|不(?:要|用|想|需要).*?(?:拖|上传)", options: .regularExpression) == nil,
              let marker = utterance.range(of: "下载(?:文件夹|目录)?|downloads?", options: [.regularExpression, .caseInsensitive]) else { return nil }
        var value = String(utterance[marker.upperBound...])
        value = value.replacingOccurrences(of: "^\\s*(?:里面|里|中)?(?:的)?\\s*(?:那个|这个|那份|这份)?\\s*(?:名为|叫)?\\s*", with: "", options: .regularExpression)
        if let end = value.range(of: "拖|上传|放到", options: .regularExpression) {
            value = String(value[..<end.lowerBound])
        }
        value = value.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "\"“”「」『』'，。！？")))
        guard !value.isEmpty, !value.contains("/"), !value.contains("\\"), !value.contains("..") else { return nil }
        return value
    }

    private static func normalize(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: Locale(identifier: "zh_CN"))
            .unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(String.init).joined()
    }

    private static func pronunciation(_ value: String) -> String {
        normalize(value.applyingTransform(.toLatin, reverse: false) ?? value)
    }
}
