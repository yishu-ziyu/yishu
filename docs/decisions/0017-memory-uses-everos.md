# ADR 0017: Long-term memory is EverOS, not a Yishu rewrite

Type: decision
Status: current
Verified:
Review: Memory write, recall, or sidecar changes (supersedes the homemade implementation of ADR 0013 / 0016)

## Status

Accepted 2026-08-18

## Context

ADR 0013 adopted EverOS as the memory backbone, then Yishu rewrote extract, markdown truth, a queue, and keyword recall in TypeScript.
That rewrite is a second memory product.
The user rejected reinventing a system the market already has.

EverOS (Apache-2.0) already exposes the loop we need:

```text
POST /api/v2/memory/add
POST /api/v2/memory/flush
POST /api/v2/memory/search   (method=keyword without embeddings)
POST /api/v2/memory/get
```

## Decision

1. Vendor EverOS at `vendor/everos` and run that code.
2. Yishu owns only: when to call it, private-session refusal, secret refusal, Clicky UI, conversation ledger.
3. Ordinary completed turns use `add(defer_extraction=true)`. One conversation is flushed after 30 seconds idle or during runtime disposal; explicit remember flushes immediately.
4. Ordinary-turn recall uses EverOS search as a candidate source. The user-visible authority layer filters suppressed rows before prompt assembly.
5. Do not write API keys into `everos.toml`. A product-owned instance reuses Yishu's authenticated loopback model gateway; explicit `EVEROS_LLM__*` environment values remain an operator override.
6. Homemade `extraction.ts` / `truth-layer.ts` / store `MemoryClaim` remain only as a fallback when EverOS is not wired (tests and `YISHU_EVEROS=0`).
7. ADR 0013 invariants that stay: private has no memory; secrets never persist.
8. The user-visible surface is one file (`~/Documents/Yishu/记忆.md`). See ADR 0018. The EverOS root is private engine storage under `~/Library/Application Support/Yishu/EverOS` with mode `0700`.
9. An existing EverOS server is attachable only through an explicit `YISHU_EVEROS_URL`. Otherwise the runtime starts and owns its server on the product port. There is no port-18000 or Jarvis identity fallback.
10. The product-owned server runs EverOS `chat` mode. Recall consumes explicit profile items; derived summaries and implicit traits do not become product facts.
11. User and assistant sender IDs must be distinct. The product identity is `app=yishu`, `user=owner`, `assistant=yishu`, `project=personal` unless explicitly configured.
12. On the first product-owned start, legacy Markdown from the former `~/.everos/jarvis/yishu/users/yishu` partition is copied into the new identity. Index databases and process state are not copied; EverOS rebuilds them from Markdown.
13. A private `0600` recovery file stores only pending session IDs and scopes. A restart flushes those EverOS buffers before accepting new memory writes; no conversation text is duplicated into this file.
14. A TaskTruth with a verified external result (`resultKind=succeeded`) is ingested into a separate EverOS session `task:<taskId>`. Conversation-only completion, failure, cancellation, and private sessions do not ingest. EverOS must not auto-promote that write into a product Skill.

## Consequences

- Product runtime starts a loopback EverOS server (`127.0.0.1`, not `0.0.0.0`) and disposes the process it owns.
- Clicky install ensures the EverOS venv via `packages/runtime/scripts/ensure-everos.sh`.
- Panel list/forget still reads the Yishu store until EverOS grows a memory-delete API; listed store rows are a panel cache, not a second extract pipeline.
- Search results never write directly into the visible memory file.
