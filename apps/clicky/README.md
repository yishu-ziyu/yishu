# Yishu Clicky shell

This is the product-owned macOS menu-bar shell for Yishu. It is intentionally
kept as ordinary source inside the Yishu repository so the shell and its
runtime integration can be reviewed together, while the historical external
checkouts remain untouched.

The app keeps the existing Clicky interaction contract:

- menu-bar companion and cursor-following overlay;
- Control + Option push-to-talk with StepFun transcription;
- one evidence-bearing context frame per turn;
- bundled Pi/Yishu runtime with the explicit model allowlist;
- MiniMax speech output and verified cursor pointing/clicking;
- a typed delegated-task snapshot restored when Pi becomes ready, with
  acknowledged cancellation and event-backed `SystemSequence` steps;
- stable `com.yishu.yishu-buddy` signing/TCC identity and
  `/Applications/Clicky.app` install path.

If the Pi sidecar stops, Clicky keeps the task card and says truthfully:
`任务已中断。可以从头重试，或开始一个新方向。` It does not claim that
execution progress was saved. “从头重试” starts a new request after the
foreground turn is idle; “开始新方向” returns the user to the physical
Control + Option push-to-talk entry. A cancel action remains visibly pending
until `task.cancel.accepted` arrives, and a rejection is shown instead of
pretending the task stopped.

## Layout

- `leanring-buddy.xcodeproj` — legacy Xcode project, target, and scheme names
  are retained intentionally.
- `leanring-buddy/` — Swift app and product resources.
- `worker/` — local loopback proxy source. Create `worker/.dev.vars` locally;
  never commit it.
- `scripts/run-local.sh` — signed local build/package path. It derives the
  Yishu monorepo root from `apps/clicky` and accepts environment overrides.

See [PROVENANCE.md](PROVENANCE.md) for the import boundary and source
snapshot. A build or real-device interaction is not implied by this source
import; task-card clicks, `SystemSequence` layout, physical push-to-talk, TTS,
signing/TCC continuity, restart delivery, and visible final state still require
the normal human Yishu acceptance checks.
