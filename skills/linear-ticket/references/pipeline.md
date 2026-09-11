# Pipeline mechanics

Start every issue with 3-5 core bullets, then add useful owner-facing sections and relevant visuals.
Mocks are optional. Label proposed and observed behavior separately.

## Aside browser

- Read `aside guide repl` for the installed API. Do not assume Playwright methods exist.
- The REPL keeps one top-level scope. Use unique variable names or block scope.
- Capture mock screenshots from the viewport. Full-page stitching can repeat sticky elements.
- Read viewport size and device pixel ratio before cropping. Do not assume a fixed display.
- Scroll each Mermaid diagram into view, capture it, and crop using its bounding rectangle.
- Scroll lazy images into view before checking `naturalWidth`.

## Linear

- Discover current tool schemas before calling them. Field names can differ between issue, milestone and comment operations.
- Upload image bytes through the attachment flow, then reference the returned asset URL.
- Read the issue back to verify image ingestion and formatting.
- Linear can autolink file names and domains. Wrap them in backticks and write `service.py` line 68, not a file-and-line token.
- Linear renders Markdown tables and code fences, not Mermaid. Keep Mermaid source in the linked spec and attach rendered images.
- `linear_ticket.check` is synchronous. Call it without `await`.

## Linked spec pages

Choose a page URL and output folder that the target project can serve.
`build_page()` writes a fragment. The page host supplies its document layout, styles and Mermaid renderer.
Diagram capture requires a visible SVG inside every `<pre class="mermaid">`; raw source text is not a rendered diagram.
The optional local wiki integration can use its own session API and configured page URL.
Treat those endpoints as project configuration, not a required public service.
Verify that the linked page serves images and renders mocks before publishing its URL.
Do not embed credentials, private customer records or internal infrastructure details in examples.
