---
name: memory
description: Remember user preferences and recall them on demand
---

# Memory skill

When the user says 记住 / remember:

1. Call `memory_write` with clear content and tags like `user`.
2. Confirm briefly what was stored.

When the user asks 我偏好 / 记得我 / what do you know about me:

1. Call `memory_search` first.
2. Answer only from hits; if empty, say so and invite a remember command.
