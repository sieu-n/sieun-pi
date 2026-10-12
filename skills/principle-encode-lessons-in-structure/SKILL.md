---
name: principle-encode-lessons-in-structure
description: "Apply when you catch yourself writing the same instruction a second time, or notice a recurring correction. Encode the rule as a lint, metadata flag, runtime check, or script instead of more text."
disable-model-invocation: true
---

# Encode lessons in structure

Turn a recurring fix into a mechanism that enforces it, and delete the instruction it replaces. A reader can miss a written rule. A check runs whether or not anyone reads it.

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
