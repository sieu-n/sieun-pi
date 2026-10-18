### Bug fix

Delegate the investigation and the fix to subagents, and stay in the lead. Every shipped line must trace to runtime evidence. When evidence refutes a hypothesis, revert what it motivated.

1. Reproduce the bug yourself on the real surface. Do not hand the repro to the user, even if a debug protocol says to. Ask the user only when you can name why your tools cannot reach the target, after you drove them as far as they go. If the bug will not reproduce, force it by building the trigger, tightening conditions, or adding instrumentation.
2. Binary-search the cause. Seed hypotheses with the how skill over the subsystem and the why skill for regression history. Take the split that removes the most of the search space, get runtime evidence, and rule hypotheses out. Add logging when program state is unclear. Confirm the surviving mechanism with runtime evidence before you design the fix.
3. Plan the fix. Use the architect skill if it crosses a function boundary. Delegate the change to a subagent with a narrow scope, using the bug-fix role from the model policy in Subagents. Review the diff.
4. Verify on the same surface that the original repro now passes. An inconclusive result or a different surface is not a pass. Unit tests alone do not prove the bug is gone.
5. Commit the failing repro before the fix when a cheap local test exists. Skip the test when it would be expensive or unclear.
6. Run `playbooks/opening-a-pr.md`.

Reply with what was broken, the root cause, the fix, and how you verified it. Paste the failing and passing repro output.
