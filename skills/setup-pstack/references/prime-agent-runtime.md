# pstack on Prime Agent: the runtime contract

pstack skills that fan out subagents follow this file.

## Spawning

```python
handle = await rlm.spawn(brief, name="critic-1")
# handle.rlm_child_id, handle.name, handle.session_dir, handle.model
```

- `rlm.spawn` returns when the child is admitted. It never returns the child's answer.
- Take `model=` and `thinking=` from the role in `~/.prime/agent/pstack-models.json` (see `../SKILL.md`), and omit both for `inherit-parent`.
- `thinking` must be one of `off, minimal, low, medium, high, xhigh, max`, or the spawn fails.
- Every child is a general-purpose Prime Agent, so the brief carries the role. A persona such as `poteto-agent` is a skill body you paste into the brief.
- Every child runs locally in the background with the parent's filesystem. For another branch, make a git worktree first and name its path in the brief.
- For a read-only child, write "read and report only; do not edit any file." in the brief.

To fan out, call `rlm.spawn` once per worker in one IPython cell. All workers start before any finishes.

## Draining results

End every brief with this line, or the parent gets nothing:

```
When you are done, send your report with
await agent_message.send(<report>, receiver_role="parent").
```

Reports arrive in the parent session as they land.
After fan-out, end the turn and read the reports on a later turn. Do not poll with `sleep`.

Inspect a worker that goes quiet:

```python
await agent_observe.list_agents()
await agent_observe.recent_messages("<child-name>", limit=8)
await rlm.list_subagents()
```

Send a follow-up to a finished child, whose context is still alive:

```python
await agent_message.send("one more thing", receiver_role="child", receiver_name="<child-name>")
```

## Depth limit

Check the depth before you spawn:

```python
import os; print(os.environ.get("RLM_DEPTH"), os.environ.get("RLM_MAX_DEPTH"))
```

At the ceiling, `rlm.spawn` raises `RuntimeError: RLM recursion depth limit reached`.
Run the workflow inline, or ask the parent session to fan out.

## Invocation

A skill loads when the task matches its description. `/skill:<name>` forces it, so `/swarm` becomes `/skill:swarm`.

## Tools that do not exist here

Some playbooks name tools that Prime Agent does not have. Use these instead:

| Named in a playbook | Use |
|---|---|
| `/loop` | the bundled `rlm-heartbeat` skill |
| todo tool | a written checklist in the reply or in your session scratch folder |
| `AskQuestion` | a short numbered list in chat |
| `control-ui`, `control-cli` | the `aside-browser` skill for the browser, and `bash()` for the shell |
| Bugbot | the review bot the repo has, if any |
| Graphite `gt` | check `which gt` first; it may not be installed |
