---
name: principle-encode-lessons-in-structure
description: "Apply to any edit, migration, analysis, or check beyond a few obvious edits, and when you write the same instruction a second time or see a recurring correction. Build the script, codemod, generator, lint, or check that does, proves, or enforces the work, instead of hand work or more text."
disable-model-invocation: true
---

# Encode lessons in structure

Put the work and its lessons into tools and checks instead of hand edits and written rules. A reviewer can rerun a tool, and can check a hand edit only by redoing it. A reader can miss a written rule, and a check runs whether or not anyone reads it.

## Build the lever for the work

When the work is more than a couple of obvious edits you can see at a glance, build the tool that does it or proves it. A one-off task still gets a tool when the tool is what makes the work checkable.

1. Do the first unit by hand to learn the recipe.
2. Build the tool, and make it safe to rerun.
3. Rerun it on the first unit and diff the result against your hand-done version.
4. Commit the tool when the work outlives the session, so the next run reruns it.

Build the smallest script that does or proves the job, per [Laziness Protocol](../principle-laziness-protocol/SKILL.md), and never a framework.

- Use a codemod or script for edits.
- Use a generator for repetitive files.
- Use a query over a SQLite dump for analysis.
- Use a rerunnable check for verification, as [Prove It Works](../principle-prove-it-works/SKILL.md) describes.

## Fan out through one skill

- If the tool can process every unit in one pass, run it yourself instead of fanning out subagents to hand-apply it.
- When you do fan out, put the recipe, the verification contract, and the do-not-touch fences in one skill that every subagent reads.
- Keep that skill outside the subagents' write scope so they cannot edit the contract.

## When you write an instruction a second time

1. Ask whether a type, lint rule, metadata flag, runtime check, or script can enforce it.
2. If one can, build it and delete the instruction.
3. If the rule needs judgment, keep the instruction and add an example of the failure it prevents.

If a structural fix exists, ship only that fix. Do not keep the text beside it.

## Pick the strongest mechanism

Use the strongest one the situation allows, in this order:

1. Make the bad state unrepresentable, so it fails to compile.
2. Add a lint rule or banned API that fails CI.
3. Add a canonical helper that callers use.
4. Add a runtime check.

Agents copy the code around them, so a weak guard becomes the next template.

## Route every correction

1. When a person corrects you or a test fails, decide whether it is a one-off or a pattern.
2. Record a one-off as a memory.
3. Turn a recurring fix into a skill or lint rule, and a systemic issue into a principle.
4. Apply the change now, or write a concrete todo for it.

Saying "I'll keep that in mind" records nothing. A note about a missing lint rule is wasted until someone builds the rule. A fix to one instance leaves the pattern in place.

## Check that you applied it

If you cite this principle and the diff has no codemod, script, generator, check, lint rule, or delegate skill, you did not apply it.
