# Rollback

Type: runbook
Status: current
Verified: local-eval 2026-08-27
Review: Sparkle channel or schema migration change

1. Keep the previous GitHub Release and DMG.
2. Point Sparkle appcast to N-1.
3. Do not delete the failing tag until the next RC is notarized.
4. Schema migrations must keep N-1 readable.
5. If a false completion shipped, pause automation rules and revoke the build.
