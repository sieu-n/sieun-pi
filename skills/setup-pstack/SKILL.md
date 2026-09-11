---
name: setup-pstack
description: Configure which models pstack uses per role in Prime Agent. Detects the models this session can actually reach with rlm.find_models, then writes ~/.prime/agent/pstack-models.json. Use for "configure pstack models", "setup pstack", or changing pstack's model choices.
---

# Setup pstack

Write `~/.prime/agent/pstack-models.json`, the per-role model config every pstack
skill reads before it spawns a subagent. The skills fall back to their inline
defaults when a role is absent, so this is an override layer, not a requirement.

User rule (2026-09-08, `~/.prime/agent/AGENTS.md`): every role defaults to
`anthropic/claude-fable-5-1`; Codex roles use GPT Astra when a selector is reachable.
Never write Sonnet, Haiku, or gpt terra/luna into this file, whatever
`rlm.find_models` reports. Other models only when the user names them for a role.

Prime Agent has no always-applied rules file, so nothing loads this config for
you. Each skill reads it explicitly:

```python
import json, pathlib
CFG = pathlib.Path.home() / ".prime/agent/pstack-models.json"
roles = json.loads(CFG.read_text())["roles"] if CFG.exists() else {}
entries = roles.get("swarm workers", [])          # always a list
model = entries[0]["model"]                        # "provider/model" selector
thinking = entries[0].get("thinking", "high")      # off|minimal|low|medium|high|xhigh|max
```

A panel role (`how critics`, `arena runners`, `architect runners`,
`interrogate reviewers`, `arena cross-judge pool`) is a list with one entry per
subagent, so the list length sets the fan-out. An entry of
`{"model": "inherit-parent"}` means: omit `model=` in the `await rlm(...)` call
so the child runs on the parent's model. It still counts toward the fan-out.

## Steps

### 1. Detect available models

```python
models = await rlm.find_models("claude", limit=20)   # limit must be 1-20
for m in models:
    print(m.selector)                                 # e.g. anthropic/claude-opus-5
```

`rlm.find_models` is the dependable source: it only returns models backed by
live credentials in this session. Run several queries (`""`, `"claude"`,
`"gpt"`, `"codex"`, provider names) and take the union, because one call returns
at most 20 entries. Never write a selector you have not seen in that output.
`inherit-parent` is always valid because it is an alias, not a slug.

**Presence in `find_models` is not the same as reachability.** A provider can be
listed and still fail on the first request (no balance, expired key, region
block). Confirm each selector you intend to write with one real call:

```bash
prime-agent -p --no-session --model <selector> --thinking <level> "Reply with exactly: MODEL_OK"
```

`MODEL_OK` means the pair works. An HTTP error, or empty output, means it does
not — drop that selector and pick another. Thinking levels are validated at
spawn time and must be one of `off, minimal, low, medium, high, xhigh, max`.

### 2. Load current state

If `~/.prime/agent/pstack-models.json` exists, read it and treat its values as
the current choices. Otherwise start from the shape in step 5.

### 3. Map and confirm

Show every role with its current model, marking any selector that is not in the
detected-and-reachable set as needing a choice. Ask whether to accept as-is or
change specific roles. Prime Agent has no structured-question tool, so ask in
chat with a short numbered list of the detected models plus `inherit-parent`,
and mark the default.

`swarm workers` is the default model for every worker unless a race or
comparison assigns another model per arm. `arena cross-judge pool` is a list
from which Arena picks one entry whose model family differs from the parent's
when possible.

### 4. Validate

Every selector written must be in the detected set **and** have returned
`MODEL_OK` in step 1. A config pointing at a model the user cannot reach breaks
every delegation that reads it, and the failure surfaces as a dead subagent, not
as a config error.

### 5. Write the config

Overwrite the whole file so re-runs stay idempotent.

```json
{
  "version": 1,
  "verified_at": "<ISO date>",
  "roles": {
    "feature, refactoring":  [{"model": "openai-codex/gpt-5.6-sol", "thinking": "max"}],
    "bug-fix":               [{"model": "openai-codex/gpt-5.6-sol", "thinking": "max"}],
    "judgment and prose":    [{"model": "anthropic/claude-opus-5",  "thinking": "xhigh"}],
    "how critics": [
      {"model": "anthropic/claude-opus-5",   "thinking": "xhigh"},
      {"model": "openai-codex/gpt-5.6-sol",  "thinking": "max"}
    ]
  }
}
```

Keep the role labels exactly as poteto-mode and the workflow skills use them:
`feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`,
`judgment and prose`, `hardest tasks`, `how explorer`, `how explainer`,
`how critics`, `why investigators`, `why synthesizer`, `reflect tooling`,
`reflect judgment, divergent, synthesizer`, `arena runners`,
`arena cross-judge pool`, `swarm workers`, `architect runners`,
`interrogate reviewers`.

### 6. Confirm

Tell the user the config was written, name the path, and note that skills read
it at spawn time, so it takes effect on the next delegation with no restart.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a
`verify-*` skill, or an existing harness). If not, offer once: "want a
project-local verification skill, so agents can drive the app the way a user
does and prove changes work? I can generate one with `create-verification-skill`."
On yes, invoke the `create-verification-skill` skill. On no, move on without
pushing.

## Skill visibility

pstack ships 39 of its 46 skills with `disable-model-invocation: true`. Prime
Agent honours that flag exactly as Cursor did: the skill still loads, but it is
left out of the `<available_skills>` block, so the model will not route to it on
its own. It stays reachable with `/skill:<name>`, and any skill can read another
skill's file by path.

Report or change that with:

```bash
python3 ~/.prime/agent/skills/setup-pstack/scripts/toggle-model-invocation.py --show
python3 ~/.prime/agent/skills/setup-pstack/scripts/toggle-model-invocation.py --expose   # model-invocable
python3 ~/.prime/agent/skills/setup-pstack/scripts/toggle-model-invocation.py --hide     # back to pstack defaults
```

## Prime Agent port notes

This skill was a Cursor plugin skill. What changed and why:

| Cursor | Prime Agent | Reason |
|---|---|---|
| `~/.cursor/rules/pstack-models.mdc` with `alwaysApply: true` | `~/.prime/agent/pstack-models.json`, read explicitly by each skill | Prime Agent has no always-applied rules layer |
| model slug carries the reasoning tier (`-max`, `-xhigh`) | `model` selector + separate `thinking` level | `await rlm(prompt, model=..., thinking=...)` takes them apart |
| "slugs you can pass to a `Task` subagent" | `await rlm.find_models(query, limit)` | there is no `Task` tool here |
| Cursor models API/CLI | `prime-agent -p --model <selector>` smoke call | the only way to prove reachability, not just listing |
