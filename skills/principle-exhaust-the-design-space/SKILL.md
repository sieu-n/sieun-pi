---
name: principle-exhaust-the-design-space
description: "Apply when facing a novel UI interaction or architectural decision with no precedent in the codebase. Build 2 or 3 structurally different prototypes and compare them side by side before committing to one."
disable-model-invocation: true
---

# Exhaust the design space

When the right answer is not obvious, build 2 or 3 competing prototypes or sketches. Compare them side by side, then commit to one.

Each candidate must take a different shape. Two variants of one shape count as one candidate.

For UI variants, put them behind one switcher as `../poteto-mode/playbooks/prototype.md` describes.

Apply this rule in these cases:

- The UI interaction has no prior art in the codebase.
- An architectural choice has more than one viable approach.
- The user experience depends on how the design feels, so logic alone cannot pick the winner.

Skip it in these cases:

- The work follows a pattern the codebase already uses.
- A bug fix or refactor has a clear target state.
- The constraints leave only one viable approach.
