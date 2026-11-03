# Page authoring

This file is the HTML shape of a wiki page. The system contract is the wiki page `apps/llm-wiki/index.html`.
Write every page as HTML. The viewer renders `.md` only for the `@code/` mirror and legacy pages, so never write a `.md` page.

## The format, a numbered statement stream (메르 style)

The page is a stream of numbered one-fact lines, with diagrams, tables, code blocks, images and examples inside the stream.
`writing.md` holds the rules for lines, visuals and words, and this section is the HTML shape.

1. One line is one fact in one `<li>`, written as one plain sentence, and numbering runs on across sections with `start=`.
2. A line states a fact ("PG is the source of truth.") and never describes the page ("This page documents...").
3. Evidence such as the file path, the count or the date sits in the line, never in "see above".
4. A real request, a real row or a before and after goes in a `<pre><code>` block as an example.

### Worked example, copy this shape

```html
<h2 id="why">1 · Why the frontier lives in PG</h2>
<ol>
	<li>The frontier is the queue of profiles we know exist but have not crawled.</li>
	<li>It lives in PostgreSQL in <code>profile_candidates</code> and not in Redis.</li>
	<li>Redis lost, because the frontier must survive restarts and we triage it with SQL.</li>
	<li>Workers claim batches with <code>FOR UPDATE SKIP LOCKED</code>, so 12 replicas never fight over a row.</li>
	<li>Only crawls discover new candidates, so an empty frontier cannot fill itself.</li>
	<li>A separate seed job puts the first handles in on purpose.</li>
</ol>

<pre class="mermaid">
flowchart LR
  seed["seed job"] --> pc[("profile_candidates")]
  pc -->|"SKIP LOCKED claim"| w["crawl worker"]
  w -->|"new handles"| pc
  w --> pg[("profiles")]
</pre>

<h2 id="claiming">2 · How a claim works</h2>
<ol start="7">
	<li>A claim takes 64 rows, set by <code>CLAIM_BATCH</code> in <code>src/frontier/claim.py</code>.</li>
	<li>One batch is about one worker-minute at the per-proxy rate cap.</li>
	<li>A bigger batch strands more rows when a worker dies.</li>
	<li>A claimed row frees itself when its 10-minute lease runs out, so no cleanup job exists.</li>
</ol>
```

Every line stands alone and carries its own evidence. At least a quarter of the lines answer why or how, and the diagram sits inside the stream.

### Anti-example, the rejected shapes

```html
<h2>Overview</h2>
<p>
	The frontier system is a robust and essential component of the crawler architecture. In this section we will describe
	how it works and why it is designed the way it is...
</p>
<ol>
	<li><strong>Claiming.</strong> SKIP LOCKED; batch 64; lease 10 min. No janitor.</li>
</ol>
```

The paragraph is a prose wall with meta-narration and no numbers. The line is a bold label plus fragments.

### Self-check before publishing

1. `node apps/wiki/scripts/prose-lint.mjs <page>` reports 0 errors and 0 warnings.
2. The body is `<ol>` lines with `start=` numbering that runs on across sections.
3. The page has at least one mermaid diagram, and a visual every 4 to 8 lines.
4. At least a quarter of the lines answer why, how or why not.
5. Each line reads once at speech pace without a re-read.
6. Real numbers, `<code>` identifiers and file paths are present.
7. No full screen of the rendered page is text without a picture, table or code block.
8. Every heading id on the page is unique, counting both an `id` you write and the slug the renderer makes from a heading's text, because `injectHeadingIds` in `apps/wiki/src/lib/server/render.ts` keeps a written id without checking it against those slugs and the page's table of contents keys its list on the id. On 2026-10-20 a crm-creators page had `<h2 id="header">` and `<h3>Header</h3>`, the table of contents threw Svelte `each_key_duplicate` and the body rendered blank, while prose-lint passed and the page API answered 201. Give a sub-heading its own words, such as `Header checks`, and open the rendered page to see that its contents list has entries.
9. Never use a one-word heading id that names a DOM or form property, such as `target`, `action`, `name` or `title`, because `DOMPurify.sanitize` in `apps/wiki/src/lib/server/render.ts` strips an id that could clobber `document` or a form, and use two words such as `target-model`. On 2026-10-27 a brand-watch session page had `<h2 id="target">`, which rendered with an empty id and left a blank entry in its contents list, while the page API answered 201 and prose-lint passed. After a page write, read `document.querySelectorAll('h2')` ids in Aside and check that each `pre.mermaid` holds an `svg`.

## Current state only

A curated page describes the system as it is now.

1. Replace an execution ledger of finished work ("step 1 done, step 2 done") with one line and a link to the curated page that graduated from that work.
2. Never link a curated page to a session artifact, because only the `index.html` log of a folder is the durable record, and the backup keeps no file over 1 MB, and `GET /api/agent/lint` lists such links under `sessionLinks`.
3. Delete a page of dead content or move it to `archive/` with `archived_reason`, instead of putting a SUPERSEDED banner over it.
4. Keep a point-in-time census on its owning page only, dated and with its reproduce command, and link to it from the other pages.
5. Delete or archive a plan that was carried out differently, because the code and the project page are the record.

## Skeleton

A page is a folder with `index.html`, plus `assets/` for images and `data/` for CSV.
Start every page with the meta comment and one `<h1>`, never two:

```html
<!--wiki
{ "title": "Thing", "date": "2026-06-26", "updated": "2026-06-26",
  "apps": ["search"], "tags": ["billing"], "status": "complete",
  "owner": "platform", "summary": "One-line abstract." }
-->
<h1>Thing</h1>
<wiki-tldr>
	<strong>What.</strong> One line on what this page is. <strong>Background.</strong> One line of context.
	<strong>Read this if</strong> you need the problems it answers; go to X if you need Y.
</wiki-tldr>

<h2 id="section">1 · Section</h2>
<ol>
	<li>…statements…</li>
</ol>
<h2 id="related">Related</h2>
<p><a href="../other-page/index.html">Other page</a> · <a href="../index.html">Hub</a></p>
```

The meta keys are in §3 of the system spec.
`date`, `updated`, `apps`, `tags` and `status` are required, and `title`, `owner` and `summary` keep the API output stable.
A `source_refs` path in the sieun-pi repo starts with `sieun-pi:`, as in `sieun-pi:components/pi-pool/pool/sched.py`, so the stale check dates it by sieun-pi's git and skips it on a box with no sieun-pi checkout.
Set `last_verified` to the UTC time you checked the page against its code, as in `2026-10-20T15:02Z`, and the stale check flags the page when the tip changes a `source_refs` path after that time.
When you add or swap a `source_refs` entry, read the page against that ref's current code and set `last_verified` to the time of that read, because an older `last_verified` makes the page behind its code the moment it lands. On 2026-10-30 41017ab1a0 swapped a ref of apps/search/enterprise-mock.html to a TimeChart.svelte changed after the page's `last_verified`, and the wiki dream counted the page stale on arrival. The page gate prints a `page gate warning:` line for such a ref, and the page API returns it in `warnings`.
When the page states only some definitions of a file, cite each one as `path::name`, as in `convex/search/admin.ts::resolveAccess`, so the stale check flags the page only when the tip changes that definition, and cite the whole file when the page states a fact about the file as a whole.

The frontmatter `title` is the sidebar label, so keep it short.

1. Use about 3 words, because the folder gives the context, so `platforms/instagram` gets the title `Instagram`.
2. Never prefix the app name, so `crawler-v3 · Docker & containers` under `apps/crawler-v3/` is wrong.
3. Put the long form in `description`, which search results and hovers show, never in a subtitle.
4. Make the `<h1>` match `title`, because the lint checks the pair.

## The TL;DR block

`<wiki-tldr>` is a triage block that the wiki copies into the page object and into every search, grep and ⌘K result row.
A reader or agent uses it to decide whether to open the page.

1. "What" names what the page is.
2. "Background" gives the context, if any.
3. "Read this if" names the problems the page answers, plus a pointer elsewhere for readers it does not serve.
4. Write it for the searcher, such as "Read this if you're changing how the gateway charges a request," not "This documents the billing pipeline."
5. A TL;DR that needs more than about 3 lines means the page does two jobs, so split the page.

## What survives the sanitizer

`render.ts` runs `expandWikiComponents`, then rewrites links and images, then runs DOMPurify (`isomorphic-dompurify`).

| Author this                                                                  | Result                              |
| ---------------------------------------------------------------------------- | ----------------------------------- |
| Inline `<svg>` (rect/line/path/text/polygon, `fill`/`stroke`/`currentColor`) | kept                                |
| `<table>`, `<details>`/`<summary>`, `<pre><code>`, lists                     | kept                                |
| `style=` attribute on any element                                            | kept                                |
| `<wiki-figure>` / `<wiki-gallery>` / `<wiki-table>` / `<wiki-cite>`          | expanded before sanitize, then kept |
| `<script>`, `<style>` block                                                  | stripped, never rely on them        |

Draw with mermaid or inline `<svg>`, style with `style=` attributes, and get interactivity from `<wiki-*>` components, never from a script.

## Live views

A page holds a live view as an empty slot `div` that the page script fills, because a script in the page is stripped.

1. `<div data-wiki-git-status></div>` draws the branch state right now: each dev branch, `staging`, `main`, the newest lands and the release runs going now, refreshed every minute.
2. It reads `/api/git-status`, which runs auto-sns-agent's `scripts/ci/git-status.mjs` on this box's git refs and the CI cache file, so it makes no GitHub call.
3. Put a numbered line inside the slot as a fallback, because an agent reading the page as text sees only that line.
4. The git rules page `sessions/2026/10/27/1107-git-branch-rules-explainer/git-branch-rules.html` holds one.

## Proof components

```html
<wiki-figure src="assets/diagram.svg" caption="What it shows">
	<wiki-gallery dir="assets/screens"> <wiki-table src="data/results.csv" sortable filterable></wiki-table></wiki-gallery
></wiki-figure>
```

Asset and data paths are page-relative and cannot leave the page folder, and the renderer rewrites them to `/raw/<page>/<path>`.
A missing file renders an inline note and fails L2 of the gate.
On 2026-10-22 a page lost its `<wiki-table src>` data in git, because a page's `data/*.csv` stays on us-metal02, and the backup repo `sieu-n/wiki-content` keeps only `.html` and `.md` files, so put a table that must survive in the backup inline as an HTML `<table>`.

## Source citations on hover

Every number on a page that a reader may question carries its source on hover, because on 2026-10-30 the owner found a plan page stating "$5,714 of StepFun list-price API usage" with nothing behind it and asked for hover sources on every wiki article.

```html
<wiki-cite src="data/run.json" note="Mean of 9 fields against the Opus key, 220 creators, run 10-30">89.6%</wiki-cite>
<wiki-cite note="Unknown: StepFun publishes no credit-to-token rate">unknown</wiki-cite>
```

1. `src` is a page-relative file, a wiki page or a vendor URL, and the tip links it with a short label, or with `label="..."` when you set one.
2. `note` says what the number is and how it was read, such as the run, the date or the vendor quote.
3. A cite with a `note` and no `src` renders dashed and muted, which marks an assumption or an unknown, so write the assumption in the note.
4. `expandCites` in `apps/wiki/src/lib/server/wiki-components.ts` renders it, and the page script places the tip, which works in a scrolling table too.

## Generated page lists

On 2026-10-10, 10 curated pages had no hub listing them and 8 hub links pointed at retired pages, because hubs kept their lists by hand.
`<wiki-children>` builds the list from frontmatter at render time (`apps/wiki/src/lib/server/wiki-children.ts`).
Moving an existing hand-kept hub to it waits for the owner's ok, so use it on a new hub or a hub the owner approved.

1. A bare `<wiki-children></wiki-children>` lists the folder of the page that holds it, and `path="..."` lists another folder, page-relative like `<wiki-gallery dir>`.
2. It lists every page directly in the folder plus each sub-folder's `index.html` or `README.html`, and walks through sub-folders with no index page.
3. It hides pages with status `superseded`, `deprecated` or `archived`, and anything under `archive/`, `sessions/` or `@code/`.
4. Rows sort by the optional numeric frontmatter `order`, then by title, so set `order` to put the start-here page first.
5. `exclude="a.html,b/"` hides the named pages or folders.
6. The default render is a two-column table, and `headers="A,B"` names its columns.
7. `as="list"` renders an `<ol>` of "title · description" lines.
8. A row shows the page's `title` and `description`, so fix a long title or a missing description on the page, not in the hub.

```html
<h2 id="pages">Pages</h2>
<wiki-children exclude="drafts/" headers="Page,What it answers"></wiki-children>
```

## Diagrams

Use mermaid (`<pre class="mermaid">…</pre>`) for flows, pipelines and sequences, as in §2 of `apps/crawler-v3/architecture/index.html`.
In August 2026 a page meant to show two lanes side by side under `flowchart LR` rendered them stacked, because `flowchart LR` lays unlinked subgraphs out top to bottom.
For side-by-side lanes, use an outer `flowchart TB` and put `direction LR` or `direction TB` inside each subgraph, as the wiki page `apps/crawler-v3/contact-discovery/algorithm.html` does.
Break a node label with `<br/>`, because a plain newline inside the label does not break it.
On 2026-10-16 a review page showed "Syntax error in text" in place of a flowchart, because mermaid 11.16.1 does not parse a line such as `style c fill:rgba(239,68,68,0.12),stroke:#ef4444`, and prose-lint does not catch it.
In a mermaid `style` line, use a hex fill such as `#fee2e2` or `#dcfce7`, and keep rgba fills for inline SVG only.
The page renders mermaid in the browser with `suppressErrors: true` in `apps/wiki/src/routes/page/[...slug]/+page.svelte`, which keeps a broken diagram from breaking the page but still draws mermaid's "Syntax error in text" box as an `svg` in its place.
On 2026-10-12 a weekly-index page job saw that box in place of its diagrams, and a count of `pre.mermaid svg` passes such a page, so check a page by opening it in Aside and reading the `innerText` of every `pre.mermaid` for `Syntax error`.
Use inline SVG only for a custom layout, such as precise positioning or an annotated screenshot, and make it work in both themes.

1. Text and strokes use `fill="currentColor"` and `stroke="currentColor"`, dimmed with `opacity` or `stroke-opacity`.
2. Accent fills use low-opacity rgba such as `fill="rgba(59,130,246,0.12)"`.
3. Accent strokes use `#3b82f6` blue, `#8b5cf6` purple, `#10b981` green, `#f59e0b` amber or `#ef4444` red.
4. The `<svg>` carries `style="max-width:100%;height:auto"`, `role="img"` and an `aria-label`.

## Images

1. Draw diagrams first, as mermaid or inline SVG.
2. Capture screenshots from the running app, save them in the page's `assets/`, and show them with `<wiki-figure>`, with download links through `/raw/<path>`.
3. Generate illustrations with `gpt-image-2.5-sunburst` through Vent and CLIProxyAPI, never with a direct OpenAI key, per `.agents/skills/stack/llm-usage/references/ai-model-usage.md`, and save them in `assets/`.

## Secondary patterns

1. A page-properties panel is a two-column `<table>` of Status, Owner, Audience and Updated under the lede.
2. A status lozenge is `<span style="display:inline-block;padding:2px 10px;border-radius:10px;background:rgba(245,158,11,0.18);font-size:12px;font-weight:700">DRAFT</span>`.
3. An info panel is `<div style="background:rgba(59,130,246,0.08);border-left:3px solid #3b82f6;padding:8px 12px">…</div>`.
4. Collapsible detail goes in `<details><summary>…</summary>…</details>`.
5. Enumerable facts such as scope items, acceptance criteria and finding ledgers can go in a `<table>` or `<wiki-table>` with one-line cells, while the reasoning stays in numbered lines.

## Linking

1. Use `<a href="…">` with page-relative paths.
2. The resolver tries `target`, `target.html`, `target/index.html` and `target/README.html`, so a link to a folder lands on its page.
3. External links and app routes such as `/graph` and `/api/...` pass through unchanged.
4. An unresolved internal link renders dashed orange and fails L2 until you fix it.
5. Link the page to its evidence: the `experiments/<run>/` page, the raw result at `/raw/experiments/<run>/results/<file>.json`, and the source spec.
6. On 2026-10-10 a vent-design page link to a source file under `/page/@code/` returned 404, because `apps/wiki/src/lib/server/wiki-mirror.ts` mirrors only `.md` and `.mdx` docs, such as CLAUDE.md files, `.claude/rules` and `.agents/skills`.
7. Link a source code file as `https://github.com/sieu-n/auto-sns-agent/blob/dev/sieun/<path>`, or write its path in `<code>` with no link.
8. A link into `experiments/` shows as an experiment ref on the page object.
9. Link a file that is not a page, such as a `.py` or `.mjs` script, as `/raw/<path>`, because the page API and the page gate refuse a write that adds a dead link, and on 2026-10-20 commit 6c215f6edf landed 12 dead relative links to `bench/*.py` and `data/*.py` on `projects/multi-platform-crawl-scale/index.html`.
