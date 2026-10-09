# Rules for every prime-agent session

## Jobs are subagents, workstreams are threads

A job is a subagent. Start it with `await rlm.spawn(...)`. This holds for one-off tasks, fan-out, audits, long jobs, and "have someone/an agent work on this" requests.

A workstream is a separate top-level thread. A workstream has its own goals and runs over many turns, for example a product area, a migration, or a standing program. Open one with `rlm.create_session(...)` only when the user asks for a new or separate thread, or a top-level session. A VP chat may hold many goals.

A one-off task stays a subagent. If `rlm.spawn` fails (for example at the `RLM_MAX_DEPTH` ceiling), do the work inline or tell the user. Do not fall back to a new thread for one job.

## Fan-out

- One job = one goal. A chat hands each goal, or each step of a goal, to its own job. Never give one job several goals.
- A job splits its work into subagents, one per unit of output: one per article, page, module, or account. For example, the job "do today's SEO iteration" spawns research subagents, then one subagent per article to draft it. One context that writes 10 articles makes each one worse, because quality drops per item when a single context produces many outputs.
- The job plans, coordinates, and checks its subagents' results itself. Each item is made in a fresh context.
- An llm-wiki page is always written by its own subagent, one page per subagent. The writer follows `.agents/skills/apps/llm-wiki/references/writing.md` and makes `node apps/llm-wiki/scripts/prose-lint.mjs <page>` pass. The parent then reads the page against that file before it links the page to anyone. This holds for session pages too, even a one-page report.
- A job with 2 or more independent parts spawns one sub-job per part and coordinates them.
- A job past 150 tool calls or 60 active minutes splits the remaining work into sub-jobs. At the `RLM_MAX_DEPTH` ceiling, it tells its parent that the work needs a split.
- Work of 1 to 3 tool calls stays inline. Do not spawn for it.
- To steer a live job, send it a follow-up with `agent_message.send(..., receiver_role="child", receiver_name=...)`. Do not spawn a "-2" copy of it.

## Subagent models (rlm children)

The model policy lives in one place: the `policy` block and `roles` of `~/.prime/agent/pstack-models.json`. Read it before you set `model=` on a spawn. Change it with the `setup-pstack` skill, not here.

## Rich replies in the browser chat

The browser chat renders markdown tables, ```` ```mermaid ```` blocks as diagrams, and `![alt](path)` images. An image path can be an absolute path, `~/...`, a path relative to the session folder, or an `https` URL. Use a diagram for a flow or a structure. Link a screenshot or chart file instead of describing it. The terminal shows the same text as plain markdown, so keep the text around each diagram or image readable on its own.
