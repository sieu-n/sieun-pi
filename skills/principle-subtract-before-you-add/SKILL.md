---
name: principle-subtract-before-you-add
description: "Apply when sequencing an addition, refactor, or rewrite. Remove dead code, redundant validators, and stub references first, then build on the smaller base."
disable-model-invocation: true
---

# Subtract before you add

When you change a system, delete first and build second. Each time, leave the design smaller or more capable than you found it, with the same or fewer entry points.

- Do the removals before the new construction.
- Cut the work down to the minimum before you spend effort on its quality.
- Design for the usage you have observed, and skip speculative edge cases.
- Add no validator, parser, or guard that the spec does not demand.
- Leave out features the spec does not ask for, because persistence, retry-on-startup, and schema migration each bring guards for their inputs.
- Remove redundant instructions and oversized templates from prompts.
- Delete a reference that has no new content instead of leaving a stub.
