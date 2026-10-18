---
name: why
description: "Use for why X works this way, design reasons, regressions, and postmortems. Searches git, tickets, docs, and chat, and returns a cited answer."
---

# Why

Answer why code has its shape: the intent, the edge cases, the outside constraints, and the rejected alternatives.
The `how` skill answers what the code does.

Code rarely states its own motivation.
The answer lives in commits, PRs, tickets, docs, chat, and incident records, and you cannot tell in advance which one holds it.
So search every reachable source, cite every claim, and report empty searches as findings.
`references/epistemics.md` holds the confidence tiers and phrasing rules. Every investigator and the synthesizer follows it.

## 1. Pin down the target and the question

The target is a piece of code, a pattern, a feature, or a named decision.
The question is usually one of these kinds: design rationale, a tradeoff against an alternative, the edge case behind defensive code, an outside product or business constraint, why dead-looking code still exists, or the full history of X.

If the target is vague, pick the most likely referent from the conversation (open files, recent edits, what was just discussed).
State your reading in one line so the user can redirect, then go on.

## 2. Build the code anchor

Do this inline before you spawn anyone, and pass the result to every child.

```bash
git blame -L <start>,<end> <file>          # last-touch commits for the target lines
git log --oneline -20 -- <file>            # recent commits; PR numbers show as (#1234)
git log --follow -p -- <file>              # full history through renames
git log -1 --format=%B <commit>            # PR numbers and ticket IDs in the message
gh pr view <number> --json title,body,author,createdAt,mergedAt,labels,closingIssuesReferences,comments,reviews
```

The anchor lists file paths with line ranges, key symbols, the commits that touched the target, PR numbers, and ticket IDs.

## 3. Map the reachable sources

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

## 4. Spawn one investigator per category

Read `~/.prime/agent/skills/setup-pstack/references/prime-agent-runtime.md` for how to spawn children, collect their reports, and handle the depth limit.
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

## 5. Synthesize and present

Spawn one synthesizer with `references/synthesizer-prompt.md`, filled in with all investigator reports, the skipped categories and their reasons, the code anchor, and the question.
The synthesizer may read code and call MCP tools to spot-check citations.

Present its answer to the user.
You may edit for clarity, but keep its confidence wording.
If the user wants to change the code next, end with a Preserve / Change / Avoid / Risk list built from the findings.
