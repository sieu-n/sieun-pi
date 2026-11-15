---
name: why
description: "Use for how X works or why X works this way, code walkthroughs, where-should-this-live questions, design reasons, regressions, and postmortems. Traces the code and searches git, tickets, docs, and chat, and returns a cited answer."
---

# Why and how

Answer a question about code that already exists.
A how question asks what the code does, and How mode answers it with a working mental model that a senior engineer needs to start work in a subsystem.
A why question asks why the code has its shape, meaning the intent, the edge cases, the outside constraints, and the rejected alternatives, and Why mode answers it from the record.
When a question needs both, run How first and use its file paths and symbols as the code anchor for Why.

## Spawning the roles

Read `~/.prime/agent/skills/setup-pstack/references/prime-agent-runtime.md` before the first spawn, for how to spawn children, collect their reports, and handle the depth limit.

- Take each role's model from its entry in `~/.prime/agent/pstack-models.json`, and omit `model=` and `thinking=` for an `inherit-parent` entry.
- Put "read and report only; do not edit any file" in every brief, because Prime Agent has no read-only child mode.
- End every brief with `await agent_message.send(<report>, receiver_role="parent")`.
- At the `RLM_MAX_DEPTH` ceiling, play each role inline from the same template.

## How mode

Aim for a working mental model, not annotated source.
Explain is the default.
Critique runs Explain first and then sends the result to independent critics, so use it when the user asks for problems, issues, or improvements, or asks "are we sure?".
The roles are `how explorer`, `how explainer`, and `how critics` in `pstack-models.json`.

### Explain

1. Restate the question and its scope. If it is ambiguous, state your best-guess reading and go on without asking.
2. Size it. One module, a small utility, or one function is simple. A subsystem across files or services, a cross-cutting feature, or a full architectural overview is complex. When unsure, treat it as simple and add explorers later if the explainer gets stuck.
3. For a simple question, spawn one explainer from `references/explainer-prompt.md` with no explorer findings, then go to step 6.
4. For a complex question, split it into 2 to 4 angles that do not overlap, and spawn one explorer per angle from `references/explorer-prompt.md`. For "how does the rate limiter work?", the angles might be the data model and state, the request path and enforcement, and the configuration and metrics.
5. When every explorer has reported, spawn one explainer from `references/explainer-prompt.md` with all their findings.
6. Present the explainer's output. Edit it lightly for clarity or to add context from the conversation, but do not rewrite it.

### Critique

1. Run Explain in full first.
2. Spawn one critic per entry in `how critics` from `references/critic-prompt.md`. Fill in the explanation, the file paths it cites, and the full text of `references/critique-rubric.md`.
3. Judge the findings as the lead instead of merging them. Sort each one into act on, consider, noted, or dismissed.
   - Act on means an architectural problem worth fixing now.
   - Consider means a real concern whose cost and benefit are unclear.
   - Noted means a valid, low-priority observation.
   - Dismissed means the finding is wrong, misses context, or is a style preference.
4. Present the explanation first and the verdict below it, so a reader who only wants to understand the system can stop after the explanation.

## Why mode

Code rarely states its own motivation.
The answer lives in commits, PRs, tickets, docs, chat, and incident records, and you cannot tell in advance which one holds it.
So search every reachable source, cite every claim, and report empty searches as findings.
`references/epistemics.md` holds the confidence tiers and phrasing rules. Every investigator and the synthesizer follows it.

### 1. Pin down the target and the question

The target is a piece of code, a pattern, a feature, or a named decision.
The question is usually one of these kinds: design rationale, a tradeoff against an alternative, the edge case behind defensive code, an outside product or business constraint, why dead-looking code still exists, or the full history of X.

If the target is vague, pick the most likely referent from the conversation (open files, recent edits, what was just discussed).
State your reading in one line so the user can redirect, then go on.

### 2. Build the code anchor

Do this inline before you spawn anyone, and pass the result to every child.

```bash
git blame -L <start>,<end> <file>          # last-touch commits for the target lines
git log --oneline -20 -- <file>            # recent commits; PR numbers show as (#1234)
git log --follow -p -- <file>              # full history through renames
git log -1 --format=%B <commit>            # PR numbers and ticket IDs in the message
gh pr view <number> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews
```

The anchor lists file paths with line ranges, key symbols, the commits that touched the target, PR numbers, and ticket IDs.

### 3. Map the reachable sources

| Category | What only it tends to show | How to reach it |
|---|---|---|
| Source control | Rationale written during review: PR bodies, review debates, inline comments, test names | `git` and `gh`, always |
| Issue tracker | The product or customer reason, deadlines, parent initiatives | An MCP, or the owner's browser tab |
| Long-form docs | Specs, design docs, ADRs, "alternatives considered", postmortem action items | An MCP, or the owner's browser tab |
| Team chat | Decisions made in threads or incidents that never reached a doc | An MCP, or the owner's browser tab |
| Infrastructure observability | Monitors, metric spikes, and incidents that match a constant or a ship date | An MCP |
| Error tracking | Stack traces through the target and errors that stop at a release | An MCP |
| Product analytics warehouse | Usage ramps, experiment or flag exposure, distributions behind a threshold | An MCP |

List MCP connections with `await mcp.list_connections()` and inspect one with `await mcp.list_tools("<id>")`.
Map each connection to the one category its main evidence fits.
A service with no MCP that the owner uses in the browser can be read through the `aside-browser` skill.
A category you cannot reach is a gap, and it goes in "Sources consulted" as one.

Search every reachable category, because an empty result there is evidence too (for example, that the decision was never ticketed).
Skip a reachable category only when it is provably irrelevant, such as error tracking for a build-time script, and write the reason in "Sources consulted".
A guess that the source "probably has nothing" is not a reason.
Answer inline only when the target is a single commit whose PR body already answers the question, and say so.

### 4. Spawn one investigator per category

Read the "why investigators" and "why synthesizer" roles in `~/.prime/agent/pstack-models.json` before you set `model=`.
Spawn all investigators from one REPL cell so they run at the same time.
Give each investigator one category, and never pool sources in one child.
At the depth ceiling, run the same investigations inline, one category at a time.

Each investigator brief holds:

1. The template in `references/investigator-prompt.md`, filled in.
2. The code anchor from step 2 and the user's question.
3. `references/sources/code-archaeology.md` for the source control investigator.
4. The line "read and report only; do not edit any file."

For other categories, the investigator learns the query vocabulary from the MCP's own tool list.
If the target looks defensive (null checks, retries, timeouts, rate limits, feature flags, OOM handlers), tell every investigator to look for incident history in its source.

### 5. Synthesize and present

Spawn one synthesizer with `references/synthesizer-prompt.md`, filled in with all investigator reports, the skipped categories and their reasons, the code anchor, and the question.
The synthesizer may read code and call MCP tools to spot-check citations.

Present its answer to the user.
You may edit for clarity, but keep its confidence wording.
If the user wants to change the code next, end with a Preserve / Change / Avoid / Risk list built from the findings.
