import AppKit
import Foundation
import Vision

struct YishuDirectClickScreen: Sendable {
    let imageData: Data
    let screenshotWidthInPixels: Int
    let screenshotHeightInPixels: Int
    let screenNumber: Int
}

struct YishuDirectClickMatch: Equatable, Sendable {
    let x: Double
    let y: Double
    let screenNumber: Int
    let label: String
}

/// Resolves a small, explicit click request locally. This keeps simple actions
/// off the vision-model path while leaving ambiguous and complex turns to Pi.
enum YishuDirectClickResolver {
    /// Maps Vision's normalized observation box to screenshot pixels.
    ///
    /// Vision returns text observations in the request's processed region of
    /// interest. Lift the observation back into full-image normalized space
    /// before converting Vision's bottom-left origin to screenshot pixels.
    static func pixelPoint(
        for boundingBox: CGRect,
        screenshotWidth: Int,
        screenshotHeight: Int,
        regionOfInterest: CGRect = CGRect(x: 0, y: 0, width: 1, height: 1)
    ) -> CGPoint? {
        guard screenshotWidth > 0,
              screenshotHeight > 0,
              isFiniteNormalizedRect(boundingBox),
              isFiniteNormalizedRect(regionOfInterest),
              boundingBox.minX >= 0,
              boundingBox.minY >= 0,
              boundingBox.width > 0,
              boundingBox.height > 0,
              boundingBox.maxX <= 1,
              boundingBox.maxY <= 1,
              regionOfInterest.minX >= 0,
              regionOfInterest.minY >= 0,
              regionOfInterest.width > 0,
              regionOfInterest.height > 0,
              regionOfInterest.maxX <= 1,
              regionOfInterest.maxY <= 1 else {
            return nil
        }

        let normalizedMidX = boundingBox.midX
        let normalizedMidY = boundingBox.midY
        let roiOriginX = regionOfInterest.origin.x
        let roiOriginY = regionOfInterest.origin.y
        let roiWidth = regionOfInterest.width
        let roiHeight = regionOfInterest.height
        let fullImageNormalizedX = roiOriginX + normalizedMidX * roiWidth
        let fullImageNormalizedY = roiOriginY + normalizedMidY * roiHeight
        let pixelX = fullImageNormalizedX * CGFloat(screenshotWidth)
        let pixelY = (1 - fullImageNormalizedY) * CGFloat(screenshotHeight)
        guard pixelX.isFinite,
              pixelY.isFinite,
              pixelX >= 0,
              pixelX <= CGFloat(screenshotWidth),
              pixelY >= 0,
              pixelY <= CGFloat(screenshotHeight) else {
            return nil
        }
        return CGPoint(x: pixelX, y: pixelY)
    }

    private static func isFiniteNormalizedRect(_ rect: CGRect) -> Bool {
        rect.origin.x.isFinite
            && rect.origin.y.isFinite
            && rect.width.isFinite
            && rect.height.isFinite
    }

    static func isDirectClickIntent(_ utterance: String) -> Bool {
        let normalized = utterance.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized.range(
            of: #"(?:解释|为什么|是什么意思|怎么|如何|\b(?:why|what|how)\b)"#,
            options: .regularExpression
        ) != nil {
            return false
        }
        if normalized.range(
            of: #"(?:点(?:什么|哪里|哪儿|哪个|哪一个)|(?:该|应该|要)点(?:什么|哪里|哪儿|哪个|哪一个))"#,
            options: .regularExpression
        ) != nil {
            return false
        }
        guard directClickTriggerCount(in: normalized) == 1 else { return false }

        // Keep multi-step instructions on the model path. A single click
        // embedded in “先…然后/再/接着/之后” is not a safe local fast path.
        if normalized.range(
            of: #"(?:然后|接着|之后|\b(?:then|and\s+then)\b)"#,
            options: .regularExpression
        ) != nil {
            return false
        }
        if normalized.contains("再"), normalized.contains("点击") {
            return false
        }
        if normalized.range(of: #"再\s*点"#, options: .regularExpression) != nil {
            return false
        }
        if normalized.range(
            of: #"(?:并且|并|且)\s*(?:点击|点开|点选|按下|输入|键入|发送|打开|关闭|选择|继续|滚动)"#,
            options: .regularExpression
        ) != nil {
            return false
        }
        if normalized.range(
            of: #"\band\s+(?:click|press|tap|type|write|open|send|select|scroll)\b"#,
            options: .regularExpression
        ) != nil {
            return false
        }
        return true
    }

    private static func directClickTriggerCount(in normalizedUtterance: String) -> Int {
        let pattern = #"(?:点击|点一下|点开|点选|按一下|按下|选中|帮我点|替我点|给我点|请点|去点|\b(?:click|press|tap)\b)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return 0 }
        let range = NSRange(normalizedUtterance.startIndex..., in: normalizedUtterance)
        let explicitCount = regex.numberOfMatches(in: normalizedUtterance, range: range)
        let barePointPattern = #"(?:^|[\s，,。！？!?；;：:])(?:请(?:你)?|帮我|替我|给我|去|现在)?点(?=\s*(?!(?:击|一下|开|选))(?:左|右|上|下|屏幕|这个|那个|按钮|图标|\p{Han}|[a-z0-9]))"#
        guard let barePointRegex = try? NSRegularExpression(pattern: barePointPattern) else {
            return explicitCount
        }
        return explicitCount + barePointRegex.numberOfMatches(in: normalizedUtterance, range: range)
    }

    static func targetPhrase(from utterance: String) -> String? {
        guard isDirectClickIntent(utterance) else { return nil }

        var target = utterance.lowercased()
        let barePointCommandPrefixes = ["请你点", "现在点", "点"]
        for prefix in barePointCommandPrefixes where target.hasPrefix(prefix) {
            let suffix = target.dropFirst(prefix.count)
            guard !suffix.hasPrefix("击"),
                  !suffix.hasPrefix("一下"),
                  !suffix.hasPrefix("开"),
                  !suffix.hasPrefix("选") else {
                continue
            }
            target.removeFirst(prefix.count)
            break
        }
        let removablePhrases = [
            "click on", "top left", "top right", "bottom left", "bottom right",
            "帮我点一下", "替我点一下", "给我点一下", "请点一下", "去点一下",
            "帮我点击", "替我点击", "给我点击", "请你点一下", "请你点击", "现在点击", "请点击", "去点击",
            "左上角", "右上角", "左下角", "右下角",
            "左边", "右边", "左侧", "右侧", "上方", "上面", "下方", "下面", "顶部", "底部",
            "屏幕上", "屏幕里", "当前页面", "当前窗口",
            "帮我点", "替我点", "给我点", "请点", "去点",
            "点一下", "按一下", "点击", "点开", "点选", "按下", "选中",
            "这个", "那个", "这里", "那里", "按钮", "图标", "选项", "一下",
            "please", "click", "press", "tap", "button", "icon", "the",
            "的",
        ]
        for phrase in removablePhrases {
            target = target.replacingOccurrences(of: phrase, with: "")
        }

        let normalizedTarget = normalizedText(target)
        return normalizedTarget.count >= 2 ? normalizedTarget : nil
    }

    /// Stable key for prewarm reuse. It includes both the normalized target
    /// and the exact Vision ROI so a partial frame is never reused for a
    /// final utterance that changes its spatial qualifier.
    static func resolutionKey(for utterance: String) -> String? {
        guard let target = targetPhrase(from: utterance) else { return nil }
        let region = recognitionRegion(for: utterance)
        return "\(target)|\(region.origin.x)|\(region.origin.y)|\(region.width)|\(region.height)"
    }

    static func resolve(
        utterance: String,
        screens: [YishuDirectClickScreen]
    ) async -> YishuDirectClickMatch? {
        guard let target = targetPhrase(from: utterance), !screens.isEmpty else { return nil }
        let regionOfInterest = recognitionRegion(for: utterance)

        return await Task.detached(priority: .userInitiated) {
            for screen in screens {
                if let match = recognize(
                    target: target,
                    screen: screen,
                    regionOfInterest: regionOfInterest
                ) {
                    return match
                }
            }
            return nil
        }.value
    }

    private static func recognize(
        target: String,
        screen: YishuDirectClickScreen,
        regionOfInterest: CGRect
    ) -> YishuDirectClickMatch? {
        guard let image = NSImage(data: screen.imageData),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = containsHanText(target)
            ? ["zh-Hans", "en-US"]
            : ["en-US", "zh-Hans"]
        request.usesLanguageCorrection = true
        request.customWords = [target]
        request.minimumTextHeight = 0.01
        request.regionOfInterest = regionOfInterest

        do {
            try VNImageRequestHandler(cgImage: cgImage).perform([request])
        } catch {
            return nil
        }

        var bestMatch: (score: Double, match: YishuDirectClickMatch)?
        for observation in request.results ?? [] {
            for candidate in observation.topCandidates(2) {
                let candidateText = normalizedText(candidate.string)
                let baseScore: Double
                if candidateText == target {
                    baseScore = 10_000
                } else if candidateText.contains(target) {
                    baseScore = 9_000 - Double(max(0, candidateText.count - target.count) * 20)
                } else if target.contains(candidateText), candidateText.count >= 2 {
                    baseScore = 6_000 + Double(candidateText.count * 20)
                } else {
                    continue
                }

                // Vision's observation is normalized within the request ROI;
                // lift it once before converting to screenshot pixels.
                guard let pixelPoint = Self.pixelPoint(
                    for: observation.boundingBox,
                    screenshotWidth: screen.screenshotWidthInPixels,
                    screenshotHeight: screen.screenshotHeightInPixels,
                    regionOfInterest: regionOfInterest
                ) else {
                    continue
                }
                let match = YishuDirectClickMatch(
                    x: Double(pixelPoint.x),
                    y: Double(pixelPoint.y),
                    screenNumber: screen.screenNumber,
                    label: candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
                )
                let score = baseScore + Double(candidate.confidence) * 100
                if bestMatch == nil || score > bestMatch!.score {
                    bestMatch = (score, match)
                }
            }
        }
        return bestMatch?.match
    }

    private static func recognitionRegion(for utterance: String) -> CGRect {
        let text = utterance.lowercased()
        let isLeft = ["左上", "左下", "左边", "左侧", "left"].contains(where: text.contains)
        let isRight = ["右上", "右下", "右边", "右侧", "right"].contains(where: text.contains)
        let isTop = ["左上", "右上", "上方", "上面", "顶部", "顶端", "top"].contains(where: text.contains)
        let isBottom = ["左下", "右下", "下方", "下面", "底部", "底端", "bottom"].contains(where: text.contains)

        let x: CGFloat = isRight ? 0.4 : 0
        let width: CGFloat = isLeft || isRight ? 0.6 : 1
        let y: CGFloat = isTop ? 0.45 : 0
        let height: CGFloat = isTop || isBottom ? 0.55 : 1
        return CGRect(x: x, y: y, width: width, height: height)
    }

    private static func normalizedText(_ text: String) -> String {
        let allowed = CharacterSet.letters.union(.decimalDigits)
        return text.lowercased().unicodeScalars
            .filter(allowed.contains)
            .map(String.init)
            .joined()
    }

    private static func containsHanText(_ text: String) -> Bool {
        text.unicodeScalars.contains { scalar in
            (0x3400...0x4DBF).contains(scalar.value)
                || (0x4E00...0x9FFF).contains(scalar.value)
        }
    }
}
