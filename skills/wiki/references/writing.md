# Writing a wiki page

This is the owner's standard for every wiki page, curated or session.
A page is in the 메르 style, named after the Korean blogger the owner points to: numbered short lines, one plain sentence each, with a diagram or image every few lines.

The owner rejected a page of prose paragraphs on 2026-10-10, and the same numbered format with bold-label, stuffed-clause lines on 2026-10-09.
Both lessons hold, so a page is numbered lines, and each line is one normal sentence.

This file is the only source for how a page reads.
The `unslop` skill points here for wiki pages and owns the word rules for all other text.
The HTML shape, with a worked example, is the format section of `page-authoring.md`.

## A subagent writes every page

1. The session that needs a page spawns one writer subagent per page and never writes several pages in one context.
2. The brief names the reader, the question the page answers, the sources to read and the target path.
3. The writer runs the prose lint on its page and fixes every error and warning before it reports back.
4. The parent reads the rendered page against this file and runs the lint again before it links the page to anyone.

Every chat brief carries this line:

> A wiki page is always written by its own subagent, one page per
> subagent. The writer follows `skills/wiki/references/writing.md` in sieun-pi
> and makes `node apps/wiki/scripts/prose-lint.mjs <page>` pass. The parent
> then reads the page against that file before it links the page to anyone.

## The page is numbered lines and pictures

The reader is the owner, who reads as a busy manager.
He should scan the page once, top to bottom, and come away with the answer and the reasons for it.

1. The page opens with the `<h1>`, the `<wiki-tldr>`, and numbered lines that give the answer first.
2. A design or plan page for the owner is about 1/10 the length of a full spec and answers his questions in the order he asked them, each in a short plain sentence with one concrete example, before any options, tables or numbers.
3. On 2026-10-29 the owner could not follow the long spec at `sessions/2026/10/30/0215-wiki-in-sw-factory-design/design.html`, asked his seven questions again, and asked for a 1/10 plan in 메르 style (c201).
4. The body is numbered lines in `<ol>`, and the numbering runs on across sections with `start=`. Since 2026-11-04 the page API sets each top-level `start=` of a curated page on every write and moves an in-page "item N" with its line (`apps/wiki/scripts/ol-numbering.mjs`), so a writer who adds or drops a line never shifts later lists. That day the wiki dream found 115 of 410 curated pages with broken numbers, such as `apps/crawler-v3/workers.html` showing 58 twice. A write whose "item N" names a number two lines share is refused with a 422.
5. Each numbered line is one plain, complete sentence that states one fact.
6. A line stays under about 30 words, so two facts become two lines.
7. A line never opens with a bold label or a `Label:` prefix, so `Owner: the crawler team.` is refused.
8. Lines that say why a design won and why the obvious alternative lost are required.
9. Numbers, file paths and dates sit inside the line as evidence, with identifiers in `<code>`, and every date and time is UTC, which for a commit is its own day from `git log -1 --format=%cI <sha>`, never the owner's KST day. On 2026-10-27 four curated pages, such as `domains/architecture/ci-deploy.html`, dated `3abfc49767`, committed at 20:11Z on 10-27, as 2026-10-28 or "04:26Z on 10-28", and the prose lint rule `future-utc-time` now refuses a Z time or a "since" day later than the write. On 2026-10-28 a job wrote `"updated": "2026-10-29"` and "removed on 2026-10-29" into `apps/crawler-v3/platforms/linkedin/fields.html` at 15:30Z, so `future-utc-time` also refuses a day after a past-tense verb, such as "removed on" or "landed on", and `future-meta-date` refuses a header `date`, `updated` or `last_verified` later than the write, while a plan day such as "expires on 2026-11-30" passes.
10. Every number a reader may question shows its source on hover in a `<wiki-cite src="..." note="...">`, and a number nobody measured is written as unknown or a range in a cite with only a `note` that states the assumption, as the hover section of `page-authoring.md` shows.
11. On 2026-10-29 a plan page stated "$5,714 of StepFun list-price API usage" with no source behind it, and nobody could say where the number came from when the owner asked (c202).
12. Sections are short, about 3 to 8 lines, under a sentence-case heading that names what they hold.
13. A `<p>` is one or two sentences of connective text, such as a lead-in before a diagram.
14. Agent-only detail, such as raw counts and file lists, goes in a collapsed `<details>` block at the end.

## A diagram or image for every flow, structure or comparison

1. Every flow, pipeline, state change or structure gets a mermaid diagram next to the lines that explain it.
2. Every before and after, or option against option, gets a diagram, a small table or two screenshots.
3. Every screen the page talks about gets a screenshot in the page's `assets/` folder.
4. A page carries one diagram or image per 10 numbered lines, and one per 400 words once it passes 300 words, and a table never counts toward that.
5. Owner rule c83 allows one diagram on an owner design page, so that page stays under 20 numbered lines and under 800 words.
6. On 2026-10-18 a 36-line design page for the shared Prime setup failed the `visuals` lint with "want 3", and it passed once cut to 19 lines with one mermaid and a small table.
7. No run of more than 24 numbered lines goes without a diagram or image between them.
8. A diagram uses a concrete example, such as a real event id or a real table name.
9. A diagram makes one point on its own, and a diagram that needs a legend gets redrawn.

## No prose paragraphs

1. A paragraph of more than 3 sentences is a defect, and the lint refuses it.
2. A page whose paragraphs and `<ul>` bullets hold more than 40% of its body words is a prose wall, and the lint refuses it.
3. Turn a paragraph into numbered lines, a diagram or a table.

This line from the 2026-10-09 statement-stream page failed because it is a label plus stuffed clauses:

```html
<li>
	<strong>Layer 1, LLM proxy.</strong> As in the 1918 page. It maps a call type to a model, tries CLIProxyAPI first,
	uses a paid fallback only where a row allows it, and never retries. It is stateless and never touches the database.
</li>
```

This paragraph from the 2026-10-10 blog rewrite failed because it is prose:

```html
<p>
	The gateway forwards requests and never translates them. It retries only calls that are safe to repeat, which are
	calls with an idempotency key and 429 answers that say when to try again. The caller sets a deadline, 10 seconds by
	default, and the gateway never waits past it.
</p>
```

The same facts as numbered lines:

```html
<ol start="12">
	<li>The LLM proxy picks a model for each call type and tries CLIProxyAPI before any paid API.</li>
	<li>The LLM proxy never retries a call and never touches the database.</li>
	<li>The gateway forwards a request as it came and never translates it.</li>
	<li>The gateway retries only calls with an idempotency key and 429 answers that say when to try again.</li>
	<li>The caller sets a deadline, 10 seconds by default, and the gateway never waits past it.</li>
</ol>
```

## Tables and bold

1. A table holds numbers and short facts in cells of a few words.
2. A cell that needs a full sentence belongs in a numbered line instead.
3. Bold marks at most three short terms on a page and is never a sentence or a label.

## Words and punctuation

The word rules are the `unslop` skill's, and the lint checks these on every page.

1. The page has no em dashes and no spaced en dash or hyphen used in place of one.
2. Sentences stay near 20 words and use the word a coworker would say out loud.
3. Sentences use the active voice and name who does the action.
4. AI-tell phrases such as "it's worth noting", "as mentioned" and "not just X but Y" are cut.
5. Real code names, metric names and file names stay as the code spells them.
6. The banned word and phrase lists live in `RULES` in `apps/wiki/src/lib/prose-lint.mjs`, so run the lint instead of memorising them.

| Odd                                                                       | Plain                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| The wrapper orchestrates a quiescence bracket around the mutation window. | The wrapper stops the dev server, runs the check, then restarts it. |
| Restore is executed in the epilogue phase.                                | The dev server restarts in a `finally` block.                       |
| This leverages the extant telemetry infrastructure.                       | It reuses the telemetry files that already exist.                   |

## The prose lint

`node apps/wiki/scripts/prose-lint.mjs <file-or-folder>` prints each finding with its line, rule and fix, and exits 1 on any error.
`--recent 20` lints the 20 newest session pages.

1. The lint reads an `<ol>` item, and a `<p>` that opens with `1.` or `2)`, as one numbered line.
2. `paragraph-blob` and `paragraph-share` refuse prose paragraphs, and `label-opener` refuses `label: value` lines.
3. `visuals` and `visual-gap` refuse a page with too few diagrams or images, or a long run of lines without one.
4. `session-link` refuses a link from a curated page to a file in a session folder other than the session log `index.html`.
5. `english-only` refuses each Korean sentence outside a quote of the owner (`"..."`, `<q>`, `<blockquote>`) or code, per owner rules c2 and c102, and Korean kept on purpose passes under `lang="ko"` or a `ko/` folder.
6. The rule exists because the bloat, soft-caps and multi-box design pages of 2026-10-18 were written in Korean.
7. `sessions/2026/10/09/2344-gateway-v2-rewrite/gateway-v2.html` is the passing example, with 112 numbered lines and 13 diagrams and images.
8. The page write API (`POST` and `PATCH /api/agent/page`) answers 422 when a write adds lint errors.
9. The lint does not check size, and the write API accepts a page over the 64 KiB `PAGE_READ_LIMIT` in `apps/wiki/src/lib/server/wiki.ts`, but the reader then shows a "truncated preview" cut mid-page and `GET /api/agent/page` answers 413.
10. On 2026-10-19 a lint rewrite of `experiments/2026-08-16-email-finder-round2` grew about 30% from split lines and one mermaid per 10 lines and passed 64 KiB, so keep a rewrite under about 62 KB by merging closely linked facts into one sentence, stripping indentation inside mermaid blocks and dropping the tab before `<li>`.
11. The engine runs the same lint on every write, and no page reaches git except through the backup timer, which commits what the engine wrote.
12. An edit to an old page passes when it adds no new errors, so legacy pages stay editable.
13. The lint skips `requests.html` and session log `index.html` files, because they hold verbatim text, and it skips `archive/` and `@code/`.
14. Write pages through the page API so the write check runs, and never write page files directly.
15. On 2026-10-28 parallel dream writers kept their page write bodies in the machine's shared temp folder, so a writer that ran `curl --data @r7-patch.json` there sent another job's body under the same name and applied that edit to `apps/search/onboarding-orgs.html` instead of its own page.
16. Write a page write body to `$SESSION/<uuid>-patch.json` in your workspace folder, or pass the JSON on stdin with `--data @-`, and check that the `path` field of the response names your page.
