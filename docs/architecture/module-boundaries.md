# Module boundaries

Type: architecture
Status: current
Verified: local-eval 2026-08-27
Review: god-file split, new domain service, or forbidden dependency change

## Allowed direction

```
Swift UI / Voice / Presence
        ↓
Swift Coordinators
        ↓
Versioned Runtime Client + Privileged Executor
        ↓
Runtime Application Services
        ↓
Kernel domain ports
        ↓
Store implementations
```

## Forbidden

- Kernel importing Runtime or AgentCore
- Runtime importing AgentCore
- Executor depending on CompanionManager UI state
- Store implementations deciding product policy
- Model-supplied `approved: true` as authorization

## Phase 0 ratchet

`docs/architecture/refactor-ratchet.json` records current god-file sizes and circular-edge count. A PR may only keep or lower those numbers. See `script/check-architecture-ratchet.mjs`.
