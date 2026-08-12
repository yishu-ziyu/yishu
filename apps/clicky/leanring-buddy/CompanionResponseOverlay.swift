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

@MainActor
final class CompanionResponseOverlayViewModel: ObservableObject {
    @Published var streamingResponseText: String = ""
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
        viewModel.memorySourceText = ""

        withAnimation(.easeOut(duration: 0.14)) {
            viewModel.presentationPhase = .thinking
        }
    }

    func showOverlayAndBeginStreaming() {
        showThinking()
    }

    func updateStreamingText(_ accumulatedText: String) {
        viewModel.streamingResponseText = accumulatedText
        guard !accumulatedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        viewModel.presentationPhase = .response
    }

    func updateMemorySourceText(_ text: String?) {
        viewModel.memorySourceText = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    func finishStreaming() {
        cancelScheduledHide()

        // Six seconds preserves the existing reading window after streaming.
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
        viewModel.memorySourceText = ""
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
        viewModel.memorySourceText = ""
    }

    private func fadeOutAndHide() {
        withAnimation(.easeInOut(duration: 0.32)) {
            viewModel.presentationPhase = .hidden
        }

        // Keep the final glyphs alive until the opacity transition finishes.
        let clearWorkItem = DispatchWorkItem { [weak self] in
            self?.viewModel.streamingResponseText = ""
            self?.viewModel.memorySourceText = ""
        }
        clearTextWorkItem = clearWorkItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.34, execute: clearWorkItem)
    }

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
            YishuTyperText(
                text: viewModel.streamingResponseText.isEmpty
                    ? "…"
                    : viewModel.streamingResponseText
            )

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

// MARK: - Typer Reveal

private struct YishuTyperText: View {
    let text: String

    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion
    @State private var previousCharacters: [Character] = []
    @State private var glyphRevealStartTimes: [Int: TimeInterval] = [:]

    private var normalizedCharacters: [Character] {
        Array(text.replacingOccurrences(of: "\n", with: " "))
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 20.0)) { timelineContext in
            YishuCharacterFlowLayout(horizontalSpacing: 0, verticalSpacing: 3) {
                ForEach(Array(normalizedCharacters.enumerated()), id: \.offset) { characterIndex, character in
                    YishuTyperGlyph(
                        character: character,
                        phase: revealPhase(
                            for: characterIndex,
                            timelineDate: timelineContext.date
                        )
                    )
                }
            }
        }
        .onAppear {
            synchronizeRevealTimes(with: normalizedCharacters)
        }
        .onChange(of: text) { _ in
            synchronizeRevealTimes(with: normalizedCharacters)
        }
    }

    private func synchronizeRevealTimes(with nextCharacters: [Character]) {
        guard !accessibilityReduceMotion else {
            previousCharacters = nextCharacters
            glyphRevealStartTimes = [:]
            return
        }

        let sharedPrefixCount = zip(previousCharacters, nextCharacters)
            .prefix { previousCharacter, nextCharacter in
                previousCharacter == nextCharacter
            }
            .count
        let currentTime = Date.timeIntervalSinceReferenceDate

        glyphRevealStartTimes = glyphRevealStartTimes.filter { characterIndex, _ in
            characterIndex < sharedPrefixCount && characterIndex < nextCharacters.count
        }

        if sharedPrefixCount < nextCharacters.count {
            for characterIndex in sharedPrefixCount..<nextCharacters.count {
                let waveOffset = Double(characterIndex - sharedPrefixCount) * 0.04
                glyphRevealStartTimes[characterIndex] = currentTime + waveOffset
            }
        }

        previousCharacters = nextCharacters
    }

    private func revealPhase(
        for characterIndex: Int,
        timelineDate: Date
    ) -> YishuTyperGlyphPhase {
        guard !accessibilityReduceMotion,
              let revealStartTime = glyphRevealStartTimes[characterIndex] else {
            return .settled
        }

        let revealAge = timelineDate.timeIntervalSinceReferenceDate - revealStartTime
        switch revealAge {
        case ..<0:
            return .waiting
        case ..<0.12:
            return .highlighted
        case ..<0.26:
            return .accented
        case ..<0.52:
            return .settling
        default:
            return .settled
        }
    }
}

private enum YishuTyperGlyphPhase {
    case waiting
    case highlighted
    case accented
    case settling
    case settled
}

private struct YishuTyperGlyph: View {
    let character: Character
    let phase: YishuTyperGlyphPhase

    var body: some View {
        Text(String(character))
            .font(.system(size: 13.5, weight: .regular, design: .default))
            .foregroundStyle(glyphColor)
            .opacity(glyphOpacity)
            .scaleEffect(glyphScale, anchor: .center)
            .background {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(glyphHighlightColor)
                    .padding(.horizontal, -1.2)
                    .padding(.vertical, -2)
            }
    }

    private var glyphColor: Color {
        switch phase {
        case .waiting:
            return Color.clear
        case .highlighted:
            return Color.white
        case .accented:
            return DS.Colors.overlaySpectralViolet
        case .settling:
            return DS.Colors.overlayCursorBlue
        case .settled:
            return DS.Colors.overlayResponseInk
        }
    }

    private var glyphHighlightColor: Color {
        switch phase {
        case .highlighted:
            return DS.Colors.overlayCursorBlue.opacity(0.78)
        case .accented:
            return DS.Colors.overlaySpectralViolet.opacity(0.14)
        case .waiting, .settling, .settled:
            return Color.clear
        }
    }

    private var glyphOpacity: Double {
        phase == .waiting ? 0 : 1
    }

    private var glyphScale: CGFloat {
        switch phase {
        case .waiting:
            return 0.88
        case .highlighted:
            return 0.94
        case .accented:
            return 1.045
        case .settling, .settled:
            return 1
        }
    }
}

private struct YishuCharacterFlowLayout: Layout {
    let horizontalSpacing: CGFloat
    let verticalSpacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        layoutResult(proposal: proposal, subviews: subviews).size
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let result = layoutResult(proposal: proposal, subviews: subviews)
        for (characterIndex, characterOrigin) in result.characterOrigins.enumerated() {
            subviews[characterIndex].place(
                at: CGPoint(
                    x: bounds.minX + characterOrigin.x,
                    y: bounds.minY + characterOrigin.y
                ),
                anchor: .topLeading,
                proposal: .unspecified
            )
        }
    }

    private func layoutResult(
        proposal: ProposedViewSize,
        subviews: Subviews
    ) -> YishuCharacterLayoutResult {
        let maximumLineWidth = max(proposal.width ?? 282, 1)
        var characterOrigins: [CGPoint] = []
        var currentX: CGFloat = 0
        var currentY: CGFloat = 0
        var currentLineHeight: CGFloat = 0
        var widestLine: CGFloat = 0

        for subview in subviews {
            let characterSize = subview.sizeThatFits(.unspecified)
            let characterWouldOverflow = currentX > 0
                && currentX + characterSize.width > maximumLineWidth

            if characterWouldOverflow {
                widestLine = max(widestLine, currentX - horizontalSpacing)
                currentX = 0
                currentY += currentLineHeight + verticalSpacing
                currentLineHeight = 0
            }

            characterOrigins.append(CGPoint(x: currentX, y: currentY))
            currentX += characterSize.width + horizontalSpacing
            currentLineHeight = max(currentLineHeight, characterSize.height)
        }

        widestLine = max(widestLine, max(currentX - horizontalSpacing, 0))
        let totalHeight = subviews.isEmpty ? 0 : currentY + currentLineHeight
        return YishuCharacterLayoutResult(
            size: CGSize(width: min(widestLine, maximumLineWidth), height: totalHeight),
            characterOrigins: characterOrigins
        )
    }
}

private struct YishuCharacterLayoutResult {
    let size: CGSize
    let characterOrigins: [CGPoint]
}
