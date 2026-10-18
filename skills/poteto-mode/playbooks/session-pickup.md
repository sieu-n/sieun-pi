### Session pickup

For "take over this", "resume this conversation", "continue from <transcript path>", or a pushed branch you are meant to continue. Read the prior trail and trust it. Do not redo work it already did.

1. Find the trail. It is the `Conversation log:` path in your system prompt, a root session at `~/.prime/agent/sessions/<session-id>.jsonl` the user names, or a pushed branch. Do not browse `~/.prime/agent/sessions/` for other logs. Read the last messages first, then scan back for decisions. Parse a long transcript in a subagent.
2. Rebuild the state, which covers the branch and worktree, what landed (`git log`, `git diff` against the base), open checklist items, and decisions made.
3. Compare what shipped with what was planned, and name the resume point. Do not re-run the prior repro.
4. Route the remaining work to its playbook. Decide whether to continue, ship a finished recommendation, confirm or override a prior conclusion, or write a postmortem.
5. Verify the inherited claims against the goal on the real artifact. The prior agent's report is not proof.

Reply with where the prior agent stopped, what you inherited, what you redid, the resume point, and the outcome.
