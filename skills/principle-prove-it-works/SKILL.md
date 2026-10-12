---
name: principle-prove-it-works
description: "Apply after finishing a task and before saying it is done. Check the real result: run the feature, read the actual value, inspect the diff. A proxy, a self-report, or a clean compile does not count."
disable-model-invocation: true
---

# Prove it works

Before you call a task done, check the real result directly. A proxy, a self-report, or a clean compile is not proof.

## Check the real thing

- Check that a process is alive by asking the process, not by reading state it left behind.
- Read the actual value, not a cached or derived copy of it.
- When a check fails, suspect your way of observing before you suspect the system.

## Code and features

1. Build it, and treat a passing build as the first step only.
2. Run it and use the feature path a user would use.
3. Follow the data from input to output.
4. For an integration, test the whole path end to end.

## Delegated work

Inspect the artifact the delegate produced, such as the git diff, the file contents, or the runtime behavior. Do not accept its summary, because agents report what they meant to do.

## Script the check

Prefer a script that runs the same comparison again over a one-time look. Run it and keep its output where a reviewer can run it again. For a large port or migration that needs an audit trail, commit the artifact with the `show-me-your-work` skill. For other work, keep it visible and do not commit it.
