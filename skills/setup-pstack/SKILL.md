---
name: setup-pstack
description: "Use when the user asks to set or change which models pstack uses per role. Writes ~/.prime/agent/pstack-models.json."
---

# Setup pstack

Write `~/.prime/agent/pstack-models.json`. Every pstack skill reads its `roles` before it spawns a subagent.
A skill with no entry for its role uses its own default.

The `policy` block in that file is the only model policy.
It holds the default (`inherit-parent`), the allowed models, per-task recommendations such as `frontend`, and the banned models.
Never write a banned model into `roles`, even when `rlm.find_models` lists it.
Write a model outside `allowed` only when the user names it for a role.

Nothing loads the config for a skill. Each skill reads it like this:

```python
import json, pathlib
CFG = pathlib.Path.home() / ".prime/agent/pstack-models.json"
roles = json.loads(CFG.read_text())["roles"] if CFG.exists() else {}
entries = roles.get("swarm workers", [])          # always a list
model = entries[0]["model"]                        # "provider/model" selector
thinking = entries[0].get("thinking")              # off|minimal|low|medium|high|xhigh|max
```

A panel role (`how critics`, `arena runners`, `architect runners`, `arena cross-judge pool`) has one entry per subagent, so the list length sets the fan-out.
For an entry of `{"model": "inherit-parent"}`, omit `model=` in `rlm.spawn(...)`. It still counts toward the fan-out.

## Steps

### 1. Find reachable models

```python
models = await rlm.find_models("claude", limit=20)   # limit must be 1-20
for m in models:
    print(m.selector)
```

`rlm.find_models` returns only models with live credentials in this session.
One call returns at most 20 entries, so run several queries (`""`, `"claude"`, `"gpt"`, `"codex"`, provider names) and take the union.
Never write a selector you have not seen in that output. `inherit-parent` is an alias and is always valid.

A listed model can still fail on the first request because of no balance, an expired key, or a region block.
Test each selector you plan to write with one real call:

```bash
prime-agent -p --no-session --model <selector> --thinking <level> "Reply with exactly: MODEL_OK"
```

`MODEL_OK` means the pair works. An HTTP error or empty output means it does not, so drop that selector.
The thinking level must be one of `off, minimal, low, medium, high, xhigh, max`.

### 2. Load current state

If `~/.prime/agent/pstack-models.json` exists, its values are the current choices.
If it does not, start from `config/pstack-models.json` in the sieun-pi repo.

### 3. Map and confirm

Show every role with its current model. Mark each selector that failed step 1 as needing a choice.
Ask in chat whether to keep the config or change specific roles. Give a short numbered list of the reachable models plus `inherit-parent`, and mark the default.

`swarm workers` is the model for every worker unless a race or comparison sets a model per arm.
Arena picks one entry from `arena cross-judge pool`, from a model family other than the parent's when it can.

### 4. Validate

Write only selectors that `rlm.find_models` listed and that returned `MODEL_OK` in step 1.
An unreachable selector shows up later as a dead subagent, with no config error.

### 5. Write the config

Overwrite the whole file, so a re-run gives the same result.

```json
{
  "version": 1,
  "verified_at": "<ISO date>",
  "roles": {
    "feature, refactoring": [{"model": "inherit-parent"}],
    "how critics": [
      {"model": "inherit-parent"},
      {"model": "<selector from step 1>", "thinking": "<level>"}
    ]
  },
  "policy": {}
}
```

Copy the `policy` block over unchanged unless the user changes the policy. Do not copy it into AGENTS.md or a skill.

Use these role labels exactly:
`feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `judgment and prose`, `hardest tasks`, `how explorer`, `how explainer`, `how critics`, `why investigators`, `why synthesizer`, `arena runners`, `arena cross-judge pool`, `swarm workers`, `architect runners`, `frontend`.

### 6. Confirm

Tell the user the path you wrote. Skills read the file at spawn time, so the change applies on the next spawn with no restart.

## Skill visibility

Most pstack skills ship with `disable-model-invocation: true`.
Prime Agent leaves those skills out of `<available_skills>`, so the model does not pick them on its own.
`/skill:<name>` still loads them, and any skill can read another skill's file by path.

Show or change the flag with:

```bash
python3 ~/.prime/agent/skills/setup-pstack/scripts/toggle-model-invocation.py --show
python3 ~/.prime/agent/skills/setup-pstack/scripts/toggle-model-invocation.py --expose   # make every pstack skill model-invocable
python3 ~/.prime/agent/skills/setup-pstack/scripts/toggle-model-invocation.py --hide     # restore the pstack defaults
```
