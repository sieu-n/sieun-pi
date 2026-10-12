---
name: principle-build-the-lever
description: "Apply to any non-trivial edit, migration, analysis, or check. Build the tool that does or proves the work (a codemod, script, generator, or a skill your subagents follow) instead of working by hand. The tool is the artifact a reviewer reruns."
disable-model-invocation: true
---
# Build the lever

When the work is not trivial, build the tool that does it or proves it. A reviewer can rerun a tool, and can only check a hand edit by redoing it.

Skip the tool only for a couple of obvious edits you can see at a glance. A one-off task still gets a tool when the tool is what makes the work checkable.

## Steps

1. Do the first unit by hand to learn the recipe.
2. Build the tool, and make it safe to rerun.
3. Rerun it on the first unit and diff the result against your hand-done version.
4. Commit the tool when the work outlives the session, so the next run reruns it.

## Pick the tool

- Use a codemod or script for edits.
- Use a generator for repetitive files.
- Use a query over a SQLite dump for analysis.
- Use a rerunnable check for verification.
- Build the smallest script that does or proves the job, per [Laziness Protocol](../principle-laziness-protocol/SKILL.md), and never a framework.

## Fan-out

- If the tool can process every unit in one pass, run it yourself instead of fanning out subagents to hand-apply it.
- When you do fan out, put the recipe, the verification contract, and the do-not-touch fences in one skill that every subagent reads.
- Keep that skill outside the subagents' write scope so they cannot edit the contract.

## Check that you applied it

If you cite this principle and the diff has no codemod, script, generator, or delegate skill, you did not apply it.

[Encode Lessons in Structure](../principle-encode-lessons-in-structure/SKILL.md) turns a repeated instruction into a guardrail. [Prove It Works](../principle-prove-it-works/SKILL.md) covers scripting the verification.
