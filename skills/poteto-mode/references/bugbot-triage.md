# Review-bot triage

Use this rubric when `../playbooks/babysit.md` handles comments from a review bot or an automated security review. Check each claim against the code before you act, and put each thread in one class.

- `fix` covers a plausible bug in correctness, security, privacy, data loss, auth, billing, migrations, idempotency, races, or shipped behavior. Fix it in the lowest PR that owns the code, reply with the commit SHA, and resolve the thread.
- `dismiss` covers a claim the current code disproves. Reply with the disproof and resolve the thread.
- `ask` covers a novel, high-severity, or ambiguous claim. Ask the user.

Never dismiss these on your own, even if a past PR dismissed something like them.

- Security, privacy, auth, billing, data retention, and permission findings.
- High-severity findings.
- Migration, schema, idempotency, concurrency, and cross-system findings.
- Small suggested fixes that lower risk without changing product intent.

These patterns are often safe to dismiss after you check them.

- The PR changes a visual default on purpose, and the comment restates the change. Do not dismiss accessibility, focus, or contrast findings this way.
- A symbol flagged as unused is used by a later PR in the same stack, and you confirmed it.
- A shared component, type invariant, or framework contract in the diff already enforces the concern.
- A security finding names a missing check that a later commit on the PR tip already adds before the side effect.

These patterns are usually real, so default to fixing them.

- Findings against code that reimplements native browser behavior, such as JS sticky positioning, forwarded wheel or touch events, or masks used for occlusion.
- A claim that a test no longer matches the doc it pins. Run the test on the PR tip first; a red run confirms it and a green run is your disproof.

Do not widen a deliberately narrow error condition, such as a fallback gated on `ENOENT`, into a catch-all. That would hide the real error. Do widen it for another error of the same kind, such as `EACCES`.
