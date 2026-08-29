import SwiftUI

/// In-product notes on the existing personal memory store.
/// Cards, not a table; composer refuses empty text.
struct YishuPersonalNotesSection: View {
    @ObservedObject var companionManager: CompanionManager
    var showsHeader: Bool = true
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showsHeader {
                header
            }
            composer
            if let notice = companionManager.memoryNotice {
                Text(notice)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(noticeColor(notice))
                    .fixedSize(horizontal: false, vertical: true)
            }
            forgetConfirm
            cards
        }
        .padding(.top, 4)
        .onAppear {
            if companionManager.sessionScope.kind == .personal {
                companionManager.refreshPersonalMemories()
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "note.text")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(DS.Colors.textTertiary)
                .frame(width: 16)

            Text(YishuPersonalNotesCopy.sectionTitle)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(DS.Colors.textPrimary)

            Spacer()

            Button(action: {
                companionManager.refreshPersonalMemories()
            }) {
                Text(
                    companionManager.personalMemoryLoading
                        ? YishuPersonalNotesCopy.refreshing
                        : YishuPersonalNotesCopy.refresh
                )
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(DS.Colors.textSecondary)
            }
            .buttonStyle(.plain)
            .disabled(companionManager.personalMemoryLoading)
            .pointerCursor()
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(
                YishuPersonalNotesCopy.composerPlaceholder,
                text: $draft,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .font(.system(size: 13, weight: .medium))
            .foregroundColor(DS.Colors.textPrimary)
            .lineLimit(1...4)
            .focused($composerFocused)

            HStack {
                Spacer()
                Button(action: submitDraft) {
                    Text(
                        companionManager.personalNoteSaving
                            ? YishuPersonalNotesCopy.saving
                            : YishuPersonalNotesCopy.save
                    )
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(canSubmit ? DS.Colors.textOnAccent : DS.Colors.textTertiary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 5)
                    .background(
                        Capsule().fill(
                            canSubmit ? DS.Colors.accent : Color.white.opacity(0.08)
                        )
                    )
                }
                .buttonStyle(.plain)
                .disabled(!canSubmit)
                .pointerCursor()
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(paperFill(index: 0, blank: true))
        .rotationEffect(.degrees(-0.6))
    }

    private var canSubmit: Bool {
        YishuPersonalNoteWritePolicy.shouldCreate(draft)
            && companionManager.canChangeConversation
            && !companionManager.personalNoteSaving
    }

    private var forgetConfirm: some View {
        Group {
            if let candidate = companionManager.memoryForgetCandidate {
                VStack(alignment: .leading, spacing: 10) {
                    Text(YishuPersonalNotesCopy.forgetPrompt)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(DS.Colors.textPrimary)
                    Text(YishuPersonalNotesCopy.forgetDetail(candidate.summary))
                        .font(.system(size: 11))
                        .foregroundColor(DS.Colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Button(action: {
                            companionManager.cancelForgetPersonalMemory()
                        }) {
                            Text(YishuPersonalNotesCopy.cancelForget)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(DS.Colors.textSecondary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(Capsule().fill(Color.white.opacity(0.08)))
                        }
                        .buttonStyle(.plain)
                        .disabled(companionManager.memoryForgetInFlight)
                        .pointerCursor()

                        Button(action: {
                            companionManager.confirmForgetPersonalMemory()
                        }) {
                            Text(
                                companionManager.memoryForgetInFlight
                                    ? YishuPersonalNotesCopy.forgetting
                                    : YishuPersonalNotesCopy.confirmForget
                            )
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(DS.Colors.textOnAccent)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Capsule().fill(DS.Colors.accent))
                        }
                        .buttonStyle(.plain)
                        .disabled(companionManager.memoryForgetInFlight)
                        .pointerCursor()
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.black.opacity(0.55))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .stroke(DS.Colors.borderSubtle, lineWidth: 1)
                        )
                )
            }
        }
    }

    @ViewBuilder
    private var cards: some View {
        if companionManager.personalMemoryLoading && companionManager.personalMemoryItems.isEmpty {
            Text(YishuPersonalNotesCopy.loading)
                .font(.system(size: 11))
                .foregroundColor(DS.Colors.textTertiary)
        } else if companionManager.personalMemoryEmpty {
            Text(YishuPersonalNotesCopy.emptyList)
                .font(.system(size: 11))
                .foregroundColor(DS.Colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            VStack(spacing: 8) {
                ForEach(Array(companionManager.personalMemoryItems.enumerated()), id: \.element.id) { index, item in
                    YishuPersonalNoteCard(
                        item: item,
                        colorIndex: index,
                        canForget: companionManager.canChangeConversation
                            && !companionManager.memoryForgetInFlight,
                        onForget: {
                            companionManager.requestForgetPersonalMemory(item)
                        }
                    )
                }
            }
        }
    }

    private func submitDraft() {
        let text = draft
        companionManager.savePersonalNote(text) {
            draft = ""
            composerFocused = false
        }
    }

    private func noticeColor(_ notice: String) -> Color {
        if notice == YishuPersonalNotesCopy.saved {
            return DS.Colors.blue300
        }
        if notice.contains("没") || notice.contains("没有") || notice.contains("可能") {
            return DS.Colors.warning
        }
        return DS.Colors.textTertiary
    }

    private func paperFill(index: Int, blank: Bool) -> some View {
        let paper = YishuPersonalNoteCard.paperColor(index)
        return RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(paper.opacity(blank ? 0.10 : 0.16))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(paper.opacity(0.35), lineWidth: 1)
            )
            .overlay(alignment: .leading) {
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(paper.opacity(0.7))
                    .frame(width: 3)
                    .padding(.vertical, 8)
                    .padding(.leading, 4)
            }
    }
}

struct YishuPersonalNoteCard: View {
    let item: YishuMemoryListItem
    let colorIndex: Int
    let canForget: Bool
    let onForget: () -> Void

    @State private var flipped = false

    var body: some View {
        ZStack {
            front
                .opacity(flipped ? 0 : 1)
                .rotation3DEffect(.degrees(flipped ? 180 : 0), axis: (x: 0, y: 1, z: 0))
            back
                .opacity(flipped ? 1 : 0)
                .rotation3DEffect(.degrees(flipped ? 0 : -180), axis: (x: 0, y: 1, z: 0))
        }
        .rotationEffect(.degrees(tilt))
        .onTapGesture {
            withAnimation(.spring(response: 0.42, dampingFraction: 0.78)) {
                flipped.toggle()
            }
        }
        .help(YishuPersonalNotesCopy.flipHint)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("记忆卡片")
        .accessibilityIdentifier(
            YishuMemoryQualityEvents.cardAccessibilityIdentifier(for: item.id)
        )
    }

    private var front: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.summary)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(DS.Colors.textPrimary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Text(YishuPersonalNotesCopy.sourceLine(item.source))
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                Spacer()
                Text(Self.relativeTime(item.capturedAt))
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .monospacedDigit()
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 12)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(paperBackground)
    }

    private var back: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(item.summary)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(DS.Colors.textSecondary)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Text(YishuPersonalNotesCopy.sourceLine(item.source))
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                Spacer()
                Button(action: onForget) {
                    Text(YishuPersonalNotesCopy.confirmForget)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(
                            canForget ? DS.Colors.textOnAccent : DS.Colors.textTertiary
                        )
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            Capsule().fill(
                                canForget
                                    ? DS.Colors.accent.opacity(0.85)
                                    : Color.white.opacity(0.08)
                            )
                        )
                }
                .buttonStyle(.plain)
                .disabled(!canForget)
                .pointerCursor()
                .accessibilityLabel("忘记这条记忆")
                .accessibilityIdentifier(
                    YishuMemoryQualityEvents.forgetAccessibilityIdentifier(for: item.id)
                )
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 12)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(paperBackground)
    }

    private var paperBackground: some View {
        let paper = Self.paperColor(colorIndex)
        return RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(paper.opacity(0.16))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(paper.opacity(0.38), lineWidth: 1)
            )
            .overlay(alignment: .topTrailing) {
                Triangle()
                    .fill(paper.opacity(0.28))
                    .frame(width: 14, height: 14)
                    .padding(6)
            }
            .overlay(alignment: .leading) {
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(paper.opacity(0.75))
                    .frame(width: 3)
                    .padding(.vertical, 8)
                    .padding(.leading, 4)
            }
    }

    private var tilt: Double {
        let hash = item.id.uuidString.utf8.reduce(0) { $0 &+ Int($1) }
        return Double((hash % 7) - 3) * 0.55
    }

    static func paperColor(_ index: Int) -> Color {
        switch index % 3 {
        case 0:
            return Color(red: 0.93, green: 0.86, blue: 0.70)
        case 1:
            return Color(red: 0.74, green: 0.86, blue: 0.97)
        default:
            return Color(red: 0.97, green: 0.80, blue: 0.74)
        }
    }

    static func relativeTime(_ date: Date) -> String {
        if date == Date.distantPast { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        formatter.locale = Locale(identifier: "zh_CN")
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

private struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
        path.closeSubpath()
        return path
    }
}
