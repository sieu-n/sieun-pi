---
name: principle-fix-root-causes
description: "Use when debugging a crash, a wrong result, or a failure after restart. Trace each symptom to its root cause and fix it there instead of adding a guard that hides it."
disable-model-invocation: true
---

# Fix root causes

When you debug, trace the problem to its root cause and fix it there. Do not add a workaround that hides the symptom.

1. Reproduce the failure first, so you can check the fix.
2. Read the real error, and add logging instead of guessing.
3. Ask why until you reach the cause.
4. Do not add a guard, such as a nil check, only to stop a crash.
5. If a workaround needs a long comment to justify it, fix the code instead.
6. Search for the same pattern elsewhere and fix every instance.

## Failures after a restart

If something fails after a restart, check stale persistent state before the code: config files, caches, lock files, and serialized state. If clearing a state file fixes the failure, add validation for that state.
