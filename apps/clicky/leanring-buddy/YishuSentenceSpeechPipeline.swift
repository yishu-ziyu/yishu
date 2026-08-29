import Foundation

/// Turns presentation-safe Runtime deltas into one strictly serial stream of
/// spoken sentences. It never interprets model/tool syntax; callers must feed
/// it only the already-projected `response.delta` text.
///
/// Mouth budget: at most two complete sentences. A run of more than ~80
/// characters with no sentence boundary is a wall — do not stream-speak;
/// the caller should select a deterministic excerpt from the final visible reply.
@MainActor
final class YishuSentenceSpeechPipeline {
    typealias Speaker = @MainActor (String) async throws -> Void
    typealias StopPlayback = @MainActor () -> Void

    private let speaker: Speaker
    private let stopPlayback: StopPlayback
    private var buffer = ""
    private var committedSourceText = ""
    private var queue: [String] = []
    private var pumpTask: Task<Void, Never>?
    private var drainWaiters: [CheckedContinuation<Void, Never>] = []
    private var isFinished = false
    private var isCancelled = false
    private var enqueuedSentenceCount = 0
    private(set) var didEnqueueSpeech = false
    private(set) var didCompleteSpeech = false
    private(set) var didDetectWall = false

    init(
        speaker: @escaping Speaker,
        stopPlayback: @escaping StopPlayback
    ) {
        self.speaker = speaker
        self.stopPlayback = stopPlayback
    }

    /// Returns the number of newly queued sentences. A positive result means
    /// the first complete sentence can begin before the authoritative final.
    @discardableResult
    func consume(_ presentationDelta: String) -> Int {
        guard !isFinished, !isCancelled, !didDetectWall, !presentationDelta.isEmpty else { return 0 }
        guard enqueuedSentenceCount < YishuSpokenReplyBudget.maxSpokenSentences else { return 0 }
        buffer += presentationDelta
        let count = extractCompleteSentences(isFinal: false)
        detectWallIfNeeded(isFinal: false)
        return count
    }

    /// Reconciles against the authoritative visible text and speaks only the
    /// uncommitted suffix, still inside the two-sentence budget. Previously
    /// queued/spoken sentences are never replayed. A wall is not spoken.
    @discardableResult
    func finish(authoritativeText: String) async -> Bool {
        guard !isFinished, !isCancelled else { return false }
        isFinished = true

        guard authoritativeText.hasPrefix(committedSourceText) else {
            // The Runtime contract says deltas are monotonic and concatenate to
            // this text. If that invariant breaks, stop stale audio and hand the
            // authoritative final back to the ordinary final-only presenter.
            queue.removeAll()
            buffer = ""
            pumpTask?.cancel()
            stopPlayback()
            await waitUntilDrained()
            return false
        }

        if didDetectWall && enqueuedSentenceCount == 0 {
            buffer = ""
            await waitUntilDrained()
            return false
        }

        buffer = String(authoritativeText.dropFirst(committedSourceText.count))
        if !didDetectWall {
            _ = extractCompleteSentences(isFinal: true)
            detectWallIfNeeded(isFinal: true)
            if !buffer.isEmpty,
               enqueuedSentenceCount < YishuSpokenReplyBudget.maxSpokenSentences,
               !didDetectWall,
               !YishuSpokenReplyBudget.isWall(buffer) {
                let tail = buffer
                buffer = ""
                committedSourceText += tail
                enqueue(tail)
            }
        }
        buffer = ""
        await waitUntilDrained()
        return didCompleteSpeech && !isCancelled
    }

    /// PTT and turn cancellation are hard boundaries: stop the current audio,
    /// discard every queued sentence, and wake any waiter immediately.
    func cancel() {
        guard !isCancelled else { return }
        isCancelled = true
        queue.removeAll()
        buffer = ""
        pumpTask?.cancel()
        stopPlayback()
        resumeDrainWaiters()
    }

    private func extractCompleteSentences(isFinal: Bool) -> Int {
        var count = 0
        while enqueuedSentenceCount < YishuSpokenReplyBudget.maxSpokenSentences,
              let boundary = firstSentenceBoundary(isFinal: isFinal) {
            let source = String(buffer[..<boundary])
            buffer.removeSubrange(..<boundary)
            committedSourceText += source
            if enqueue(source) {
                count += 1
            }
        }
        return count
    }

    private func detectWallIfNeeded(isFinal: Bool) {
        guard !didDetectWall,
              enqueuedSentenceCount < YishuSpokenReplyBudget.maxSpokenSentences else { return }
        let safeEnd = isFinal ? buffer.endIndex : YishuSpokenReplyBudget.safeStreamingEnd(in: buffer)
        let safePrefix = String(buffer[..<safeEnd])
        guard firstSentenceBoundary(isFinal: isFinal) == nil,
              YishuSpokenReplyBudget.isWall(safePrefix) else { return }
        didDetectWall = true
    }

    private func firstSentenceBoundary(isFinal: Bool) -> String.Index? {
        YishuSpokenReplyBudget.firstSentenceBoundary(in: buffer, isFinal: isFinal)
    }

    @discardableResult
    private func enqueue(_ source: String) -> Bool {
        let sentence = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sentence.isEmpty,
              !isCancelled,
              enqueuedSentenceCount < YishuSpokenReplyBudget.maxSpokenSentences else { return false }
        queue.append(sentence)
        enqueuedSentenceCount += 1
        didEnqueueSpeech = true
        startPumpIfNeeded()
        return true
    }

    private func startPumpIfNeeded() {
        guard pumpTask == nil, !queue.isEmpty, !isCancelled else { return }
        pumpTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled, !self.isCancelled, !self.queue.isEmpty {
                let sentence = self.queue.removeFirst()
                do {
                    try await self.speaker(sentence)
                    self.didCompleteSpeech = true
                } catch is CancellationError {
                    if Task.isCancelled || self.isCancelled { break }
                } catch {
                    // One provider/playback failure must not create overlap or
                    // make the final response disappear. Continue serially.
                }
            }
            self.pumpTask = nil
            if !self.queue.isEmpty, !self.isCancelled {
                self.startPumpIfNeeded()
            } else {
                self.resumeDrainWaiters()
            }
        }
    }

    private func waitUntilDrained() async {
        guard pumpTask != nil || !queue.isEmpty else { return }
        await withCheckedContinuation { continuation in
            drainWaiters.append(continuation)
        }
    }

    private func resumeDrainWaiters() {
        let waiters = drainWaiters
        drainWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }
}

enum YishuSearchCoverSpeech {
    static let line = "好的，我去查查看。"
    static let toolName = "web_search"

    static func shouldSpeak(
        toolName: String,
        didSpeakCover: Bool,
        didSpeakAnswer: Bool,
        hasVisibleAnswerText: Bool
    ) -> Bool {
        toolName == Self.toolName
            && !didSpeakCover
            && !didSpeakAnswer
            && !hasVisibleAnswerText
    }
}

enum YishuAnswerSpeechRoute: Equatable {
    case alreadySpoken
    case speakInFull
    case speakDeterministicExcerpt
}

enum YishuSpokenReplyBudget {
    static let maxSpokenSentences = 2
    static let wallCharacterLimit = 80

    static func route(
        speechAlreadyPresented: Bool,
        visibleText: String
    ) -> YishuAnswerSpeechRoute {
        if speechAlreadyPresented { return .alreadySpoken }
        let trimmed = visibleText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .alreadySpoken }
        return shouldSpeakInFull(trimmed) ? .speakInFull : .speakDeterministicExcerpt
    }

    /// Returns only source text from the completed visible reply. Short replies
    /// stay intact; longer replies are capped at two complete sentences. A
    /// long fragment with no sentence boundary is intentionally not spoken.
    static func deterministicExcerpt(from visibleText: String) -> String? {
        let trimmed = visibleText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if shouldSpeakInFull(trimmed) { return trimmed }

        let sentences = prefixSentences(in: trimmed, limit: maxSpokenSentences)
        guard !sentences.isEmpty else { return nil }
        return sentences.joined().trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func shouldSpeakInFull(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let sentences = prefixSentences(in: trimmed, limit: maxSpokenSentences + 1)
        if sentences.count > maxSpokenSentences { return false }
        let remainder = remainderAfter(sentences, in: trimmed)
        if sentences.isEmpty { return !isWall(trimmed) }
        if remainder.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        return sentences.count < maxSpokenSentences && !isWall(remainder)
    }

    static func isWall(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if firstSentenceBoundary(in: trimmed, isFinal: true) != nil { return false }
        return trimmed.count > wallCharacterLimit
    }

    static func prefixSentences(in text: String, limit: Int) -> [String] {
        var remaining = text
        var sentences: [String] = []
        while sentences.count < limit,
              let boundary = firstSentenceBoundary(in: remaining, isFinal: true) {
            sentences.append(String(remaining[..<boundary]))
            remaining.removeSubrange(..<boundary)
        }
        return sentences
    }

    static func remainderAfter(_ sentences: [String], in text: String) -> String {
        let prefix = sentences.joined()
        guard text.hasPrefix(prefix) else { return text }
        return String(text.dropFirst(prefix.count))
    }

    static func firstSentenceBoundary(in buffer: String, isFinal: Bool) -> String.Index? {
        let safeEnd = isFinal ? buffer.endIndex : safeStreamingEnd(in: buffer)
        var index = buffer.startIndex
        while index < safeEnd {
            let character = buffer[index]
            let next = buffer.index(after: index)
            switch character {
            case "。", "！", "？", "；", "!", "?", "\n":
                return next
            case ".":
                if isConservativePeriodBoundary(
                    in: buffer,
                    at: index,
                    safeEnd: safeEnd,
                    isFinal: isFinal
                ) {
                    return next
                }
            default:
                break
            }
            index = next
        }
        return nil
    }

    /// Hold ambiguous markup tails until more bytes arrive. Runtime projection
    /// is the primary trust boundary; this is a second fail-closed guard before
    /// irreversible audio leaves the process.
    static func safeStreamingEnd(in text: String) -> String.Index {
        var candidates: [String.Index] = []
        if let opening = text.lastIndex(of: "["),
           text.lastIndex(of: "]").map({ opening > $0 }) ?? true {
            candidates.append(opening)
        }
        if let opening = text.lastIndex(of: "<"),
           text.lastIndex(of: ">").map({ opening > $0 }) ?? true {
            candidates.append(opening)
        }

        let backticks = text.indices.filter { text[$0] == "`" }
        if backticks.count % 2 == 1, let opening = backticks.last {
            candidates.append(opening)
        }
        if let runStart = trailingBacktickRunStart(in: text) {
            candidates.append(runStart)
        }
        return candidates.min() ?? text.endIndex
    }

    private static func trailingBacktickRunStart(in text: String) -> String.Index? {
        guard !text.isEmpty else { return nil }
        var cursor = text.endIndex
        var count = 0
        while cursor > text.startIndex {
            let previous = text.index(before: cursor)
            guard text[previous] == "`" else { break }
            count += 1
            cursor = previous
        }
        return count > 0 ? cursor : nil
    }

    private static func isConservativePeriodBoundary(
        in buffer: String,
        at index: String.Index,
        safeEnd: String.Index,
        isFinal: Bool
    ) -> Bool {
        let previous = index > buffer.startIndex ? buffer[buffer.index(before: index)] : nil
        let afterPeriod = buffer.index(after: index)
        let next = afterPeriod < safeEnd ? buffer[afterPeriod] : nil

        if previous?.isNumber == true, next?.isNumber == true {
            return false
        }

        let tokenStart = buffer[..<index].lastIndex(where: { $0.isWhitespace })
            .map { buffer.index(after: $0) } ?? buffer.startIndex
        let token = buffer[tokenStart...index].lowercased()
        if token.contains("://") || token.hasPrefix("www.") || token.contains("@") {
            return false
        }

        if let next {
            return next.isWhitespace
        }
        return isFinal
    }
}

enum YishuSentenceSpeechPolicy {
    static func allowsStreaming(for utterance: String) -> Bool {
        let text = utterance.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !YishuDirectClickResolver.isDirectClickIntent(text) else {
            return false
        }

        // Speech is irreversible. Classify broadly and fail closed whenever an
        // utterance mentions a plausible desktop effect; the typed Runtime
        // event remains the final guard if a novel action verb slips through.
        let desktopEffect = #"(?:点击|点开|点选|点一下|按下|输入|填写|填入|键入|写入|打开|关闭|滚动|拖动|删除|移除|发送|提交|保存|选择|选中|切换|返回|后退|\b(?:click|press|tap|type|fill|open|close|scroll|drag|delete|remove|send|submit|save|select|switch|go\s+back)\b)"#
        if text.range(
            of: desktopEffect,
            options: [.regularExpression, .caseInsensitive]
        ) != nil {
            return false
        }
        // Locate questions need the orb airborne before TTS. Streaming the
        // first sentence would talk while the companion is still on the cursor.
        let observationalLocate = #"(?:在哪|在哪儿|哪里|哪儿|在什么地方|where(?:\s+is)?|指一下|指给我看|找一下)"#
        return text.range(
            of: observationalLocate,
            options: [.regularExpression, .caseInsensitive]
        ) == nil
    }
}
