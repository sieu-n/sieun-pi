---
name: swarm
description: "Fan out N parallel workers, collect their reports, and return one report. Use for `swarm`, 'swarm this', coverage matrices, races between workers, gauntlets, and exploration split into slices."
disable-model-invocation: true
---

# Swarm

Fan out N parallel RLM children that cover separate slices, race the same brief, or both. Then collect their results and return one report.

Read `~/.prime/agent/skills/setup-pstack/references/prime-agent-runtime.md` before you fan out. It covers `rlm.spawn`, the report line every brief must end with, and the `RLM_MAX_DEPTH` ceiling. At the ceiling, run the work inline.

Write this checklist in your reply before you spawn anything, and update it as each phase closes.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Frame

1. State the done predicate and the artifact or report the swarm returns.
2. Choose the shape: slices, a race of N workers on the same brief, or a mix. For a race or a mix, declare the selection rule (`first pass`, `rank all`, or `best-of`) before you spawn.
3. Take N from the user or from the shape. N is the total number of workers.
4. Take the worker model from the `swarm workers` role in `~/.prime/agent/pstack-models.json` (repo default `config/pstack-models.json`). For a model race, name each arm's model before you spawn.
5. Give each worker that writes files its own output: its own files in the shared checkout, committed on that checkout's branch, or a folder under your scratch folder, such as `~/scratch/<session id>/swarm-<slug>/worker-<n>/`. The repo copy guard refuses `git worktree add` in every repo (c193), and your job's end deletes your scratch folder.

## Fan out

Spawn all N workers from one IPython cell with `name=f"swarm-{n}"`. `rlm.spawn` raises when one of your children already has that name, so a second swarm in the same session adds its slug, as in `name=f"swarm-{slug}-{n}"`.

Each brief stands alone. It gives the goal, the scope, the exact slice or race arm, how to verify, and what to report. Workers report `PASS`, `ISSUES`, or `BLOCKED` with evidence.

If a worker drops out, continue with N-1 and record it.

## Aggregate

For coverage, every required slice needs a result. For a race, apply the selection rule you declared. Do not paste raw worker output.

## Report

Return one report in chat with a compact result table, one line per issue with its evidence, the gaps and dropouts, and the race rule if you used one.
