# Architect runner prompt

The orchestrator passes this file to every candidate runner in Phase B. It adds the task, the Phase A grounding artifacts, the runner's own working directory, and the output path. Each runner gets its own git worktree when one is available, otherwise its own subdirectory of the sketch directory.

You are writing one candidate design. Read the [architect](../SKILL.md) skill in full first. Write a design package with a type sketch, function signatures, a module map, and a rationale shaped per [`rationale-template.md`](rationale-template.md).

The orchestrator compares candidates on these rules:

- Write the README-style usage and two or three real call sites first, then derive the types from them.
- Get the core data structures right first, and trace each main access pattern through them; if a pattern needs a map, index, or cache added later, change the structure now.
- Prefer a small public interface that pulls complexity into the callee, and keep transport or wire types off it, per [`design-red-flags.md`](design-red-flags.md).
- If two actors can write the same state, give each actor its own state and merge at the read boundary, per `principle-separate-before-serializing-shared-state`.
- Use `not implemented` errors for bodies, `// TODO` pseudocode for tricky logic, and doc comments for intent and invariants, so a reader can trace data from input to output through types and signatures alone.
- Encode invariants in types first, runtime checks second, and comments last, per `principle-encode-lessons-in-structure` and `principle-type-system-discipline`.
- Validate at boundaries, trust types inside, and keep business logic in pure functions, per `principle-boundary-discipline`.
- Give each invariant one source of truth and derive the rest.
- Make state transitions safe to run twice or to resume after a crash, per `principle-make-operations-idempotent`.
- Flatten the design when tracing one flow takes more than three files, per `principle-minimize-reader-load`.

Other runners get the same brief. Make the best design you can and commit to it. The orchestrator picks a base from the differences, so a safe middle design wastes your slot.
