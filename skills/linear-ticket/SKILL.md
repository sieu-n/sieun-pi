---
name: linear-ticket
description: Write and push Linear issues, tickets, specs, and milestones. Use when writing, rewriting, or publishing work on the board. Issues start with 3-5 short core bullets, then owner-facing sections with diagrams and screenshots. Ships check(), capture_diagrams(), push(), build_page(), and run().
---

# linear-ticket

## Write the core first

Start every issue description with 3-5 short bullets about the outcome, scope, and promises.
The cap covers the opening core only.
Put links and supporting sections after the core.

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

Assume the reader knows little of the codebase.
State what changes for a person before how the code changes.
Show concrete before-and-after behavior, examples, tradeoffs, and observable results.
Give each product decision concrete options and a recommendation.
Keep code pointers on the linked spec page, not in the issue.
A link adds detail and never replaces the explanation.

Put a diagram or screenshot beside each flow, screen, or choice it explains.
Label each image as observed behavior, proposed behavior, or a mock.
A mock never proves that the software works.
Linear does not render Mermaid, so keep the Mermaid source on a spec page and capture it as PNGs with `capture_diagrams()`.
Put local images under `assets/diagrams/dN.png` and `assets/mock/<state>.png`; `push()` uploads them.
Do browser work through the `aside-browser` skill.

## Rules that check() enforces

- Write one sentence per line, at most 22 words, ending in a period or question mark.
- A line that introduces a list may end with a colon.
- Keep prose under 8 KB, not counting tables, code, and images.
- Keep each code block to 14 lines or fewer.
- Follow the `unslop` skill for dashes, quotes, colons, and banned words.
- Put file names and domains in backticks, and write `service.py` line 68 instead of a file-and-line token.

Also write a lowercase outcome title under 80 characters, and quote the owner only with a source and date.
`check()` does not judge clarity, so read the explanation and image labels yourself before you publish.

## Calls

```python
linear_ticket.check("folder/ticket.md")  # synchronous, accepts a path or text, prints and returns violations
await linear_ticket.capture_diagrams(page_url, "folder/assets/diagrams")
await linear_ticket.push("VIR-371", "folder/ticket.md", title=None)
linear_ticket.build_page("folder/ticket.md", "folder/index.html", title=..., summary=..., apps=[...], tags=[...], ticket_url=..., request=..., mermaid=[...], agent_notes=[...])
await linear_ticket.run("folder/ticket.md", issue="VIR-371", page_url=page_url)
```

`push()` refuses a ticket with violations; pass `force=True` only after you read them.
`await linear_ticket(...)` is the same as `run()`.
Omit `page_url` from `run()` when the ticket has no diagrams.
`page_url` is any page your project serves.
`build_page()` writes an HTML fragment, so the page host must supply layout and Mermaid rendering.
`capture_diagrams()` takes no screenshot unless every `<pre class="mermaid">` holds a visible SVG.

## Milestones

Start a milestone description with "Proposed date.", state its principles in two or three sentences, and link the spec hub.
Pass `project=<uuid>` to `save_milestone(id=..., project=<uuid>, ...)` on update too.

## References

- `references/spec-page.md` covers the linked spec page, image labels, and optional mocks.
- `references/pipeline.md` covers Aside capture and Linear upload mechanics.
