---
name: how
description: "Use for \"how does X work\" questions, code walkthroughs, and where-should-this-live questions. Use why for history and reasons."
---

# How

Answer "how does X work?" with what a senior engineer needs to start work in a subsystem. Aim for a working mental model, not annotated source.

Explain is the default mode. Critique runs Explain first and then sends the result to independent critics. Use Critique when the user asks for problems, issues, or improvements.

## Spawning the roles

Read `../setup-pstack/references/prime-agent-runtime.md` before the first spawn. For this skill:

- Take each role's model from the `how explorer`, `how explainer`, and `how critics` entries in `~/.prime/agent/pstack-models.json`, and omit `model=` and `thinking=` for an `inherit-parent` entry.
- Put "read and report only; do not edit any file" in every brief, because Prime Agent has no read-only child mode.
- End every brief with `await agent_message.send(<report>, receiver_role="parent")`.
- At the `RLM_MAX_DEPTH` ceiling, play each role inline from the same template.

## Explain

1. Restate the question and its scope. If it is ambiguous, state your best-guess reading and go on without asking.
2. Size it. One module, a small utility, or one function is simple. A subsystem across files or services, a cross-cutting feature, or a full architectural overview is complex. When unsure, treat it as simple and add explorers later if the explainer gets stuck.
3. For a simple question, spawn one explainer from `references/explainer-prompt.md` with no explorer findings, then go to step 6.
4. For a complex question, split it into 2 to 4 angles that do not overlap, and spawn one explorer per angle from `references/explorer-prompt.md`. For "how does the rate limiter work?", the angles might be the data model and state, the request path and enforcement, and the configuration and metrics.
5. When every explorer has reported, spawn one explainer from `references/explainer-prompt.md` with all their findings.
6. Present the explainer's output. Edit it lightly for clarity or to add context from the conversation, but do not rewrite it.

## Critique

1. Run Explain in full first.
2. Spawn one critic per entry in `how critics` from `references/critic-prompt.md`. Fill in the explanation, the file paths it cites, and the full text of `references/critique-rubric.md`.
3. Judge the findings as the lead instead of merging them. Sort each one into act on, consider, noted, or dismissed.
   - Act on means an architectural problem worth fixing now.
   - Consider means a real concern whose cost and benefit are unclear.
   - Noted means a valid, low-priority observation.
   - Dismissed means the finding is wrong, misses context, or is a style preference.
4. Present the explanation first and the verdict below it, so a reader who only wants to understand the system can stop after the explanation.
