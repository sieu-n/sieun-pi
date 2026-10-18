---
name: principle-model-the-domain
description: "Use when writing stateful logic, or when code branches a lot or repeats a shape assumption across files. Encode the domain in a data structure instead of scattered conditionals."
disable-model-invocation: true
---

# Model the domain

Encode the real domain in a data structure instead of spreading it across conditionals. Pick the structure when you write the code, because a later refactor tends to get deferred.

Reach for the structure that matches the domain:

- Use a state machine instead of scattered booleans, phases, or lifecycle checks.
- Use a typed model instead of loose parameters or repeated shape assumptions.
- Use a map, registry, lookup table, or discriminated union instead of branches spread across files.
- Use a reducer or a command and event model instead of ad hoc state mutations.
- Group a module around one body of domain knowledge, not around steps such as load, validate, transform, and save.
- Use a queue, cache, index, tree, or normalized collection when the data access pattern calls for it.
- If none of these fits, list what the code must never allow and how the data gets read, then pick the structure that encodes that.

Define the core types before the logic that uses them, and trace each access pattern to pick the structure. Build shared scaffold, such as CI, test infrastructure and shared types, before features.

Keep plain code when its shape is already clear, local, and unlikely to grow. Reject an abstraction that adds indirection without removing branches, duplicated rules, invalid states, or lifecycle risk.

You skipped this rule when a new feature adds one more branch to an existing if/else chain, adds a second boolean that must stay in sync with the first, or repeats the same domain rule in several phase-named modules.
