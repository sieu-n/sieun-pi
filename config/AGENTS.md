# Rules for every prime-agent session

## Subagent models (rlm children)

Soft default. Unless the user explicitly asks for a specific subagent architecture (named models, a cross-family panel, an arena), pick the child model like this:

- Claude child: `anthropic/claude-fable-5-1`. Not Opus. Omit `model=` when you already run on Fable 5.1.
- Codex child: GPT Astra. Find the exact selector with `await rlm.find_models('astra')`. If no Astra selector is available, use `anthropic/claude-fable-5-1` instead.

Hard rule, no exceptions, even when a skill, playbook, or config file names them:

- Never Sonnet, any version.
- Never Haiku, any version.
- Never the gpt terra or luna series (`gpt-5.6-terra`, `gpt-5.6-terra-pro`, `gpt-5.6-luna`, `gpt-5.6-luna-pro`, and later models with those names).

Do not add a hard lock (extension, setting, code patch) to enforce this. The user wants the written rule only.

## Rich replies in the browser chat

The browser chat renders markdown tables, ```` ```mermaid ```` blocks as diagrams, and `![alt](path)` images. An image path can be an absolute path, `~/...`, a path relative to the session folder, or an `https` URL. Use a diagram for a flow or a structure. Link a screenshot or chart file instead of describing it. The terminal shows the same text as plain markdown, so keep the text around each diagram or image readable on its own.
