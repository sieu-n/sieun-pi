---
name: linear-ticket
description: Write and push Linear issues, tickets, specs, and milestones. Use when writing, rewriting, or publishing work on the board. Issues start with 3-5 short core bullets, then owner-facing sections with diagrams and screenshots. Ships check(), capture_diagrams(), push(), build_page(), and run().
---

# linear-ticket

## Write the core first

Open every issue description with 3 to 5 short bullets on the outcome, the scope, and what the change promises.
The cap covers this opening core only, and links and other sections come after it.

```markdown
- Readers can see which saved accounts need attention.
- This change covers the watchlist page.
- Existing saved accounts stay in their current lists.

## Success conditions

- A failed refresh shows a retry button beside the account.
- Retrying keeps the account in its original list.
```

Add a section only when it helps the owner understand or decide, such as Approach, Before and after, Success conditions, or Open decisions.
A small issue may need only the core.
Do not add a Size field, numbered sections, or a mock by habit.

## Write for the owner

The owner knows little of the codebase, so state what changes for a person before how the code changes.
Show before-and-after behavior, examples, tradeoffs, and results a person can see.
Give each product decision its options and a recommendation.
Keep code pointers on the linked spec page, not in the issue.
A link adds detail and never replaces the explanation.

Put a diagram or screenshot beside each flow, screen, or choice it explains.
Label each image as observed behavior, proposed behavior, or a mock.
A mock never proves that the software works.
Linear does not render Mermaid, so keep the Mermaid source on a spec page and capture it as PNGs with `capture_diagrams()`.
Put local images under `assets/diagrams/dN.png` and `assets/mock/<state>.png`, and `push()` uploads them.

## Rules that check() enforces

- Each line is one sentence of at most 22 words that ends in a period or question mark.
- A line that introduces a list may end with a colon.
- Prose stays under 8000 bytes, not counting tables, code, and images.
- Each code block has 14 lines or fewer.
- Long dashes, curly quotes, a mid-sentence colon, and the `unslop` banned words fail, though a banned word inside double quotes passes.
- A `file.py:68` token outside backticks fails because Linear autolinks it, so write `service.py` line 68.
- An `assets/` image the ticket links must exist on disk when you pass `check()` a path.

`push()` wraps bare file names in backticks itself, but it leaves domains alone, so put domains in backticks by hand.
Write a lowercase outcome title under 80 characters, because `push()` rejects a longer one.
Quote the owner only with a source and a date.

## Calls

```python
linear_ticket.check("folder/ticket.md")  # synchronous, accepts a path or text, prints and returns violations
await linear_ticket.capture_diagrams(page_url, "folder/assets/diagrams")
await linear_ticket.push("VIR-371", "folder/ticket.md", title=None)
linear_ticket.build_page("folder/ticket.md", "folder/index.html", title=..., summary=..., apps=[...], tags=[...], ticket_url=..., request=..., mermaid=[...], agent_notes=[...])
await linear_ticket.run("folder/ticket.md", issue="VIR-371", page_url=page_url)
```

`push()` refuses a ticket with violations.
Pass `force=True` only after you read them.
`run()` captures diagrams into `assets/diagrams` next to the ticket when you pass `page_url`, then checks, then pushes only when you pass `issue`.
Omit `page_url` when the ticket has no diagrams, and otherwise pass any page your project serves.
`build_page()` writes an HTML fragment, so the page host must supply layout and Mermaid rendering.
`capture_diagrams()` takes no screenshot unless every `<pre class="mermaid">` holds a visible SVG.

## Milestones

Start a milestone description with "Proposed date.", state its principles in two or three sentences, and link the spec hub.
Pass `project=<uuid>` to `save_milestone(id=..., project=<uuid>, ...)` on an update too.

## Done when

1. `check()` prints `clean`.
2. The dict that `push()` returns has an empty `autolinks` list.
3. You read the explanation and image labels yourself, because `check()` does not judge clarity.

## References

- `references/spec-page.md` covers the linked spec page, image labels, and optional mocks.
- `references/pipeline.md` covers Aside capture and Linear upload mechanics.
