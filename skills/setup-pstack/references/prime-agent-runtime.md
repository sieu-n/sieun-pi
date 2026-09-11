# pstack on Prime Agent: the runtime contract

Every pstack skill that fans out subagents assumes a Cursor `Task` tool. Prime
Agent has no `Task` tool. This file is the single description of what replaced
it, so each skill can stay short.

## Spawning

```python
handle = await rlm(brief, model="anthropic/claude-opus-5", thinking="xhigh", name="critic-1")
# handle.rlm_child_id, handle.name, handle.session_dir, handle.model
```

- `await rlm(...)` returns **as soon as the child is admitted**, not when it
  finishes. It never returns the child's answer.
- There is no `subagent_type`. Every child is a general-purpose Prime Agent, so
  the role lives in the brief. A persona (`comment-sicko`, `poteto-agent`) is a
  skill body you paste into the brief.
- There is no `environment: "cloud" | "local"`, no `run_in_background`, and no
  `cloud_base_branch`. Every child runs locally as its own background process,
  with the same filesystem access as the parent. For a different branch, make a
  git worktree first and name that path in the brief.
- There is no `readonly` / Ask mode. A read-only posture is a sentence in the
  brief: "read and report only; do not edit any file."
- `thinking` is separate from the model and must be one of
  `off, minimal, low, medium, high, xhigh, max`. An invalid level fails the spawn.

Fan out by calling `await rlm(...)` once per worker in a single IPython cell.
Each call returns immediately, so all workers are running before any finishes.

## Draining results

A child's brief **must** end with an explicit instruction to report:

```
When you are done, send your report with
await agent_message.send(<report>, receiver_role="parent").
```

Without that line the parent gets nothing. Messages arrive in the parent session
as they land. End the turn after fan-out rather than polling with `sleep`, and
read the reports on a later turn.

Inspect a worker that goes quiet:

```python
await agent_observe.list_agents()
await agent_observe.recent_messages("<child-name>", limit=8)
await rlm.list_subagents()
```

Follow up with a finished child (its context is still alive):

```python
await agent_message.send("one more thing", receiver_role="child", receiver_name="<child-name>")
```

## Depth limit

Children can only be spawned when `RLM_MAX_DEPTH` allows it. Check first:

```python
import os; print(os.environ.get("RLM_DEPTH"), os.environ.get("RLM_MAX_DEPTH"))
```

`await rlm(...)` raises `RuntimeError: RLM recursion depth limit reached` at the
ceiling. A session at the ceiling cannot fan out at all: run the workflow inline,
or ask the parent session to do the fan-out.

## Models

Role models come from `~/.prime/agent/pstack-models.json`; see the
`setup-pstack` skill. Nothing loads that file automatically, so read it:

```python
import json, pathlib
CFG = pathlib.Path.home() / ".prime/agent/pstack-models.json"
roles = json.loads(CFG.read_text())["roles"] if CFG.exists() else {}
```

## Invocation

Cursor slash commands (`/swarm`) are skill names here. Prime Agent loads a skill
when the task matches its description, and `/skill:<name>` forces it.

## Things with no Prime Agent equivalent

| Cursor | Status here |
|---|---|
| `/loop` | replaced by the bundled `rlm-heartbeat` skill (recurring self-prompt) |
| todo tool | no tool; keep a written checklist in the reply or a `/tmp/` file |
| `AskQuestion` | no tool; ask in chat with a short numbered list |
| Cursor cloud agents | none; all children are local |
| `cursor-team-kit` (`deslop`, `control-ui`, `control-cli`) | not installed; use `unslop`, the `aside-browser` skill (the only browser tool), and `%%bash` |
| Bugbot | not available; use whatever review bot the repo has |
| Graphite `gt` | CLI not installed on this machine |
| MCP servers | supported by Prime Agent, but none configured here |
