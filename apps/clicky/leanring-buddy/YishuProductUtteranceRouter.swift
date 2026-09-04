import Foundation

/// Client-side mirror of product utterance routing for fast-path UX decisions.
/// The Node `@yishu/kernel` router remains authoritative at the runtime boundary;
/// this helper lets tests and shell code share the same intent vocabulary.
enum YishuProductUtteranceRouter {
    enum Intent: Equatable {
        case rememberHow
        case runSkillOrShare
        case rememberFact
        case recordLearning
        case timeReminder
        case conversation
    }

    enum RelativeTimeReminderKind: Equatable {
        case schedule(delaySeconds: Int, body: String)
        case question
        case incomplete
    }

    static func classify(_ utterance: String) -> Intent {
        let text = utterance.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .conversation }
        if relativeTimeReminderKind(text) != nil { return .timeReminder }

        if text.range(
            of: #"(记住|记下|保存).{0,12}(刚才|刚刚).{0,12}(怎么做|做法|流程|步骤)"#,
            options: .regularExpression
        ) != nil
            || text.range(
                of: #"(记住|记下).{0,8}(这个|刚才的)?(流程|步骤|做法)"#,
                options: .regularExpression
            ) != nil
            || text.range(
                of: #"remember\s+(how|what)\s+i\s+(just\s+)?did"#,
                options: [.regularExpression, .caseInsensitive]
            ) != nil
        {
            return .rememberHow
        }

        if text.range(
            of: #"(交给|给|发给).{0,8}(codex|claude|cursor|cua)"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
            || text.range(
                of: #"把(现在|当前|这些?).{0,12}(交给|给)"#,
                options: .regularExpression
            ) != nil
        {
            return .runSkillOrShare
        }

        if text.range(
            of: #"(以后|下次).{0,20}(不要|别|禁止)"#,
            options: .regularExpression
        ) != nil || text.contains("不要再") || text.contains("记住规则") {
            return .recordLearning
        }

        if text.range(
            of: #"^(?:请帮我|请你|帮我|麻烦|请)?\s*(记住|记下|记一下)[：:\s]"#,
            options: .regularExpression
        ) != nil
            || text.range(of: #"^remember\s+(that|this)\b"#, options: [.regularExpression, .caseInsensitive]) != nil
            || text.contains("请记住")
        {
            return .rememberFact
        }

        return .conversation
    }

    static func shouldPreferProductKernel(_ utterance: String) -> Bool {
        classify(utterance) != .conversation
    }

    static func relativeTimeReminderKind(_ utterance: String) -> RelativeTimeReminderKind? {
        let trimmed = utterance.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let rest = stripReminderLeadIn(trimmed)
        guard hasReminderShape(trimmed) || hasReminderShape(rest) else { return nil }
        if isReminderQuestion(trimmed) || isReminderQuestion(rest) { return .question }
        if let parsed = parseReminder(trimmed) { return .schedule(delaySeconds: parsed.0, body: parsed.1) }
        return .incomplete
    }

    static func looksLikeRelativeTimeReminder(_ utterance: String) -> Bool {
        relativeTimeReminderKind(utterance) != nil
    }

    private static func parseReminder(_ text: String) -> (Int, String)? {
        let rest = stripReminderLeadIn(text)
        if isReminderQuestion(text) || isReminderQuestion(rest) { return nil }
        guard let parsed = parseTimeThenRemind(rest)
            ?? parseRemindThenTime(rest)
            ?? parseSetReminder(rest)
            ?? parseEnglishReminder(rest) else {
            return nil
        }
        let body = normalizeBody(parsed.1)
        guard isUsableBody(body) else { return nil }
        return (parsed.0, body)
    }

    private static func parseTimeThenRemind(_ text: String) -> (Int, String)? {
        let stripped = text.replacingOccurrences(
            of: #"^(?:再过|再)\s*"#,
            with: "",
            options: .regularExpression
        )
        guard let delay = matchDelayPrefix(stripped) else { return nil }
        let after = delay.rest.replacingOccurrences(of: #"^[，,]\s*"#, with: "", options: .regularExpression)
        guard let verb = after.range(
            of: #"^(?:请你?|帮我|麻烦|给我)?\s*(?:提醒(?:我一下|一下我|我|用户|你)|叫我(?:一声)?|喊我|帮我提醒)\s*"#,
            options: .regularExpression
        ) else {
            return nil
        }
        return (delay.delaySeconds, String(after[verb.upperBound...]))
    }

    private static func parseRemindThenTime(_ text: String) -> (Int, String)? {
        guard let verb = text.range(
            of: #"^(?:提醒(?:我一下|一下我|我|用户|你)|叫我(?:一声)?|喊我)\s*"#,
            options: .regularExpression
        ) else {
            return nil
        }
        guard let delay = matchDelayPrefix(String(text[verb.upperBound...])) else { return nil }
        return (delay.delaySeconds, delay.rest)
    }

    private static func parseSetReminder(_ text: String) -> (Int, String)? {
        if let setPrefix = text.range(
            of: #"^设(?:一个|个)?(?:在|过|再过)?\s*"#,
            options: .regularExpression
        ), let delay = matchDelayPrefix(String(text[setPrefix.upperBound...])) {
            var remainder = delay.rest.replacingOccurrences(
                of: #"^的?提醒[，,：:\s]*"#,
                with: "",
                options: .regularExpression
            )
            if let verb = remainder.range(
                of: #"^(?:提醒(?:我一下|一下我|我|用户|你)|叫我(?:一声)?|喊我)\s*"#,
                options: .regularExpression
            ) {
                remainder = String(remainder[verb.upperBound...])
            } else if let before = remainder.range(
                of: #"^(.*?)的提醒[。！!\s]*$"#,
                options: .regularExpression
            ) {
                remainder = String(remainder[before])
                    .replacingOccurrences(of: #"的提醒[。！!\s]*$"#, with: "", options: .regularExpression)
            }
            return (delay.delaySeconds, remainder)
        }
        guard let setThen = text.range(
            of: #"^设(?:一个|个)?提醒[，,：:\s]*"#,
            options: .regularExpression
        ), let delay = matchDelayPrefix(String(text[setThen.upperBound...])) else {
            return nil
        }
        return (delay.delaySeconds, delay.rest)
    }

    private static func parseEnglishReminder(_ text: String) -> (Int, String)? {
        if let remind = text.range(
            of: #"^remind\s+me\s+(?:to\s+)?"#,
            options: [.regularExpression, .caseInsensitive]
        ), let delay = matchDelayPrefix(String(text[remind.upperBound...])) {
            return (delay.delaySeconds, delay.rest.replacingOccurrences(
                of: #"^(?:to|that)\s+"#,
                with: "",
                options: [.regularExpression, .caseInsensitive]
            ))
        }
        guard let delay = matchDelayPrefix(text),
              let remind = delay.rest.range(
                of: #"^remind\s+me\s+(?:to\s+)?"#,
                options: [.regularExpression, .caseInsensitive]
              ) else {
            return nil
        }
        return (delay.delaySeconds, String(delay.rest[remind.upperBound...]).replacingOccurrences(
            of: #"^(?:to|that)\s+"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        ))
    }

    private static func matchDelayPrefix(_ text: String) -> (delaySeconds: Int, rest: String)? {
        let trimmed = text.replacingOccurrences(of: #"^(?:在|过|in)\s*"#, with: "", options: [.regularExpression, .caseInsensitive])
        if let match = trimmed.range(of: #"^半(?:个)?小时\s*(?:后|以后|之后)?\s*"#, options: .regularExpression) {
            return finishDelay(1_800, source: trimmed, consumed: match)
        }
        if let match = trimmed.range(of: #"^(?:一|1)个?小时\s*(?:后|以后|之后)?\s*"#, options: .regularExpression) {
            return finishDelay(3_600, source: trimmed, consumed: match)
        }
        if let match = trimmed.range(of: #"^(?:两|二|2)个?小时\s*(?:后|以后|之后)?\s*"#, options: .regularExpression) {
            return finishDelay(7_200, source: trimmed, consumed: match)
        }
        if let match = trimmed.range(
            of: #"^(\d{1,4})\s*(分钟|分|小时|时)\s*(?:后|以后|之后)?\s*"#,
            options: .regularExpression
        ) {
            let consumed = String(trimmed[match])
            let parts = consumed.replacingOccurrences(
                of: #"\s*(?:后|以后|之后)?\s*$"#,
                with: "",
                options: .regularExpression
            )
            let amountMatch = parts.range(of: #"\d{1,4}"#, options: .regularExpression)
            let unitMatch = parts.range(of: #"(分钟|分|小时|时)"#, options: .regularExpression)
            guard let amountMatch, let unitMatch, let amount = Int(parts[amountMatch]) else { return nil }
            let isMinutes = parts[unitMatch] == "分钟" || parts[unitMatch] == "分"
            if isMinutes ? !(1...1_440).contains(amount) : !(1...24).contains(amount) { return nil }
            return finishDelay(amount * (isMinutes ? 60 : 3_600), source: trimmed, consumed: match)
        }
        if let match = trimmed.range(
            of: #"^(\d{1,4})\s*(minutes?|mins?|hours?|hrs?)\s*(?:from now|later)?\s*"#,
            options: [.regularExpression, .caseInsensitive]
        ) {
            let consumed = String(trimmed[match])
            guard let amountMatch = consumed.range(of: #"\d{1,4}"#, options: .regularExpression),
                  let amount = Int(consumed[amountMatch]) else {
                return nil
            }
            let isMinutes = consumed.range(
                of: #"min"#,
                options: [.regularExpression, .caseInsensitive]
            ) != nil
            if isMinutes ? !(1...1_440).contains(amount) : !(1...24).contains(amount) { return nil }
            return finishDelay(amount * (isMinutes ? 60 : 3_600), source: trimmed, consumed: match)
        }
        return nil
    }

    private static func finishDelay(
        _ delaySeconds: Int,
        source: String,
        consumed: Range<String.Index>
    ) -> (delaySeconds: Int, rest: String)? {
        guard (60...86_400).contains(delaySeconds) else { return nil }
        return (delaySeconds, String(source[consumed.upperBound...]))
    }

    private static func isReminderQuestion(_ text: String) -> Bool {
        if text.range(
            of: #"(?:[？?]|好吗|行吗|可以吗|能吗|好不好|行不行|要不要|是不是)\s*[。！!]?\s*$"#,
            options: .regularExpression
        ) != nil {
            return true
        }
        if text.range(of: #"(?:吗|么|嘛|呢)\s*[。！!]?\s*$"#, options: .regularExpression) != nil {
            return true
        }
        // ICU \b treats Han and digits as one word, so `能不能\b` misses
        // 「能不能20分钟…」. Node's \b is ASCII-only and does match. Split
        // the lead-ins so the Swift mirror stays aligned with Kernel.
        if text.range(
            of: #"^(?:能不能|可不可以|是否|要不要|是不是|可以不可以)"#,
            options: .regularExpression
        ) != nil {
            return true
        }
        return text.range(
            of: #"^(?:can you|could you|would you|will you)\b"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }

    private static func hasReminderShape(_ text: String) -> Bool {
        text.range(
            of: #"(?:\d{1,4}\s*(?:分钟|分|小时|时)|半(?:个)?小时|(?:一|两|二|\d)个?小时|\d{1,4}\s*(?:minutes?|mins?|hours?|hrs?))"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
            && text.range(
                of: #"(?:提醒(?:我|用户|你)?|叫我|喊我|remind\s+me)"#,
                options: [.regularExpression, .caseInsensitive]
            ) != nil
    }

    private static func normalizeBody(_ raw: String) -> String {
        raw.replacingOccurrences(of: #"[（(]\s*约\s*\d{2}:\d{2}\s*[）)]\s*$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[。！!？?\s]+$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"(?:啊|呀|哦|哈|吧|谢谢)+$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"^(?:to|that)\s+"#, with: "", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isUsableBody(_ body: String) -> Bool {
        (1...500).contains(body.count)
            && body.range(of: #"^(?:不要|别|不用|无需)"#, options: .regularExpression) == nil
            && body.range(of: #"^(?:一下|这件事|这个|那个|到时候|别忘了|提醒)$"#, options: .regularExpression) == nil
    }

    private static func stripReminderLeadIn(_ text: String) -> String {
        text.replacingOccurrences(of: #"^(?:奕枢[，,\s]*)+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"^(?:嗯|啊|那个|然后)[，,\s]*"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"^(?:请你?|帮我|麻烦|给我)[，,\s]*"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"^(?:请\s*)?"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
