# Pipeline mechanics

## Aside capture

Read the `aside-browser` skill for the REPL API and its limits.

- Capture mock screenshots from the viewport, because full-page stitching can repeat sticky elements.
- Read the viewport size and device pixel ratio before you crop.
- Scroll lazy images into view before you check `naturalWidth`.

## Linear

- `push()` and `upload_image()` import Prime's `linear` integration module, so a push fails when `import linear` fails in the kernel.
- Discover the current Linear tool schemas first, because field names differ between issues, milestones, and comments.
- `push()` uploads each `assets/` image through `upload_image()`, which uses the attachment upload flow and returns the asset URL.
- `push()` reads the issue back and returns any autolinked tokens, and you fix them and push again.
- Linear renders Markdown tables and code fences.

## Linked spec page

Check that the linked page serves its images and renders its diagrams before you publish its URL.
Keep credentials, private customer records, and internal infrastructure details out of examples.
