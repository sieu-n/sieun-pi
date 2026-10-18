### Shipping the change

Run this at the end of every other playbook.

The target repo's own rules come first. If its AGENTS.md names a commit script, a release owner, or bans on branch switches, resets, or pushes, follow those and skip the PR steps below. Open a GitHub PR only in a repo that ships through PRs.

Give each subagent that writes on its own branch its own git worktree. Never reset or stash a shared checkout.

Commit often, then order the work as small commits that each tell one step. Amend when a fix belongs in the commit you just made.

Before you commit, run the unslop skill over the prose in the diff and the no-comments skill over the code.

Write commit titles as Conventional Commits, `type(scope): subject`, with a type from `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf`. Keep the subject short and imperative, with no trailing period. Name a real symbol when one carries the change. A commit body does not repeat its subject.

When you open a PR, write the description with these sections in order, and drop any that are empty.

- `## Why` states the intent and why this approach fits.
- `## Scope` states facts from the diff with real symbols and paths, including both sides of a rename.
- `## Tradeoffs` states the real choices you made.
- `## Blast Radius` states what the change touches and why it is safe or risky.
- `## Verification` states how you ran each check and what it showed.

Attach screenshots or video when they prove a claim. Do not add `## Summary` or `## Test plan` sections.

Prefer five narrow PRs to one large one. Stack follow-ups with Graphite (`gt`) only when the repo uses it. Open every PR as ready, never as a draft. Run `gh pr view <number>` before you report PR status.

Opening a PR does not start a babysit. Post the URL and keep building. Run `playbooks/babysit.md` only when the user asks. A subagent that opens a PR returns the URL to its parent and does not babysit.
