---
name: principle-soft-caps
description: "Apply when you add, keep or review a limit in code, a tool, a brief or a check, such as a count, a length, a name format, a retry or turn bound, a time window, an allow-list or a gate. Model it as a soft cap that states the target, lets the action through and flags it. Keep a hard limit only where precision truly matters."
disable-model-invocation: true
---

# Soft caps

A limit picked without a measurement is a guess. When code enforces that guess by refusing work, the agent loses the turn, routes around the check, or drops the work.

The owner, 2026-10-18: "not just chat messages, but EVERYTHING. duties, plan, chat system, subagents, .. if it's an arbitrary limit enforced in sieun-pi. unless 1000000% absolutely perfect precision ... all these should be modeled as a soft cap."

## What a soft cap does

- It states the target where the agent reads it, in the prompt, the brief or the tool description.
- It lets the action go through.
- It adds a flag when the action passes the target, such as a warning line in the tool result or a check-in finding.
- It never refuses, cuts, truncates or drops work because of the number.

## When a limit stays hard

1. It stays hard when broken input cannot be stored or applied, such as a malformed op, an id that must exist or an all-or-none batch.
2. It stays hard when it guards security, auth or a secret.
3. It stays hard when it guards money.
4. It stays hard when it guards an irreversible send to the outside, such as an email, a ticket reply, an outside message or a post (c37).
5. It stays hard when an outside API or vendor sets it, and the code cites that limit next to the number.
6. It stays hard when it stops an irreversible destructive action on shared state, such as killing the Prime daemon, a force-push or deleting another session's work.
7. It may stay hard as the end condition of an automatic loop with no agent in it, such as retry backoff or a poll.

Write one plain line next to each hard limit that says which of these it is. A hard limit with no such line is a soft cap nobody has converted yet.

## In practice

- Give a new number a measurement, a vendor limit or an incident next to it, or leave the number out (c88).
- Let a guard that enforces an owner style or process correction pass the action and quote the correction in its warning.
- Test a cap by asserting that the action goes through with the warning, never that it is refused.
- When you want to refuse, write the warning text and stop there.
- When a soft cap keeps firing, fix the prompt or the cause, and do not turn it back into a refusal.
