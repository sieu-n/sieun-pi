# Review rubric

Apply the lenses that fit the change. Structure and complexity live in the code quality lens.

## Correctness

- Check edge cases: empty input, null, boundary values, off-by-one, type coercion, overflow, and encoding.
- Check that errors are handled or passed up, not swallowed.
- Check that both the happy path and the failure path work.
- Check what happens when the operation runs twice or after a crash halfway, per `principle-make-operations-idempotent`.
- Check whether several actors can write the same file, branch, or data, and whether structure or only convention keeps them apart, per `principle-separate-before-serializing-shared-state`.
- Check state for races, stale closures, and dangling references.

## Root cause or symptom

Read the callers, callees, types, and sibling modules to see which layer owns the problem, per `principle-fix-root-causes`.

- Flag guard clauses that hide a broken invariant.
- Flag retries that hide a broken contract.
- Flag casts that silence a modeling error.
- Flag a fix in module A that belongs in module B's contract.
- Flag a "do not do X" comment or convention that a type, lint, or runtime check could enforce, per `principle-encode-lessons-in-structure`.

## Verification

- Check that tests cover behavior, not implementation details.
- Check that a bug fix has a test for the bug.
- Check that a change to an integration boundary tests the full path.
- Flag checks that read a proxy, such as a file mtime or cached state, instead of the real value, per `principle-prove-it-works`.
- Flag async or delegated work that trusts a self-report instead of the output artifact.

## Security

Flag only issues you can trace through the code to an input.

- Flag user input that reaches SQL, shell, eval, or innerHTML unsanitized.
- Flag auth gaps in new endpoints.
- Flag secrets in code, logs, or error messages.
- Flag time-of-check to time-of-use gaps on security paths.
