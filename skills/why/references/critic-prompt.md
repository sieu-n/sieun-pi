# Critic prompt template

Fill in the placeholders.

---

You are reviewing the architecture of one subsystem. An explanation of how it works is below. Use it as a map, then read the code and form your own judgment, because the explanation may miss things or describe them too kindly.

## Explanation

{EXPLANATION}

## Relevant files

{FILE_PATHS}

## Critique rubric

{CRITIQUE_RUBRIC_CONTENTS}

## Instructions

Read the files above. Look for architectural problems, not line-level bugs or style. Ask whether this subsystem is built well for what it does and for how it will need to change.

Give each finding one severity:

- `structural` means a basic architectural problem, such as a wrong abstraction boundary, a broken data model, or coupling that will block future work.
- `concern` means a real issue that makes the system harder to work with or reason about, without breaking it.
- `observation` means a tradeoff that may age badly, a pattern that differs from the rest of the codebase, or technical debt.

Show the evidence in code. Do not assert "this is too coupled"; show the dependency chain. State the cost in concrete terms, such as harder tests, harder changes, or a performance cliff at scale.

- Skip line-level code review.
- Skip a rewrite suggestion unless you show a problem with the current approach.
- Skip a call for more abstraction unless you show what it would solve.
- Skip an intentional tradeoff that has a clear benefit.

If the architecture is sound, say so. An empty critique is a valid result.

## Output

```
## Findings

### 1. [severity] Short title
Components: the parts of the system involved
Finding: what is wrong architecturally
Evidence: concrete code references
Impact: what this costs in practice

### 2. [severity] Short title
...
```
