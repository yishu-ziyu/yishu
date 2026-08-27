# Release

Type: runbook
Status: current
Verified: local-eval 2026-08-27
Review: signing identity, Sparkle feed, or artifact layout change

Formal release is not `run-local.sh`. Use:

```bash
./scripts/release/build-app.sh
./scripts/release/sign-bundle.sh
./scripts/release/notarize.sh
./scripts/release/build-dmg.sh
./scripts/release/verify-artifact.sh
```

Inputs: `YISHU_RELEASE_VERSION`, Developer ID identity, notary profile, Sparkle private key.
Outputs: signed `.app`, stapled DMG, appcast fragment, SBOM.

Do not ship `.dev.vars`, coverage, `ff.mp3`, browser profiles, or user diagnostics.
`false_completion_count` must be 0 on the RC report or the release stops.
