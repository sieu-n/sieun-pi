---
name: spec-report
description: The one report format for plans, status, and "what did you build" answers. Use whenever the user asks for a plan, a spec, a status, next steps, "what is the state", "explain how it works", or right after an implementation lands. Plain words, sections that name their contents, and diagrams for every flow, screen, data model, and state.
---

# Spec report

## When to use

Write the reply in this format when any of these happen:

- The user asks for a plan, a spec, a design, or "how should this work".
- The user asks for status, "where are we", "is it done", or "what is left".
- An implementation finishes and you report it. Any implementation, a two-file script included.
- The user asks how a feature, flow, or data model works.

Do not use it for one-line answers, a single fact, or a single command.

## Substantive plans and specs

Use this shape instead of the report headings below:

1. `## 1 · Principles`
2. `## 2 · Today`
3. `## 3 · Changes`
4. `## 4 · Goals and status`
5. `## 5 · Done when`
6. `## 6 · Open questions`

Open with the user’s job, scope, and proposal or implementation status. Number the main statements continuously across sections. Each numbered item is one short sentence, under 22 words. Put detail in concrete tables, wireframes and relevant diagrams. Keep the chat summary short and link the full artifact.

The headings alone are not the standard. Read [the evidence-driven review method](references/evidence-driven-review.md).

Before recommending changes:

- Reconstruct relevant decisions and separate direct owner requests, attributed summaries, and your proposals.
- Inspect the real workflow and relevant source, data and lifecycle through their native interfaces. Web work uses Aside.
- Separate observed behavior, source risks, proposals, and verified implementation. State unavailable evidence.
- Explain why the workflow fails and which evidence changed your recommendation. Follow evidence beyond the reported symptom when needed.
- Preserve accepted intent and useful capabilities. Consider moving or removing controls before adding features. Explain why concrete alternatives lose.
- Prioritize correctness and trust before cosmetic work when the evidence supports that order. Do not invent a backend problem in every UI task.

Make the proposal operational:

- Use Today/After tables for controls. Wireframes use real copy and show relevant defaults, loading, empty, error, retry, keyboard and narrow-screen states.
- Define relevant promises about persistence, identity, draft versus live content, previews, stale results, concurrent edits and recovery. Explain what the user can trust.
- Verify existing field names. Label proposed fields or semantics. Put low-level source pointers in collapsed Agent notes.
- Order work by dependency and risk. Each scoped work unit ends with an observable check. Distinguish work already in flight.
- Show concrete alternatives and a recommended default for genuine product choices. Investigate observable facts instead of asking the owner to choose them.
- Challenge source claims and contract consistency before calling the plan ready. Check citations and rendering. A rendered spec or mock does not prove implementation.

Scale depth to the problem. Do not copy the example’s artifact count, quote count, length, screen count or worker count. A small plan does not need irrelevant backend sections. A read-only plan does not require application code or a runnable mock.

A reader must be able to explain the user problem, why today fails, what evidence changed the recommendation, what is kept or changed, why alternatives lose, and how each step will be proven.

## Minimum shape for a small status or implementation report

A small task (one script, one fix) keeps four sections and drops the rest:

1. `## 1. What it does` with a topology or file diagram.
2. `## 2. How it works` with a mermaid sequenceDiagram or flowchart, and the outcome table.
3. `## 3. Current state against the final state` with a Today column you checked (tests run, output seen).
4. `## 4. Next steps, in order`, numbered, each ending in a check. "None" is a valid answer with one line saying why.

## Rules

- Plain words. Read every sentence once at speech pace. If a coworker would not say it out
  loud, rewrite it. The `unslop` skill applies to every word.
- No em dashes. Headers in sentence case. A header names its contents, never how to feel.
- Diagrams are mandatory, not decoration. Every flow gets a sequence or flow diagram. Every
  screen gets an ASCII mockup. Every data model gets an ER diagram. Every lifecycle gets a state
  diagram. Use mermaid fenced blocks for flows, sequences, ER, and state. Use ASCII boxes for
  screens and topology.
- Facts over intent. "Today" columns state what exists in the tree or in production, checked, not
  what a worker said.
- Name real things. File paths, commit shas, table names, endpoint paths, error strings, numbers.
- Customer first. The customer workflow comes before any internal mechanism.

## Detailed status and implementation reports

Use these sections when they explain the result. Plans and specs use the six-section shape above. Omit empty sections and keep routine progress updates brief.

1. `# <Feature>: spec, current state, next steps` (or `: plan` / `: what landed`)
   One line under it: the date and "Plain words."
2. `## 1. What it does`
   One paragraph and one topology diagram (ASCII boxes) of the parts that talk to each other.
3. `## 2. Customer workflow`
   A mermaid `flowchart LR` from first touch to the outcome. Then the rules the customer must
   know, as a short list, and nothing else.
4. `## 3. Screens`
   One ASCII mockup per screen that changes. Real copy in the mockup. Menus and states listed
   under each.
5. `## 4. How <main flow> works`
   A mermaid `sequenceDiagram` across the real actors (app, backend, worker, third party).
   Then an outcome table: what the third party said, the stored status, what the customer sees.
6. `## 5. How <second flow> works` (replies, sync, retries, whatever the second flow is)
   Same shape as section 4.
7. `## 6. Data model`
   A mermaid `erDiagram` with the real table names and the fields that matter, with a short
   note per field where the meaning is not obvious.
8. `## 7. State`
   A mermaid `stateDiagram-v2` for the main lifecycle and one line on precedence.
9. `## 8. Rules and limits`
   Pacing, ceilings, timeouts, environments, as a code block or table with numbers.
10. `## 9. Current state against the final state`
    A table: Part | Final state | Today. "Today" is checked, not reported.
11. `## 10. Next steps, in order`
    Numbered. Each step ends in something checkable.

## Review reference

See [the review method](references/evidence-driven-review.md) for evidence-driven judgment and readiness questions. Illustrative examples are not proof of implemented product behavior.

## Self-check before sending

- Count em dashes: 0.
- Every section 4 to 7 has a diagram.
- The "Today" column was checked against the tree, a query, or a screenshot this turn.
- Next steps are numbered and each ends in a check.
