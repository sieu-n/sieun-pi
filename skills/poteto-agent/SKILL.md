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

## Fan-out

- One job = one goal. A chat hands each goal, or each step of a goal, to its own job. Never give one job several goals.
- A job splits its work into subagents, one per unit of output: one per article, page, module, or account. For example, the job "do today's SEO iteration" spawns research subagents, then one subagent per article to draft it. One context that writes 10 articles makes each one worse, because quality drops per item when a single context produces many outputs.
- The job plans, coordinates, and checks its subagents' results itself. Each item is made in a fresh context.
- A job with 2 or more independent parts spawns one sub-job per part and coordinates them.
- A job past 150 tool calls or 60 active minutes splits the remaining work into sub-jobs. At the `RLM_MAX_DEPTH` ceiling, it tells its parent that the work needs a split.
- Work of 1 to 3 tool calls stays inline. Do not spawn for it.
- To steer a live job, send it a follow-up with `agent_message.send(..., receiver_role="child", receiver_name=...)`. Do not spawn a "-2" copy of it.
