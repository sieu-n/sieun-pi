---
name: architect
description: "Sketch types, signatures, and module structure before code, then stay in the loop while implementation fills in. Use for `architect`, 'architect this', 'design this', or non-trivial work where jumping to code would lock in the wrong shape."
disable-model-invocation: true
---

# Architect

Sketch types, function signatures, class shapes, and module boundaries with `not implemented` bodies and pseudocode. Pick a sketch from several candidates, then write code against it. If the code proves the sketch wrong, throw it out and redesign.

## Start

Write this phase checklist in your reply before you start.

1. Ground
2. Sketch
3. Agree
4. Implement
5. Scrap

## Phase A: Ground the problem

Run the `how` skill over every subsystem the new code touches. Use its critique mode when the existing structure is the constraint or the design must push back on it. Naming a file is not grounding; produce the traced model that `how` asks for.

If the design changes ownership or layering, also run the `why` skill on the existing shape and treat its answer as a constraint.

Skip Phase A only for greenfield work with no surrounding system.

## Phase B: Sketch

Run the `arena` skill with the design-sketch task and the Phase A artifacts. Give each runner [`references/runner-prompt.md`](references/runner-prompt.md) as its prompt. Each candidate writes a design package shaped per [`references/rationale-template.md`](references/rationale-template.md).

Take the runner list from the `architect runners` role in `~/.prime/agent/pstack-models.json` (repo default `config/pstack-models.json`). At the `RLM_MAX_DEPTH` ceiling, write the candidates yourself.

Require at least two structurally different candidates, even when the first looks good enough. Two variants of one shape count as one candidate.

Screen every candidate against [`references/design-red-flags.md`](references/design-red-flags.md) before synthesis, and revise or reject the ones that fail. Among the rest, prefer the one that hides the most complexity behind the smallest public interface.

Arena returns one synthesized design package. Its pick fills the rationale's "Synthesis decision" section.

## Phase C: Agree (opt-in)

Go straight to Phase D with the synthesized design by default.

Stop for sign-off only when the invoker asks for it, for example "`architect` with checkpoint" or "show me before implementing". Then show the synthesized design and wait.

You may commit the sketch on its own. Later commits then fill in bodies against a stable contract, and planned breakage during fill-in is fine.

If the human pushes back on the shape, at a checkpoint or later, treat it as Phase A evidence. Re-ground and re-run Phase B before you write more code.

## Phase D: Implement against the sketch

Replace `not implemented` bodies with code and pseudocode with logic. The synthesized sketch is the contract.

Surface every deviation from the sketch. If a function needs a parameter the sketch did not plan for, decide whether the sketch was wrong, a requirement was missed, or the code is overreaching. Do not bolt it on.

## Phase E: Scrap when the architecture is wrong

If the code keeps producing friction the sketch cannot absorb, throw the sketch out, per `principle-redesign-from-first-principles` and `principle-fix-root-causes`.

The trigger is repeated friction of the same shape. These are the tells:

- The same workaround appears in unrelated code.
- Several unrelated edge cases each need a special-case branch.
- The types need escape hatches such as `any`, casts, or optional fields that are always set.
- You want a lock where the sketch said the state was not shared.
- Callers must know the abstraction's internal rules to use it.
- Two or more Phase D deviations have the same shape.

A few hard edge cases do not condemn a design. Complex data does not mean the design is complex.

When you scrap:

1. Re-run the `how` skill over what you built, so the lessons enter the new design as inputs.
2. Redesign as if the new constraints had been there from day one.
3. Make the new sketch smaller than the old one before it grows.
4. Return to Phase B and re-run arena.

## Outputs

A small change gets one file of new types and signatures. Larger work gets a module map plus type definitions. Write the caller's usage first and derive the types from it. The rationale ships alongside, shaped per [`references/rationale-template.md`](references/rationale-template.md).
