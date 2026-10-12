---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, and graft the strongest parts of the others into it. Use for `arena`, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Fan out N attempts at the same task. Read every candidate in full, pick the strongest as the base, graft the best ideas from the others into it, and verify the result.

Spawn and drain children per `../setup-pstack/references/prime-agent-runtime.md`. If `RLM_MAX_DEPTH` blocks spawning, run the candidates inline one after another, or ask the parent to fan out.

Write this checklist into your reply before spawning, and update it as phases close:

1. Frame
2. Fan out
3. Cross-judge
4. Pick
5. Graft
6. Verify

## Phase A: Frame

Every candidate gets the same prompt, so settle it before spawning.

1. State the artifact each candidate produces.
2. Write a rubric of 3 to 6 gradeable criteria for this task. `Adds a --dry-run flag that skips writes` is gradeable, and `code is correct` is not. Only the picker sees the rubric.
3. Read the `arena runners` role in `~/.prime/agent/pstack-models.json` (repo default `config/pstack-models.json`) for the runner count and models. With no entry, spawn two runners on the parent's model. Add runners when the arena covers several design directions.
4. Give each candidate its own output path, a git worktree when the task touches a repo, otherwise its own scratch directory. Two candidates never share a path.

## Phase B: Fan out

Spawn all N runners from one cell. Each brief names the task, the shared grounding files, the candidate's output path, and asks for the artifact plus a short rationale. The rationale names the alternatives the candidate considered and why it rejected them. Phase E needs it to tell a deliberate structure from an accident.

If a candidate produces nothing, continue with the rest and record the dropout.

## Phase C: Cross-judge

Spawn the judge only after every Phase B candidate has finished, or it scores partial output. Take its model from the `arena cross-judge pool` role, and use the parent's model when that role is missing. Use a different model family only when the user or the calling skill asks for one.

The brief tells the judge to read and score only and never edit a file. It gets the rubric and the candidates by path label, scores each criterion, and recommends a base with reasons. Read the candidates yourself while it runs.

## Phase D: Pick a base

Read every candidate end to end, then score each one against the rubric criterion by criterion. Compare your scores with the judge's. If you disagree on the base, read both rationales before deciding, because one of you is biased or the rubric is ambiguous.

Pick the candidate a future maintainer can extend without breaking its invariants. On a tie, take the smaller surface per **principle-laziness-protocol**.

## Phase E: Graft

Walk each other candidate once more and find the one or two ideas worth porting. Fold each one into the base by hand per **principle-redesign-from-first-principles**, so the result keeps one mental model.

If the candidates converge on one shape, ship it and record the convergence. If they diverge widely, Phase A was under-specified, so reframe and re-run instead of averaging.

## Phase F: Verify

Verify the result per **principle-prove-it-works**. If verification finds a problem, either the frame was wrong (go back to Phase A) or a candidate caught it and you missed the graft (go back to Phase E).

## Output

Ship the synthesized artifact with a short synthesis note next to it. The note names the base and why, the judge's verdict, each graft with its source candidate, each rejected idea with the reason, any dropouts, and the verification result.
