---
name: linear-ticket
description: Write and push Linear issues, tickets, specs, and milestones. Use when writing, rewriting, or publishing work on the board. Issues start with 3-5 short core bullets, then useful owner-facing sections with diagrams and screenshots. Ships check(), capture_diagrams(), push(), build_page(), and run().
---

# linear-ticket

## Write the core first

Start every issue description with 3-5 short bullets about the outcome, scope, and promises.
This cap applies only to the opening core, not the whole description.
Put links and supporting sections after the core.
This is the owner's latest correction on 2026-09-10 and replaces the old numbered spec format.

```markdown
- Readers can see which saved accounts need attention.
- This change covers the watchlist page.
- Existing saved accounts stay in their current lists.
- A reader can retry a failed refresh without leaving the page.

## Approach

Keep the account row visible while its refresh runs.
Show the failed state beside the account instead of hiding it in a notification.

## Success conditions

- A failed refresh shows a retry button beside the account.
- Retrying keeps the account in its original list.
```

Use supporting sections when they help the owner understand or decide.
Examples include Approach, Before and after, Success conditions, and Open decisions.
There are no fixed section names, continuous numbering, Size field, or mandatory mock.
A small issue may need only the core.

## Write for the owner

Assume the reader has limited knowledge of the codebase.
Explain concrete before-and-after behavior, examples, tradeoffs, and observable results.
State what changes for a person before describing how the code changes.
Give product decisions concrete options and a recommendation.
Keep low-level code pointers in collapsed wiki notes, outside the ticket.
A wiki link adds detail; it cannot replace the human-facing explanation the issue needs.

Use many relevant diagrams and screenshots to explain flows, screens, and choices.
Put each image beside the point it explains.
Label observed behavior separately from proposed behavior and mock screenshots.
Do not present a mock as proof of working software.
There is no fixed image count and no mock requirement for every ticket.
Linear needs diagram images, not Mermaid blocks.
Keep Mermaid sources on a caller-selected page and capture them as PNGs with `capture_diagrams()`.
Use `assets/diagrams/dN.png` and `assets/mock/<state>.png` for local images that `push()` uploads.
Use only the Aside browser for browser work.

## Language and validation

- Write one short sentence per line, at most 22 words, with one idea and a final period or question mark.
- A line that introduces a list may end with a colon; core bullets must be complete sentences.
- Keep prose under 8 KB, excluding tables, code, and images.
- Keep code blocks to at most 14 lines and only when they explain a contract the owner needs.
- Avoid long dashes, curly quotes, mid-sentence colons, bold sentences, and banned words from the unslop skill.
- Put file tokens and domains in backticks. Write `service.py` line 68, not a bare file-and-line token.
- Write a lowercase outcome title under 80 characters.
- Quote the owner's words only with a source and date.

`check()` is synchronous and accepts Markdown text or a file path.
It validates the opening core, prose language, length, and local image paths.
It does not judge product clarity or require supporting sections, tables, images, Size, or a mock.
Review the owner's explanation and image labels before publishing.
`push()` refuses violations unless you pass `force=True` after reading them.

## Calls

Choose `page_url` for a page that your project serves; no fixed server or private wiki is required.
`build_page()` writes an HTML fragment. Its host supplies layout and Mermaid rendering, not this package.
`capture_diagrams()` requires a visible SVG inside every `<pre class="mermaid">` and checks them before taking any screenshot.
Omit `page_url` from `run()` when diagram capture is not needed.

```python
linear_ticket.check("folder/ticket.md")  # synchronous; prints and returns violations
await linear_ticket.capture_diagrams(page_url, "folder/assets/diagrams")
await linear_ticket.push("VIR-371", "folder/ticket.md", title=None)
linear_ticket.build_page("folder/ticket.md", "folder/index.html", title=..., summary=..., apps=[...], tags=[...], ticket_url=..., request=..., mermaid=[...], agent_notes=[...])
await linear_ticket.run("folder/ticket.md", issue="VIR-371", page_url=page_url)
```

`await linear_ticket(...)` is also supported by the Prime Agent module wrapper.
Existing public call signatures are unchanged.

## Milestones

A milestone description starts with "Proposed date." and states the principles in two or three sentences, then links the spec hub.
`save_milestone(id=..., project=<uuid>, ...)` needs `project` on update too.

## References

- `references/spec-page.md` covers wiki detail, image labels, and optional mocks.
- `references/pipeline.md` covers Aside and Linear mechanics, including autolink traps.
