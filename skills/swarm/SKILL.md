---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for `swarm`, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

> **Prime Agent subagent contract.** This skill was ported from a Cursor plugin.
> Subagents are `handle = await rlm(brief, model=..., thinking=..., name=...)`, which
> returns on admission and never returns the child's answer: every brief must end with
> `await agent_message.send(<report>, receiver_role="parent")`. Read
> `~/.prime/agent/skills/setup-pstack/references/prime-agent-runtime.md` before fanning out,
> and check `RLM_MAX_DEPTH` — at the ceiling `await rlm(...)` raises and you must run inline.


Fan out N parallel RLM children. They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

## Start

Prime Agent has no todo tool. Write the phase checklist into your reply, or into a scratch file under `/tmp/`, before launching anything, and update it as phases close.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers. Prime Agent has no cloud concurrency limit; the real ceilings are this machine and `RLM_MAX_DEPTH`.
4. Pick the worker model from `swarm workers` in `~/.prime/agent/pstack-models.json` when present. Otherwise use `anthropic/claude-fable-5-1 @ xhigh`. For a model race, name each arm's model up front.
5. Give each worker its own writable output when it writes. Use a worktree, branch, or `/tmp/swarm-<slug>/worker-<n>/`.

## Phase B: Fan out

Spawn all N workers from one IPython cell: call `await rlm(brief, model=..., thinking=..., name=f"swarm-{n}")` once per worker. Each call returns a handle as soon as the child is admitted, so the loop starts every worker before any of them finish. There is no `subagent_type` and no cloud/local switch: every RLM child is a general-purpose Prime Agent running as its own background process on this machine, with the same filesystem access as you.

There is no `cloud_base_branch`. When a worker must start from another branch, create a git worktree for it first and name that path in the brief.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
