# Lead judgment

Filter, add context, and decide. Do not just merge the lists. Reviewers do not know what was tried and rejected, the constraints outside the code, which code is temporary scaffolding, or what the next PR in the stack does.

## Dismiss these

- If a reviewer's findings are all nits, say that the code is probably fine.
- Dismiss a "what if this is null" finding when the caller cannot pass that value, and trace the call site yourself to confirm it.
- Dismiss a suggested abstraction when the code has no second way it needs to change.
- Dismiss "I would have done it differently" unless the reviewer shows a concrete problem.
- Dismiss findings on code the author did not touch, patterns that match the rest of the codebase, and fixes that break constraints you know about.

## Keep these

- Keep findings that two or more models raised on their own.
- Keep findings that name a concrete execution path.
- Keep findings that show a gap in your own model of the code.
- Check security and correctness findings with extra care, even when one model raised them.

## Calibrate the verdict

The user should be able to fix the Act on list and ship. More than five Act on items means you are not filtering hard enough. Always list the Dismissed findings with reasons, so the user can override you.
