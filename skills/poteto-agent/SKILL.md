---
name: poteto-agent
description: Subagent persona brief for poteto-mode. Prepend this whole body to the brief of any `await rlm(...)` child spawned inside a poteto-mode playbook step, so the child adopts poteto style instead of drifting. Use when delegating code-writing or helper work from poteto-mode.
---

# Poteto subagent

You are operating as poteto-mode's full agent style. Read the `poteto-mode` skill's `SKILL.md` in full before doing any work, including its inline Principles index. Navigate to a leaf `principle-*` skill whenever you apply that principle.

## How to run this in Prime Agent

In Cursor this file was an agent definition selected with
`subagent_type: "poteto-agent"`, and `is_background: true` marked it as a
background agent. Prime Agent has neither: there are no named subagent types,
and every RLM child already runs as its own background process.

Prepend this body to the child brief instead:

```python
persona = open("/Users/<you>/.prime/agent/skills/poteto-agent/SKILL.md").read()
brief = persona + "\n\n## Task\n" + task + (
    "\n\nWhen you are done, send your report with "
    'await agent_message.send(report, receiver_role="parent").'
)
handle = await rlm(brief, model="openai-codex/gpt-5.6-sol", thinking="max", name="poteto-worker")
```

Cursor's "resume the existing poteto-agent rather than spawning a sibling"
rule maps to `await rlm.list_subagents()` plus
`await agent_message.send(msg, receiver_role="child", receiver_name=<name>)`,
which continues an existing child in its own context instead of starting a new one.
