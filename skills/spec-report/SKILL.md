---
name: spec-report
description: "Use when the user asks for a plan, spec, status, next steps, or what was built. The one report format: plain words, named sections, and diagrams."
---

# Spec report

## When to use

Write the reply in this format when one of these happens:

- The user asks for a plan, a spec, a design, or "how should this work".
- The user asks for status, "where are we", "is it done", or "what is left".
- You report a finished implementation, and a two-file script counts.
- The user asks how a feature, flow, or data model works.

Skip it for a one-line answer, a single fact, or a single command.
A Linear issue, ticket, or board spec uses the `linear-ticket` skill instead.

## Writing rules

- The customer workflow comes before any internal mechanism.
- Name real things: file paths, commit shas, table names, endpoint paths, error strings, and numbers.
- Every "Today" column holds what you checked this turn in the tree, a query, or a screenshot, never what a worker said.
- Every flow gets a mermaid sequence or flow diagram, every lifecycle a state diagram, and every data model an ER diagram.
- Every screen and every topology gets an ASCII box mockup.

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

The six headings filled with generic content do not meet the format.
Before you recommend changes, do the research:

- Separate direct owner requests, summaries attributed to others, and your own proposals.
- Trace the whole task a person does, such as create, edit, preview, publish, and use, past the reported symptom.
- Inspect the real workflow, source, data, and lifecycle through their native interfaces, and drive web pages with the `aside-browser` skill.
- Label each claim as observed behavior, source risk, proposal, or verified implementation, and name the evidence you could not get.
- Keep accepted intent and useful capabilities, and consider moving or removing controls before you add features.
- Put correctness and trust before cosmetic work when the evidence supports that order, and do not invent a backend problem in every UI task.

Then make the proposal operational:

- Use Today and After tables for controls.
- Write wireframes with real copy, and show the default, loading, empty, error, retry, keyboard, and narrow-screen states that apply.
- Where they apply, state what the user can trust about persistence, identity, draft versus live content, previews, stale results, concurrent edits, and recovery.
- Verify existing field names, label proposed fields, and put low-level source pointers in collapsed Agent notes, a `<details><summary>Agent notes, low level</summary>` block as linear-ticket renders it.
- Order work by dependency and risk, end each work unit with an observable check, and mark work already in flight.
- For a real product choice, give concrete alternatives and a recommended default.
- Investigate an observable fact yourself instead of asking the owner.
- Check source claims, contract consistency, citations, and rendering before you call the plan ready.

A rendered spec or mock does not prove an implementation.
Scale depth to the problem.
A small plan skips the backend sections it does not need, and a read-only plan needs no application code or runnable mock.

## Small status or implementation reports

A small task, such as one script or one fix, uses four sections:

1. `## 1. What it does` with a topology or file diagram.
2. `## 2. How it works` with a mermaid sequenceDiagram or flowchart, and the outcome table.
3. `## 3. Current state against the final state` with a checked Today column (tests run, output seen).
4. `## 4. Next steps, in order`, numbered, each ending in a check. "None" is a valid answer with one line saying why.

## Detailed status and implementation reports

Use the sections that explain the result and omit empty ones. Keep routine progress updates brief.

1. `# <Feature>: spec, current state, next steps` (or `: plan` / `: what landed`) has one line under it with the date and "Plain words."
2. `## 1. What it does` has one paragraph and one ASCII topology diagram of the parts that talk to each other.
3. `## 2. Customer workflow` has a mermaid `flowchart LR` from first touch to the outcome, then a short list of the rules the customer must know.
4. `## 3. Screens` has one ASCII mockup with real copy per changed screen, with its menus and states listed under it.
5. `## 4. How <main flow> works` has a mermaid `sequenceDiagram` across the real actors (app, backend, worker, third party), then an outcome table of what the third party said, the stored status, and what the customer sees.
6. `## 5. How <second flow> works` covers replies, sync, retries, or whatever the second flow is, in the same shape as section 4.
7. `## 6. Data model` has a mermaid `erDiagram` with the real table names and the fields that matter, plus a short note on any field whose meaning is not obvious.
8. `## 7. State` has a mermaid `stateDiagram-v2` for the main lifecycle and one line on precedence.
9. `## 8. Rules and limits` gives pacing, ceilings, timeouts, and environments with numbers, as a code block or table.
10. `## 9. Current state against the final state` is a table of Part | Final state | Today, where Today is checked.
11. `## 10. Next steps, in order` is numbered, and each step ends in something checkable.

## Self-check before sending

1. Run the `unslop` self-audit.
2. In a detailed report, sections `## 4` to `## 7` each have a diagram.
3. Next steps are numbered and each ends in a check.

A plan or spec is ready when a reader can answer these:

1. What is the user trying to complete?
2. Why does the current workflow fail?
3. Which observed facts changed the recommendation?
4. What is kept, moved, removed, or added, and why?
5. Why do the concrete alternatives lose?
6. How will each step be proven?
