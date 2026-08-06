---
name: coding
description: Arithmetic, file edits, and safe code_exec in the workspace
---

# Coding skill

When the task needs computation or file changes:

1. Use `code_exec` for pure arithmetic only (no arbitrary code).
2. Use `list_dir` / `read_file` before editing when path is unclear.
3. Use `write_file` under workspace; never escape the sandbox.
4. Report the numeric result or written path from tool evidence.
