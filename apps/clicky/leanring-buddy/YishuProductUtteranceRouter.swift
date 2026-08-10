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
        case conversation
    }

    static func classify(_ utterance: String) -> Intent {
        let text = utterance.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .conversation }

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

        if text.range(of: #"^(记住|记下|记一下)[：:\s]"#, options: .regularExpression) != nil
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
}
