---
name: principle-guard-the-context-window
description: "Apply when context is filling up or about to: large command outputs, long files, repeated reads, screenshots, or planning a fan-out. Send bulk work to subagents and keep only summaries in the main thread."
disable-model-invocation: true
---

# Guard the context window

A session cannot get spent context back, so every token that enters it must change a decision.

- Send verbose outputs, screenshots, and large documents to a subagent, and take back a summary.
- Read only the files and line ranges the current task needs.
- Put templates and references that every run uses in the skill file itself, because a separate file costs a read each time.
- Cap the files per phase and set a turn budget before the work starts.
