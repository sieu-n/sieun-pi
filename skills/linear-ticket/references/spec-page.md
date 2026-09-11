# The spec page and optional mock

Choose an output folder and a page URL that the target project can serve.
A wiki is optional. No private app checkout or fixed local server is required.
`build_page()` writes an HTML fragment, not a standalone document.
The page host must supply layout, styles and Mermaid rendering when diagrams are present.

For a separately configured auto-sns-agent checkout, the optional wiki integration uses `apps/llm-wiki/content/sessions/`.
Only that integration uses its `.agents/skills/apps/llm-wiki/references/page-authoring.md` instructions.
The issue starts with 3-5 core bullets and keeps the explanation the owner needs to understand or decide.
Do not replace that explanation with a wiki link.

## Page content

- Start with the outcome and who the change affects.
- Explain the approach, concrete before-and-after examples, tradeoffs, and success conditions when useful.
- Choose sections for the subject. Do not require the old six sections, continuous numbering, or Size.
- Put code pointers, edit order, commands, and debugging notes in `<details><summary>Agent notes, low level</summary>`.
- Keep those notes collapsed and out of the Linear issue.
- `build_page()` keeps opening bullets and supporting prose, with optional legacy numbered lists.

## Diagrams and screenshots

Use many relevant visuals beside the behavior or decision they explain.
Show important states and choices rather than decorative diagrams.
Keep Mermaid in `<pre class="mermaid">` on the selected page.
Configure that page host to render a visible SVG inside each Mermaid element.
`capture_diagrams()` checks all diagrams before taking any screenshot and returns a setup error if rendering is missing.
It saves PNGs for Linear under `assets/diagrams/dN.png`.
Put screenshots in `assets/mock/<state>.png` or another `assets/` folder.

Label each image as observed behavior, proposed behavior, or a mock screenshot.
For observed behavior, state where and when you saw it.
A proposed diagram or mock screenshot does not prove that the product works.
There is no fixed image quota and no mandatory mock for every ticket.

## When a mock helps

Build a mock when the owner needs to compare an interaction or a proposed screen.
For API work, a rendered OpenAPI example can help compare the request and result.
Use synthetic records for public mocks. Do not copy private API payloads into a reusable example.

Use the target app's components and styles with fake data and no network calls.
Choose a local mock route or static page that the target project supports.
In a separately configured auto-sns-agent checkout, `apps/search/src/routes/dev/session/` is one optional location.
Verify the target project's production exclusion rules before adding a mock route.
Keep mocks uncommitted unless asked otherwise.
Use explicit state and theme controls that the selected mock page supports.
Test the interaction and capture screenshots with the Aside browser.
An HTTP 200 alone does not prove the screen or interaction works.

## Shared browser work

When several workers write tickets, the parent owns screenshots and diagram captures.
The Aside REPL shares one page, so coordinate captures rather than navigating it from parallel workers.
Workers can write the ticket, wiki detail, optional mock, and state descriptions.
The parent captures images, calls synchronous `linear_ticket.check()`, pushes, and reads the issue back.
