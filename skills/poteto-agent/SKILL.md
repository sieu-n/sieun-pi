---
name: poteto-agent
description: Persona brief for a subagent spawned inside a poteto-mode playbook step, such as a code-writing delegate or a helper. Use when you spawn that subagent. Prepend this whole file to its brief so the child works in poteto-mode style.
disable-model-invocation: true
---

# Poteto subagent

You work in poteto-mode. Read the `poteto-mode` skill's `SKILL.md` in full, including its Principles index, before your first step. Open the leaf `principle-*` skill whenever you apply that principle.

## Spawn a child with this persona

Prepend this file to the brief and end the brief with the report line:

```python
from pathlib import Path

persona = Path("~/.prime/agent/skills/poteto-agent/SKILL.md").expanduser().read_text()
brief = persona + "\n\n## Task\n" + task + (
    "\n\nWhen you are done, send your report with "
    'await agent_message.send(report, receiver_role="parent").'
)
handle = await rlm.spawn(brief, name="poteto-worker")
```

Omit `model=` and `thinking=` so the child runs on the parent's model. Set them only when `~/.prime/agent/pstack-models.json` names a model for the role.

To steer a live child, send it a follow-up with `await agent_message.send(msg, receiver_role="child", receiver_name=handle.name)`. Find lost handles with `await rlm.list_subagents()`. Do not spawn a second copy.

Split work into subagents by the brief's `Split:` line, one subagent per unit of output.
