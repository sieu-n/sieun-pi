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
