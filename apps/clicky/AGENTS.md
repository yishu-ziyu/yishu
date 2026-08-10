# Yishu formal Clicky shell

`apps/clicky` is the product-owned macOS interaction shell. It owns the menu
bar presence, cursor companion, push-to-talk voice path, permissions, TTS,
context capture, and the bundled Yishu runtime handoff.

## Boundaries

- Keep the `leanring-buddy.xcodeproj`, target, scheme, and source-directory
  spelling unchanged. They are legacy names relied on by local signing and
  TCC continuity.
- Keep `com.yishu.yishu-buddy`, `/Applications/Clicky.app`, the local signing
  identity, login-item behavior, and existing UserDefaults semantics unchanged.
- Product task state comes from the typed Yishu runtime protocol. Do not add a
  second brain, compatibility bridge, or parallel progress transport here.
- API credentials stay in local provider configuration. Never commit or log
  `worker/.dev.vars`, raw tokens, screenshots, or private conversation data.
- `apps/macos` remains a development harness; this directory is the formal
  shipping shell.

## Local workflow

Use `scripts/run-local.sh` for the signed local path when a human has approved
an actual build/run. It derives the monorepo root from its own location while
allowing `YISHU_RUNTIME_ROOT` and `YISHU_NODE_SOURCE` overrides.

Do not run the build, install, TCC pinning, or app launch as part of source
imports or static reviews. Do not rename the project or change its bundle
identity to make two shells appear concurrently installed.
