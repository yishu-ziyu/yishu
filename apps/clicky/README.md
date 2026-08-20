# Yishu Clicky shell

This is the product-owned macOS menu-bar shell for Yishu. It is intentionally
kept as ordinary source inside the Yishu repository so the shell and its
runtime integration can be reviewed together, while the historical external
checkouts remain untouched.

The app keeps the existing Clicky interaction contract:

- menu-bar companion and cursor-following overlay;
- Control + Option push-to-talk with StepFun transcription;
- one evidence-bearing context frame per turn;
- five-second, metadata-only recent context sampling with exact personal/project scope and a pre-capture private-mode gate;
- bundled Pi/Yishu runtime with the explicit model allowlist;
- MiniMax speech output and verified cursor pointing/clicking;
- verified Finder history-back, focused writable-field text entry, and one-shot Apple Notes creation with exact read-back;
- an explicit current-page request can turn 1–3 visible action items from the
  active window into that one new note; it uses one window image, never scrolls
  or reads other windows, and cannot edit or delete existing notes. A window
  change blocks creation, and the semantic result still awaits a human demo;
- a typed delegated-task snapshot restored when Pi becomes ready, with
  acknowledged cancellation and event-backed `SystemSequence` steps;
- one quiet-window return of a terminal background result beside the cursor,
  without creating a fake turn or consuming its follow-up context;
- one-shot reminders: an application-return reminder waits for a
  post-creation departure and returns exactly once, while an explicit relative
  “X minutes/hours from now” reminder uses the system notification so it still
  arrives through sleep, exit, or restart; first-time notification permission
  is not reported as set until the pending request is read back exactly, and
  an unknown result is never retried. Reminder delivery shows the foreground
  banner immediately, speaks once after the quiet window without losing it
  across conversations, and never replays from a history click or PTT
  interruption; absolute dates, repeats, list/edit/delete, and the real
  voice-at-due-time chain remain human-acceptance gaps;
- sentence-level serial TTS for pure conversation, with desktop-effect turns
  held final-only; a PTT keydown immediately stops old audio and old
  presentation;
- same-session continuation only while the interrupted turn is pure
  conversation and no desktop effect has begun; screen-dependent, effectful,
  or uncertain input starts a new turn from fresh context;
- independent Runtime and Clicky ownership fences drop stale output and block
  stale desktop effects; the model switches at a safe reply boundary, not at
  an arbitrary provider token;
- stable `com.yishu.yishu-buddy` signing/TCC identity and
  `/Applications/奕枢.app` install path.

Cold Runtime sessions rehydrate a bounded visible window from Kernel's exact
conversation/scope, while hot Pi sessions keep their own transient context.
Runtime failure gets a bounded restart and then an honest failure message; the
shipping conversation never forks into Clicky's onboarding `/chat` helper.

The loopback voice service requires a per-App-process bearer capability, rejects
browser origins, bounds bodies/upstream responses/concurrency, and receives a
minimal child environment. Clicky and its Runtime run as one process-owned App
instance; credentials and input text are not placed in action receipts.

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
import; task-card clicks, `SystemSequence` layout, physical push-to-talk,
same-session interruption cutover, TTS, signing/TCC continuity, restart
delivery, and visible final state still require the normal human Yishu
acceptance checks.
