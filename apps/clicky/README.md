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
- stable `com.yishu.yishu-buddy` signing/TCC identity and
  `/Applications/Clicky.app` install path.

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
import; those require the normal Yishu acceptance checks.
