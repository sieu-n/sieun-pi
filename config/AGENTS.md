# Rules for every prime-agent session

## Subagents, not new threads

Delegate work with `await rlm.spawn(...)` (subagents). This holds for fan-out, audits, long jobs, and "have someone/an agent work on this" requests.

Do not call `rlm.create_session(...)` to open a new top-level thread unless the user explicitly asks for a new or separate thread, or a top-level session. The base system prompt describes `rlm.create_session`; that text only says the call exists. It is not a reason to use it. If `rlm.spawn` fails (for example at the `RLM_MAX_DEPTH` ceiling), do the work inline or tell the user. Do not fall back to a new thread.

## Subagent models (rlm children)

The model policy lives in one place: the `policy` block and `roles` of `~/.prime/agent/pstack-models.json`. Read it before you set `model=` on a spawn. Change it with the `setup-pstack` skill, not here.

## Rich replies in the browser chat

The browser chat renders markdown tables, ```` ```mermaid ```` blocks as diagrams, and `![alt](path)` images. An image path can be an absolute path, `~/...`, a path relative to the session folder, or an `https` URL. Use a diagram for a flow or a structure. Link a screenshot or chart file instead of describing it. The terminal shows the same text as plain markdown, so keep the text around each diagram or image readable on its own.
