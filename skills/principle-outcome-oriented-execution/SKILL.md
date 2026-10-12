---
name: principle-outcome-oriented-execution
description: "Use during a planned rewrite or migration that has explicit phases. Go straight to the target architecture, accept planned breakage between phases, and do not write throwaway compatibility code to keep each intermediate step working."
disable-model-invocation: true
---

# Outcome-oriented execution

Aim for the verified end state. Do not spend work keeping every intermediate step stable.

1. Use this rule only for a planned rewrite or migration with explicit phase boundaries.
2. Before you start, state which areas may break between phases.
3. Keep breakage scoped and reversible.
4. Do not write compatibility code whose only job is to keep an intermediate step working.
5. While you migrate, keep running the fast checks for the areas you touch.
6. Run the full static and runtime checks before you call the plan done.
