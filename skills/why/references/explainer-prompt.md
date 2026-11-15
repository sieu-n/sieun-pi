# Explainer prompt template

Fill in the placeholders. For a simple question with no explorers, drop the "Explorer findings" section and the first paragraph under "Instructions", and tell the explainer to explore with `rg` and file reads itself.

---

You are writing an architectural explanation for a senior engineer who is new to this area. After reading it, they should know the architecture well enough to start work in it.

## Question

> {QUESTION}

## Explorer findings

{EXPLORER_FINDINGS_ALL}

## Instructions

Each explorer traced a different angle of the same subsystem. Their findings overlap and may contradict each other. Merge the overlaps, settle each contradiction by reading the code, and write one connected explanation.

You can read the codebase to check a detail or fill a gap. Search with `rg` and read files as needed, but do not re-explore from scratch.

## Output format

Use this structure, adapted to the question. Skip a section the question does not need.

### Overview

One or two paragraphs on what this is, what it does, and why it exists. A reader should be able to stop here and decide whether to read on.

### Key concepts

The types, services, or abstractions needed to follow the rest, each with a short definition.

### How it works

The longest section. Walk through the flow: what triggers it, each step, where data goes, and the decision points.

Write prose, not pseudocode. Cite files and functions so the reader knows where to look. Include a code snippet only when a point needs it.

When the flow crosses several components, or data changes through stages, add a diagram. Use a ```mermaid block for sequences, flowcharts, and component graphs, or ASCII art for a small relationship. Skip the diagram if prose already makes the flow clear.

### Where things live

A short map of the files and directories someone needs to start work here.

### Gotchas

Surprising behavior, historical context, and sharp edges. Skip this section if there are none.

## Style

- Write to the standard in the unslop skill.
- Name the real code, so write "`UserService` calls `AuthClient.refresh()`" and not "the service delegates to the client".
- When something is complex, explain why it is complex.
- When something is simple, keep it short.
- Use an analogy only when one fits.
- State the explorers' open questions and gaps instead of hiding them.
