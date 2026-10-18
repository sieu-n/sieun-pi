---
name: principle-make-operations-idempotent
description: "Use when designing a command, lifecycle step, or processing loop that can crash, restart, or retry. Make it reach the same end state no matter how many times it runs or where a prior run stopped."
disable-model-invocation: true
---

# Make operations idempotent

Every operation that changes state must reach the correct end state no matter how many times it runs or where a prior run stopped.

## The pattern

- On startup, scan for existing state, clean up stale artifacts, and adopt live sessions.
- Compare artifacts by content when cleaning up, not by creation order.
- Detect a stale lock by checking whether the PID that holds it is still alive.
- Let failed work respawn cleanly, and regenerate fresh input after each cycle.

## The test

1. Ask what happens if the operation runs twice in a row.
2. Ask what happens if the previous run crashed at each possible point.
3. Check that a rerun reaches the same end state.

If an answer depends on what state a prior run left behind, add a step that reconciles that state first.
