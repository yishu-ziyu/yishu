# Clicky presence research

Source inspected read-only: `/Users/mahaoxuan/clicky-upstream`.

## Confirmed active implementation

- `leanring-buddy/OverlayWindow.swift` creates one full-screen transparent overlay per display. It is click-through, cannot become key or main, joins all Spaces, and sits at the screen-saver window level.
- The visible companion is a 16-by-16 blue triangle, not an avatar panel. It samples `NSEvent.mouseLocation` every 16 milliseconds and places its visual center roughly 35 points right and 25 points below the physical cursor.
- Listening replaces the triangle with a five-bar waveform. Processing replaces it with a 14-point spinner.
- The cursor overlay is not clickable. Clicky's interactive entry is its menu-bar item.
- The active overlay shows text for first-run onboarding and target pointing. `CompanionResponseOverlay.swift` contains a general response panel, but no live call site was found in the current source.

## Yishu v0.0.1 mapping

- Use a 16-point `✿` inside a 28-point click-through panel, following at approximately 60 Hz with Clicky's cursor offset.
- Use waveform and spinner states for listening and thinking.
- Use the menu-bar `✿` and authorized Control+Option push-to-talk as interactive entry points.
- Keep Yishu's response bubble as an intentional voice-product addition, but show it only during onboarding, listening, thinking, speaking, or failure; hide it during ordinary idle presence.
- The first slice moves a small panel across displays rather than maintaining one full-screen overlay per display. If WindowServer churn or cross-display flicker appears, migrate to Clicky's per-display overlay architecture without changing the product contract.
