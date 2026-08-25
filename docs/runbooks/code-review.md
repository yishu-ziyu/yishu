# Code review (Matt two-axis)

Type: runbook
Status: current
Verified: e49ac5a 2026-08-18
Review: when the review trigger, spec-source order, or report shape changes

Use this only when the user types `/code-review` / `/review` or explicitly asks for two-axis review. Do not auto-run after implement. Do not replace tests or `run-local.sh`.
Canonical method: Matt `/code-review` (Standards × Spec, two parallel agents, never one ranked list).
Playbook page: `/Users/mahaoxuan/Desktop/coding/wiki/skills/code-review.md`

## When

- The user invoked `/code-review`, `/review`, or asked to review a named baseline.
- A PR or WIP the user pointed at.
- Not after ordinary implement/fix. Not for chat-only questions, translations, or source-import static reads.

## Pin the fixed point

1. Use the SHA / branch / tag the human named.
2. If they did not name one: uncommitted WIP → `HEAD` plus the working tree; a branch PR → `git merge-base HEAD main`.
3. Confirm the ref: `git rev-parse <fixed-point>`.
4. Capture the range:
   - Commits: `git log <fixed-point>..HEAD --oneline`
   - Committed: `git diff <fixed-point>...HEAD` (three-dot)
   - WIP: also `git diff HEAD` and untracked files in the slice
5. Empty range or bad ref: stop. Do not spawn reviewers.

Do not review the whole dirty tree because it is dirty. Name the slice that belongs to this Goal.

## Spec source (first hit wins)

1. Issue / ADR / ticket id in the commit messages.
2. Path the human passed.
3. Matching file under `docs/decisions/`, `docs/acceptance/`, `docs/runbooks/`, or the Goal / Hard bar written for this implement.
4. `AGENTS.md` `## Lessons` that this change exists to keep.
5. If none: ask. If they say there is no spec, skip the Spec agent and report `no spec available`.

Do not invent a spec from the diff.

## Standards source

Always load, in this order (later files do not erase earlier ones; repo text wins over the smell baseline):

- Root `AGENTS.md` (invariants, lessons, verification)
- Nearest nested `AGENTS.md` (`apps/clicky/AGENTS.md` when Clicky is in the slice)
- ADRs cited by the slice
- `docs/runbooks/verification.md` and `docs/runbooks/product-development.md`
- User coding standards: `llm-coding-behavior`, `quality-bar`, `small-coherent-diffs`
- Fowler smell baseline from the Matt skill (judgement calls only; skip what tooling already enforces)

## Run

Spawn two **general-purpose** read-only agents in the same turn. Each brief stays under 400 words.

| Agent | Reports | Must include |
|-------|---------|--------------|
| Standards | Documented-rule breaches (cite file + rule) and named smells (quote hunk) | Diff command, commit list, standards paths, full smell baseline |
| Spec | Missing / extra / wrong vs spec lines | Diff command, commit list, spec path or quoted spec |

Reviewers do not edit product code. They do not run `run-local.sh`.

## Report

Keep `## Standards` and `## Spec` as two headings. Do not merge or re-rank across axes.
Last line of each axis: finding count + worst item on that axis.

## Yishu extras

- User-visible Clicky change: review does not replace launching `/Applications/奕枢.app`.
- Do not treat `vendor/everos` as product code unless the slice edits the vendored tree.
- Secrets, screenshots, and `记忆.md` contents are out of the review package.
