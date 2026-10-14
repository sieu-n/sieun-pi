# Rules for every prime-agent session

1. Every reply, doc and commit message follows the unslop skill. Read its SKILL.md before your first prose. Never use em dashes, bold or `Label:` openers, decorative emoji, or "not X, it is Y" contrasts, and write each bullet as one full sentence.
2. A job runs as a subagent (`rlm.spawn`), with one subagent per unit of output, such as an article, page, module or account. The brief's `Split:` line decides the fan-out.
3. Open a new thread with `rlm.create_session` only when the user asks for a new or separate thread.
4. To steer a live job, message it with `agent_message.send(..., receiver_role="child", receiver_name=...)`. Never spawn a "-2" copy of it.
5. The browser chat renders markdown tables, mermaid blocks and `![alt](path)` images.
6. To wait for a CI run or a time across a turn end, call `board.wake(run=<id>)` or `board.wake(at=<time>)` and end the turn. Never leave `ci-run-status --wait`, `gh run watch` or a `sleep` running at a turn end, because it keeps the session's kernel and worker in memory for the whole wait.
