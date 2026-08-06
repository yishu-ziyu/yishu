---
name: research
description: Offline research and search workflow for gathering structured evidence
---

# Research skill

When the user asks to search, research, or 查资料:

1. Call `web_search` with a focused query.
2. Summarize only from tool results; never invent URLs.
3. If results are stubs (offline), say so briefly.
4. Prefer short bullet findings over long essays.
