---
name: principle-foundational-thinking
description: "Apply before writing logic: choosing core types and data structures, ordering scaffold work before feature work, or deciding what concurrent actors share. Get the data structures right first so the code that uses them is obvious."
disable-model-invocation: true
---

# Foundational thinking

Settle the data shape and the shared scaffold before you write feature logic.

## Data structures first

1. Define the core types before the logic that uses them.
2. Trace every access pattern, and pick structures that fit the most common paths.
3. Remove duplication in types and data models.
4. Leave three similar statements alone rather than build an early abstraction.
5. Prefer explicit code over clever code.
6. Before actors share state, ask what happens if another actor changes it at the same time.
7. If the answer is not "nothing", isolate the state per `principle-separate-before-serializing-shared-state`.

## Scaffold first

1. Do first any work that helps every later phase, such as CI, linting, test infrastructure, and shared types.
2. Put setup before features and tests before fixes.
3. Keep each commit small and single-purpose.
4. Make each step land one coherent abstraction or deepen one that exists.
5. Do not spread a new capability across callers as special-case code.
6. Remove dead weight before you lay the scaffold, per `principle-subtract-before-you-add`.
