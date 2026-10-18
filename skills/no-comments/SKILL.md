---
name: no-comments
description: "Strip comments from a diff before review. A comment-hating subagent deletes comments and flags code to reshape; you check its work, fix accepted flags, and offer to encode claimed constraints. Use before review, or when asked to remove comments from files or a diff."
disable-model-invocation: true
---

# No comments

You wrote these comments, so you will want to keep them. Defer to the child's judgment.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base branch, default `main`, including the working tree.

## Steps

1. Spawn one child named `comment-sicko` per `../setup-pstack/references/prime-agent-runtime.md`. Its brief is the full text of `references/comment-sicko.md` in this skill directory, then the scope, then the report line. Take the model from `~/.prime/agent/pstack-models.json`. If `RLM_MAX_DEPTH` blocks the spawn, apply the persona inline and say so in the report.
2. Check the child's report and diff.
   - Reject edits to application code, edits outside the scope, deletions of comments an exception protects, `MUST KILL` flags with a wrong reason, and flags against intentional code that stays.
   - Keep `MUST KILL` flags that ask to reshape a surprise in our own code, and do not restore those comments.
   - Keep a comment only with proof that it is about something we cannot change.
   - Find lint and TypeScript suppressions in scope that the child missed. A suppression that protects correctness or safety becomes a `MUST KILL`.
   - Restore a deleted comment only when you can name its exact exception and prove it inside the scope.
   - Before you accept a thin `IMPORTANT` or `do not remove` kill or keep, run the `how` or `why` skill on its symbol. Leave an ambiguous kill deleted. Delete a keep that is refuted or still ambiguous.
   - If you reject the report, revert the child's diff and rerun it once with the failure named. If you reject the second report, report it open and fail `no-comments`.
3. Fix trivial accepted flags directly, for example by deleting a dead path, dropping a parameter, or using the real API. If any fix needs a new shape, run the `architect` skill once over the accepted set and the code around it. Stop at its sketch.
4. Implement the smallest root-cause fix in scope and remove every named workaround. Apply `principle-fix-root-causes` and the redesign-from-day-one rule in poteto-mode's Principles inside the scope only. If the root cause is outside the scope, land the smallest in-scope fix and report the rest open.
5. Handle constraint comments such as `do not remove`, `do not change wording`, or `talk to X before changing`. Leave keeps about things we cannot change. For the rest, offer the cheapest in-scope type, runtime check, test, or CI lint that enforces the constraint. Wait for approval in an interactive session. Unattended and eval runs need approval from the caller up front. If approved, add the check and delete the comment. Otherwise delete the comment, report the constraint open, and sketch the out-of-scope work.
6. Report the deletion count, restored comments, reruns, the architect sketch, fixes, encoding offers, encodings added, unenforced constraints, and other open work.
