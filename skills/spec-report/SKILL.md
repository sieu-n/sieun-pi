---
name: spec-report
description: "Use when the user asks for a plan, spec, status, next steps, or what was built. The one report format: plain words, named sections, and diagrams."
---

# Spec report

## When to use

Write the reply in this format when any of these happen:

- The user asks for a plan, a spec, a design, or "how should this work".
- The user asks for status, "where are we", "is it done", or "what is left".
- An implementation finishes and you report it, a two-file script included.
- The user asks how a feature, flow, or data model works.

Do not use it for one-line answers, a single fact, or a single command.

## Writing rules

- Write every word to the `unslop` skill.
- Put the customer workflow before any internal mechanism.
- Name real things: file paths, commit shas, table names, endpoint paths, error strings, and numbers.
- Fill every "Today" column from what you checked this turn in the tree, a query, or a screenshot, never from what a worker said.
- Give every flow a sequence or flow diagram, every lifecycle a state diagram, and every data model an ER diagram, all as mermaid fenced blocks.
- Draw every screen and every topology as an ASCII box mockup.

## Plans and specs

Use these six sections:

1. `## 1 · Principles`
2. `## 2 · Today`
3. `## 3 · Changes`
4. `## 4 · Goals and status`
5. `## 5 · Done when`
6. `## 6 · Open questions`

Open with the user's job, the scope, and the proposal or implementation status.
Number the main statements continuously across sections, one sentence each, under 22 words.
Put detail in tables, wireframes, and diagrams.
Keep the chat summary short and link the full artifact.

Matching headings with generic content does not meet the format. Before you recommend changes:

- Separate direct owner requests, summaries attributed to others, and your own proposals.
- Trace the whole task a person does, for example create, edit, preview, publish, and use, and not only the reported symptom.
- Inspect the real workflow, source, data, and lifecycle through their native interfaces, and drive web pages with the `aside-browser` skill.
- Label each claim as observed behavior, source risk, proposal, or verified implementation, and name the evidence you could not get.
- Say which evidence changed your recommendation.
- Keep accepted intent and useful capabilities, and consider moving or removing controls before adding features.
- Put correctness and trust before cosmetic work when the evidence supports that order, and do not invent a backend problem in every UI task.

Make the proposal operational:

- Use Today and After tables for controls.
- Write wireframes with real copy, and show the default, loading, empty, error, retry, keyboard, and narrow-screen states that apply.
- State what the user can trust about persistence, identity, draft versus live content, previews, stale results, concurrent edits, and recovery, where they apply.
- Verify existing field names, label proposed fields, and put low-level source pointers in collapsed Agent notes.
- Order work by dependency and risk, end each work unit with an observable check, and mark work already in flight.
- Give concrete alternatives and a recommended default for real product choices, and investigate observable facts instead of asking the owner.
- Check source claims, contract consistency, citations, and rendering before you call the plan ready.

A rendered spec or mock does not prove an implementation.
Scale depth to the problem. A small plan skips backend sections it does not need. A read-only plan needs no application code or runnable mock.

Before you send, check that a reader can answer these:

1. What is the user trying to complete?
2. Why does the current workflow fail?
3. Which observed facts changed the recommendation?
4. What is kept, moved, removed, or added, and why?
5. Why do the concrete alternatives lose?
6. How will each step be proven?

## Small status or implementation reports

A small task, such as one script or one fix, uses four sections:

1. `## 1. What it does` with a topology or file diagram.
2. `## 2. How it works` with a mermaid sequenceDiagram or flowchart, and the outcome table.
3. `## 3. Current state against the final state` with a checked Today column (tests run, output seen).
4. `## 4. Next steps, in order`, numbered, each ending in a check. "None" is a valid answer with one line saying why.

## Detailed status and implementation reports

Use the sections that explain the result and omit empty ones. Keep routine progress updates brief.

1. `# <Feature>: spec, current state, next steps` (or `: plan` / `: what landed`), with one line under it giving the date and "Plain words."
2. `## 1. What it does` has one paragraph and one ASCII topology diagram of the parts that talk to each other.
3. `## 2. Customer workflow` has a mermaid `flowchart LR` from first touch to the outcome, then a short list of the rules the customer must know.
4. `## 3. Screens` has one ASCII mockup with real copy per changed screen, with its menus and states listed under it.
5. `## 4. How <main flow> works` has a mermaid `sequenceDiagram` across the real actors (app, backend, worker, third party), then an outcome table: what the third party said, the stored status, and what the customer sees.
6. `## 5. How <second flow> works` covers replies, sync, retries, or whatever the second flow is, in the same shape as section 4.
7. `## 6. Data model` has a mermaid `erDiagram` with the real table names and the fields that matter, with a short note on any field whose meaning is not obvious.
8. `## 7. State` has a mermaid `stateDiagram-v2` for the main lifecycle and one line on precedence.
9. `## 8. Rules and limits` gives pacing, ceilings, timeouts, and environments with numbers, as a code block or table.
10. `## 9. Current state against the final state` is a table of Part | Final state | Today, where Today is checked.
11. `## 10. Next steps, in order` is numbered, and each step ends in something checkable.

## Self-check before sending

- Run the `unslop` self-audit.
- Every section from 4 to 7 has a diagram.
- You checked the "Today" column this turn against the tree, a query, or a screenshot.
- Next steps are numbered and each ends in a check.
