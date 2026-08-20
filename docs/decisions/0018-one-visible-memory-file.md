# ADR 0018: One user-visible memory file

Type: decision
Status: current
Verified: kernel 162 tests + runtime everos/recall/assembly pass 2026-08-18
Review: Memory product surface, panel memory UI, or recall source changes

## Status

Accepted 2026-08-18

## Context

ADR 0016 put user-visible markdown under `~/Documents/Yishu/Memory/<scope>/`.
The panel then asked the user to pick 我的 / 项目 / 不保存 before speaking.
The user rejected that: they cannot know before speaking whether a line should be kept, and choosing a bucket is a cost on every turn.

What they want is one file they can see and edit. The agent decides what to write.

## Decision

1. The only user-visible memory file is `~/Documents/Yishu/记忆.md` (env `YISHU_VISIBLE_MEMORY_FILE`).
2. The agent appends only an explicit remember or another product-authorized fact. EverOS search results never write this file.
3. The user's agency is editing that file: add, change, or delete lines. The agent never rewrites an existing line. The panel is a user editor, not a second agent writer: a stale save three-way-merges with the current file so an agent append is not dropped, and a user deletion still wins.
4. If the file exists, ordinary-turn recall reads it. User edits have the highest authority. A hidden `0600` ledger stores SHA-256 fingerprints plus short stripped cores (never the original bullet) so a deleted row suppresses the same fact and a semantically similar restatement. Re-adding the bullet clears that suppression.
5. Opening the file from the panel is access after the fact, not a tax before speaking.
6. EverOS and the homemade truth-layer stay internal. They are not a second product surface.

## Consequences

- Tests that pass `memoryDir` without `visibleMemoryPath` write `<memoryDir>/记忆.md` so they never touch the user's file.
- A deleted bullet stays gone and suppresses an exact or semantically similar EverOS match. Re-adding the bullet clears that suppression.
- Spoken forget removes a matching bullet; an edited line may not match, and the user can delete it in the file.
- Opening the panel on a stale buffer cannot clobber a newer agent append.
