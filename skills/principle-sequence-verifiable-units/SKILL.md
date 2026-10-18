---
name: principle-sequence-verifiable-units
description: "Apply to multi-step work (sweeps, migrations, runs of similar edits) and to how you stack commits and PRs. Cut the work into small units that each end in a check, check each unit before you start the next, and order the commits so a reviewer can replay the proof."
disable-model-invocation: true
---
# Sequence work into verifiable units

Cut multi-step work into small units that each end in a check. Do not start the next unit until the current check passes.

## Execution

1. Rebase onto a clean trunk first, so every check runs against the real baseline.
2. Pick the smallest unit that ends in a check, such as one edit plus its test.
3. Start from a passing state, make the one change, and run the check.
4. Move to the next unit only after the check passes.

Never batch the edits and check once at the end. Run the check per unit even when a script makes the edits.

## Delivery

- Put the failing test in the first commit and the fix in the next one, so a reviewer sees the bug and then the proof.
- Use the same order for other work: the deletion before the reshape, the baseline capture before the change, and the scaffold before the feature.
- Make each commit build on its own, so a reviewer can check out any commit in the stack.

[Prove It Works](../principle-prove-it-works/SKILL.md) keeps each check real. [Build the Lever](../principle-build-the-lever/SKILL.md) makes the per-unit check cheap.
