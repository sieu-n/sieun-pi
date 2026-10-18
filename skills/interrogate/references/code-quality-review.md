# Code quality lens

Hold the change to a strict bar on structure. Look first for a restructuring that keeps behavior and makes whole branches, helpers, modes, or layers disappear. Pushing for that beats listing local cleanups.

## Checks

- Flag code that could be simpler without losing correctness, per `principle-laziness-protocol`.
- Flag a change that reads as bolted on, where code written with the requirement known from day one would look different, per `principle-redesign-from-first-principles`.
- Flag new ad-hoc conditionals or special cases inside unrelated flows, and push the logic into a helper, state machine, or module.
- Flag a change that pushes a file from under 1,000 lines to over 1,000 without a strong structural reason.
- Flag thin wrappers, pass-through helpers, and abstractions with one call site.
- Flag options and parameters for cases that do not exist yet, and flag dead code, unused imports, and unused parameters.
- Flag a new API that keeps the old one alive with no external consumers, per `principle-migrate-callers-then-delete-legacy-apis`.
- Flag validation scattered through business logic instead of at the boundary, per `principle-boundary-discipline`.
- Flag needless optionality, `unknown`, `any`, casts, or silent fallbacks where a typed model would make the invariant explicit.
- Flag data structures that do not match how the code reads them.
- Flag logic in the wrong layer, and bespoke code that duplicates an existing helper.
- Flag independent work run in sequence, and related updates that can leave state half applied.
- Flag features and controls that add complexity without a user reason to exist.

Do not ask for abstraction in simple code; three duplicated lines beat a premature abstraction.

## Priority

List missed simplifications first, then tangled branching, then type, boundary, and file-size issues, then smaller legibility issues. A few high-conviction findings beat a long list of nits.

## Approval bar

Treat these as blockers unless the author justifies them:

- The change keeps complexity that a restructuring would delete.
- The change pushes a file past 1,000 lines.
- The change tangles an existing flow with ad-hoc branches or scatters feature checks across shared code.
- The change adds a needless abstraction, wrapper, or cast-heavy contract.
- The change duplicates a helper or puts logic outside its clear home.

Say plainly when the change makes the codebase messier. Do not soften a structural problem into a rename suggestion.
