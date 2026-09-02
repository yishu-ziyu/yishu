//
//  CompanionResponseOverlay.swift
//  leanring-buddy
//
//  Streaming response state and the cursor-attached response presence.
//  The visual surface is rendered inside each screen's existing click-through
//  overlay so Yishu's body, thinking feedback, and answer share one anchor.
//

import AppKit
import Combine
import SwiftUI

// MARK: - View Model

enum CompanionResponsePresentationPhase: Equatable {
    case hidden
    case thinking
    case response
    case message
}

/// Runtime completion owns observational pointing so the later response
/// presentation cannot publish the same target a second time.
enum YishuObservationalPointingPolicy {
    enum PublicationSource {
        case runtimeCompletion
        case responsePresentation
    }

    static func shouldPublish(
        from source: PublicationSource,
        hasCoordinate: Bool,
        isDirectClickTurn: Bool,
        presentationTranscriptMatches: Bool
    ) -> Bool {
        guard case .runtimeCompletion = source else { return false }
        return hasCoordinate
            && !isDirectClickTurn
            && presentationTranscriptMatches
    }
}

/// Reconciles the authoritative final text against the streamed text the user
/// already watched appear. The runtime contract says deltas concatenate to the
/// final text; when reality disagrees, prefer display stability over replacing
/// the visible answer mid-word (which reads as the answer "restarting").
enum YishuOverlayTextReconcilePolicy {
    static func displayText(streamed: String, authoritative: String) -> String {
        let streamedTrimmed = streamed.trimmingCharacters(in: .whitespacesAndNewlines)
        let authoritativeTrimmed = authoritative.trimmingCharacters(in: .whitespacesAndNewlines)
        if authoritativeTrimmed.isEmpty { return streamed }
        if streamedTrimmed.isEmpty { return authoritative }
        if authoritativeTrimmed.hasPrefix(streamedTrimmed) { return authoritative }
        if streamedTrimmed.hasPrefix(authoritativeTrimmed) { return streamed }
        // Diverged: keep what the user actually watched being typed. The
        // spoken-reply path handles a contract break independently.
        return streamed
    }
}

@MainActor
final class CompanionResponseOverlayViewModel: ObservableObject {
    @Published var streamingResponseText: String = ""
    /// Sentences already spoken aloud; they dim so the unread tail stays
    /// visually "live" while the voice catches up with the text.
    @Published var spokenSentenceCount = 0
    /// Optional per-turn Runtime route receipt shown only for ordinary answers.
    @Published var routingMetadataText: String = ""
    /// Optional durable-memory source line shown under the answer.
    @Published var memorySourceText: String = ""
    @Published var presentationPhase: CompanionResponsePresentationPhase = .hidden

    var isShowingResponse: Bool {
        presentationPhase != .hidden
    }
}

// MARK: - State Controller

@MainActor
final class CompanionResponseOverlayManager {
    let viewModel = CompanionResponseOverlayViewModel()

    private var autoHideWorkItem: DispatchWorkItem?
    private var clearTextWorkItem: DispatchWorkItem?

    /// Keep one visible turn alive while ASR, context capture, and the model
    /// hand work off to one another. The answer replaces this phase in place.
    func showThinking() {
        cancelScheduledHide()
        viewModel.streamingResponseText = ""
        viewModel.spokenSentenceCount = 0
        viewModel.routingMetadataText = ""
        viewModel.memorySourceText = ""

        withAnimation(.easeOut(duration: 0.14)) {
            viewModel.presentationPhase = .thinking
        }
    }

    func showOverlayAndBeginStreaming() {
        showThinking()
    }

    func updateStreamingText(_ accumulatedText: String) {
        cancelScheduledHide()
        viewModel.streamingResponseText = accumulatedText
        guard !accumulatedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        viewModel.presentationPhase = .response
    }

    /// One sentence left the speaker. Called from the per-turn speech pipeline
    /// so the visible lines dim in the order the voice actually said them.
    func advanceSpokenSentence() {
        viewModel.spokenSentenceCount += 1
    }

    func updateMemorySourceText(_ text: String?) {
        viewModel.memorySourceText = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    func updateRoutingMetadataText(_ text: String?) {
        viewModel.routingMetadataText = String(
            (text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "").prefix(180)
        )
    }

    func finishStreaming() {
        cancelScheduledHide()

        // Reading window starts after the turn has settled the visible
        // answer, not while speech or a later republish is still in flight.
        let hideWorkItem = DispatchWorkItem { [weak self] in
            self?.fadeOutAndHide()
        }
        autoHideWorkItem = hideWorkItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: hideWorkItem)
    }

    /// Show a short non-streaming message (e.g. 没听清) immediately.
    /// Does not clear to empty first, so the typer placeholder "…" is skipped.
    func showStaticMessage(_ text: String, autoHideAfter seconds: TimeInterval = 6) {
        cancelScheduledHide()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        viewModel.routingMetadataText = ""
        viewModel.memorySourceText = ""
        viewModel.spokenSentenceCount = 0
        viewModel.streamingResponseText = trimmed
        withAnimation(.easeOut(duration: 0.18)) {
            viewModel.presentationPhase = .message
        }
        guard seconds > 0 else { return }
        let hideWorkItem = DispatchWorkItem { [weak self] in
            self?.fadeOutAndHide()
        }
        autoHideWorkItem = hideWorkItem
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: hideWorkItem)
    }

    func hideOverlay() {
        cancelScheduledHide()
        viewModel.presentationPhase = .hidden
        viewModel.streamingResponseText = ""
        viewModel.spokenSentenceCount = 0
        viewModel.routingMetadataText = ""
        viewModel.memorySourceText = ""
    }

    private func fadeOutAndHide() {
        withAnimation(.easeInOut(duration: 0.32)) {
            viewModel.presentationPhase = .hidden
        }

        // Keep the final glyphs alive until the opacity transition finishes.
        let clearWorkItem = DispatchWorkItem { [weak self] in
            self?.viewModel.streamingResponseText = ""
            self?.viewModel.spokenSentenceCount = 0
            self?.viewModel.routingMetadataText = ""
            self?.viewModel.memorySourceText = ""
        }
        clearTextWorkItem = clearWorkItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.34, execute: clearWorkItem)
    }

    var hasScheduledHide: Bool { autoHideWorkItem != nil }

    private func cancelScheduledHide() {
        autoHideWorkItem?.cancel()
        autoHideWorkItem = nil
        clearTextWorkItem?.cancel()
        clearTextWorkItem = nil
    }
}

// MARK: - Cursor-Attached Presence

struct CompanionResponsePresenceView: View {
    @ObservedObject var viewModel: CompanionResponseOverlayViewModel
    let attachesToRightOfCursor: Bool

    private let responseCornerRadius: CGFloat = 19

    var body: some View {
        responseSurface
            .opacity(viewModel.isShowingResponse ? 1 : 0)
            .scaleEffect(
                viewModel.isShowingResponse ? 1 : 0.965,
                anchor: attachesToRightOfCursor ? .topLeading : .topTrailing
            )
            .animation(.spring(response: 0.28, dampingFraction: 0.86), value: viewModel.isShowingResponse)
            .animation(.spring(response: 0.3, dampingFraction: 0.88), value: viewModel.presentationPhase)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    private var responseSurface: some View {
        VStack(alignment: .leading, spacing: 6) {
            YishuSentenceRevealText(
                text: viewModel.streamingResponseText.isEmpty
                    ? "…"
                    : viewModel.streamingResponseText,
                spokenSentenceCount: viewModel.spokenSentenceCount
            )

            if !viewModel.routingMetadataText.isEmpty {
                Text(viewModel.routingMetadataText)
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary.opacity(0.88))
                    .lineLimit(1)
            }

            if !viewModel.memorySourceText.isEmpty {
                Text(viewModel.memorySourceText)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(DS.Colors.overlayCursorBlue.opacity(0.92))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(width: responseContentWidth, alignment: .leading)
        .padding(.horizontal, 15)
        .padding(.vertical, 11)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: responseCornerRadius, style: .continuous)
                    .fill(.ultraThinMaterial)

                RoundedRectangle(cornerRadius: responseCornerRadius, style: .continuous)
                    .fill(
                        LinearGradient(
                            stops: [
                                .init(color: DS.Colors.overlayResponsePearl.opacity(0.94), location: 0),
                                .init(color: DS.Colors.overlayResponsePearl.opacity(0.82), location: 0.62),
                                .init(color: DS.Colors.overlaySpectralAmber.opacity(0.08), location: 1)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )

                RoundedRectangle(cornerRadius: responseCornerRadius, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            stops: [
                                .init(color: Color.white.opacity(0.96), location: 0),
                                .init(color: DS.Colors.overlayCursorBlue.opacity(0.48), location: 0.48),
                                .init(color: DS.Colors.overlaySpectralMagenta.opacity(0.32), location: 0.76),
                                .init(color: DS.Colors.overlaySpectralAmber.opacity(0.36), location: 1)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 0.85
                    )
            }
            .shadow(color: DS.Colors.overlayCursorBlue.opacity(0.07), radius: 6, x: 0, y: 3)
            .shadow(color: Color.black.opacity(0.11), radius: 13, x: 0, y: 6)
        }
    }

    private var responseContentWidth: CGFloat {
        switch viewModel.presentationPhase {
        case .hidden, .thinking:
            return 34
        case .response:
            // One stable measure prevents every token batch from moving the
            // response surface while it is growing line by line.
            return 282
        case .message:
            break
        }

        let singleLineText = viewModel.streamingResponseText
            .replacingOccurrences(of: "\n", with: " ") as NSString
        let font = NSFont.systemFont(ofSize: 13.5, weight: .regular)
        let measuredWidth = ceil(
            singleLineText.size(withAttributes: [.font: font]).width
        )
        return min(max(measuredWidth, 176), 282)
    }

}

// MARK: - Sentence Reveal

/// Sentences fade in as they stream, split by the same boundary rules as the
/// spoken pipeline, so a line settles exactly around when the voice reaches
/// it. Already-spoken lines dim; the unterminated tail grows without
/// re-animating. This replaces the old per-character typer, whose glyph
/// layout re-animated from the first differing character whenever the
/// authoritative final text diverged from the streamed deltas.
private struct YishuSentenceRevealText: View {
    let text: String
    let spokenSentenceCount: Int

    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

    private var segments: [String] {
        Self.displaySegments(in: text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(segments.enumerated()), id: \.offset) { segmentIndex, segment in
                YishuSentenceLine(
                    text: segment.replacingOccurrences(of: "\n", with: " "),
                    isSpoken: segmentIndex < spokenSentenceCount,
                    animateAppear: !accessibilityReduceMotion
                )
            }
        }
    }

    static func displaySegments(in text: String) -> [String] {
        var remaining = text
        var segments: [String] = []
        while let boundary = YishuSpokenReplyBudget.firstSentenceBoundary(
            in: remaining,
            isFinal: true
        ) {
            segments.append(String(remaining[..<boundary]))
            remaining.removeSubrange(..<boundary)
        }
        let tail = remaining.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tail.isEmpty {
            segments.append(remaining)
        }
        return segments
    }
}

private struct YishuSentenceLine: View {
    let text: String
    let isSpoken: Bool
    let animateAppear: Bool

    @State private var appeared = false

    var body: some View {
        Text(text)
            .font(.system(size: 13.5, weight: .regular, design: .default))
            .foregroundColor(
                isSpoken
                    ? DS.Colors.overlayResponseInk.opacity(0.72)
                    : DS.Colors.overlayResponseInk
            )
            .animation(.easeOut(duration: 0.2), value: isSpoken)
            .opacity(appeared ? 1 : 0)
            .offset(y: appeared ? 0 : 3)
            .onAppear {
                guard animateAppear else {
                    appeared = true
                    return
                }
                withAnimation(.easeOut(duration: 0.24)) {
                    appeared = true
                }
            }
    }
}
