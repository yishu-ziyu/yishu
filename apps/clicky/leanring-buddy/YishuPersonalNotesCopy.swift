import Foundation

/// User-visible copy for in-product notes. Keep human; never leak store jargon.
enum YishuPersonalNotesCopy {
    static let sectionTitle = "记下的事"
    static let refresh = "刷新"
    static let refreshing = "刷新中…"
    static let composerPlaceholder = "随手记一句…"
    static let save = "记下"
    static let saving = "记下…"
    static let emptyList = "还没有记下什么。写一条，或跟我说「记住…」。"
    static let loading = "正在翻看…"
    static let emptyDraft = "先写一句再记下。"
    static let saved = "记下了。"
    static let notSaved = "这次没有记下。"
    static let unconfirmed = "可能记下了，但我没能确认。"
    static let runtimeNotReadyRead = "还没准备好，稍后再看记下的事。"
    static let runtimeNotReadyWrite = "还没准备好，这次没有记下。"
    static let runtimeNotReadyForget = "还没准备好，没有忘掉。"
    static let needPersonal = "先切到「我的」再看这些纸条。"
    static let busyWrite = "请等我说完再记下。"
    static let busyForget = "请等我说完再丢掉这条。"
    static let forgetPrompt = "丢掉这张？"
    static let cancelForget = "先留着"
    static let confirmForget = "丢掉"
    static let forgetting = "丢掉…"
    static let alreadyGone = "这张本来就不在了。"
    static let forgetFailed = "没忘掉，还留着。"
    static let flipHint = "点一下翻面"

    static let forbiddenInternalTerms = ["记忆声明", "账本", "证据", "TaskTruth"]

    static func forgetDetail(_ summary: String) -> String {
        "「\(summary)」会从这里消失，以后也不会再拿出来。"
    }

    static func forgot(_ summary: String) -> String {
        "已经忘掉「\(summary)」。"
    }

    static func sourceLine(_ source: String) -> String {
        switch source {
        case "conversation":
            return "你告诉我的"
        case "user_correction":
            return "你改过的"
        case "observation":
            return "我看见的"
        default:
            return "记下的"
        }
    }
}

/// Local write rules for the panel composer. Storage still owns persistence.
enum YishuPersonalNoteWritePolicy {
    static let maxLength = 2000

    static func normalizedText(_ raw: String) -> String {
        String(raw.trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxLength))
    }

    static func shouldCreate(_ raw: String) -> Bool {
        !normalizedText(raw).isEmpty
    }

    static func notice(confirmed: Bool, maybeWritten: Bool) -> String {
        if confirmed { return YishuPersonalNotesCopy.saved }
        if maybeWritten { return YishuPersonalNotesCopy.unconfirmed }
        return YishuPersonalNotesCopy.notSaved
    }
}
