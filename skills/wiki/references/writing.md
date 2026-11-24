# Writing a wiki page

This is the owner's standard for every wiki page.
A page reads as plain prose under sentence-case headings, like a Confluence page, with a diagram for each flow or structure it describes.
A page under `apps/` or `domains/` holds only the layers a reader can check, as the section "Pages under apps/ and domains/" says, and what a job writes in its own session folder is the job's call.

On 2026-11-24 the owner called the numbered one-sentence-line form of the older wiki unreadable (#dev-crawler p19, "no the llm-wiki is unreadable", c235), and a curated page of about 1,800 words far too long (p23, msg mwtwsw4j, c243).
So no page is a string of numbered one-sentence lines, and a numbered list holds only steps in order.
The older lessons still hold: a bullet is one normal sentence (c20), and a line never opens with a bold label.

## Pages under apps/ and domains/

The owner's words, #dev-crawler p23 on 2026-11-24: "sessions/ under에 적는건 적는건 알아서 하는데, apps/domains 등에 들어가는건 핵심, 확인 가능한 실질적인 레이어 (flow/call stack, tables, fields) 만 따로 말해".

1. A curated page under `apps/` or `domains/` holds only the layers a reader can check against the system: the flow or call stack, the tables and the fields.
2. Each layer names the real things as the code spells them, such as the function, file, service, port, database, table and column, and says where each one lives: the host, the path or the container.
3. Keep the page near 800 words outside link-only lines, and the lint warns with `core-length` past that. 800 is the design page size the owner accepted under c201, and `domains/devops/clickhouse-layout.html` had 1,761 words in 10 sections when he called it far too long. The page API answers 422 on a write that takes a page from 800 words or fewer past the line or creates one past it, and a page already past the line saves with the warning, so a writer cuts it in a later write.
4. The question that started the work, the options weighed, what was dropped, the measurements, the history and the calls left for the owner go in the session page. The curated page keeps one sentence of why per choice and links the session log.
5. Link the session log `index.html`, which lists the write-up, because `session-link` refuses a curated link to any other file in a session folder.
6. A page with no diagram, numbered steps, table, field list (`<dl>`) or code block gets a `core-layers` warning, and a hub page of links is exempt.
7. On the 1,761-word ClickHouse page, about 710 words were short answers, our pick, what we dropped and calls for the owner, which all belong in the session page.
8. Set `"doc_kind": "reference"` for a page that is mostly tables and fields, and `"explanation"` for a page that says how parts fit, so the page opens with an intro paragraph and no `<wiki-tldr>`.
9. No length, layer or diagram rule of this section applies to a page in a session folder.

A page under `apps/` or `domains/` has these sections, in this order.

| Section | What it holds |
| --- | --- |
| intro paragraph | what the system is, where it runs, and what the page holds |
| the flow | one diagram, then the call stack or pipeline as numbered steps with real names |
| tables and fields | one table per store or config file, with name, type and meaning columns |
| check it | the commands or queries that show each layer on the live system |
| links | the session log and the pages next to this one |

This file is the only source for how a page reads.
The `unslop` skill points here for wiki pages and owns the word rules for all other text.
The HTML shape, with a worked example, is the format section of `page-authoring.md`.

## A subagent writes every page

1. The session that needs a page spawns one writer subagent per page and never writes several pages in one context.
2. The brief names the reader, the question the page answers, the sources to read and the target path.
3. The writer runs the prose lint on its page and fixes every error and warning before it reports back.
4. The parent reads the rendered page against this file and runs the lint again before it links the page to anyone.

A brief for a job that writes a wiki page carries this line. No brief template adds it, and every job also gets the rule as owner rule c20 in its corrections block:

> A wiki page is always written by its own subagent, one page per
> subagent. The writer follows `skills/wiki/references/writing.md` in sieun-pi
> and makes `node apps/wiki/scripts/prose-lint.mjs <page>` pass. The parent
> then reads the page against that file before it links the page to anyone.

## Documentation pages

On 2026-11-23 the owner asked for the sw factory docs as a Confluence space that onboards him (#sw-factory-build p174, msg mwtd0iuy): "can you make the document properly..? i dont like the way you wrote llm-wiki. skill:unslop, and also think of writing an actual confluence tutorial page like as to onboard me."

1. A page declares its kind in the `doc_kind` field of its `<!--wiki {json}-->` header, as one of `start`, `tutorial`, `how-to`, `reference`, `explanation` or `design`.
2. Set the older `kind` field to the same value, because the L1 gate needs it, while the lint reads only `doc_kind`, since 550 older pages already carry `"kind": "reference"`.
3. A page with no `doc_kind` and a `design` page read as prose too, and they skip only the section rules of the five documentation kinds.
4. The first five kinds read like a Confluence space that onboards a new engineer, in plain prose under the unslop skill.
5. The split comes from Diátaxis: a tutorial teaches by doing, a how-to walks a reader who knows the basics through one task, a reference describes the machinery for lookup, and an explanation says how the parts fit and why.

Every documentation page has these parts.

1. The `<h1>` comes first, then one intro paragraph that says who the page is for and what they will have or know at the end.
2. The page has no `<wiki-tldr>`, because the intro paragraph and the header's `description` do that job.
3. Headings are sentence case and name what the section holds, such as "Run the lint", never "1 · Overview".
4. Paragraphs hold two to four sentences and at most 100 words.
5. A bullet list holds parallel items only, each one full sentence, and no bullet opens with a bold label.
6. Numbered steps appear only where the reader does things in order.
7. A flow or structure the page describes gets a mermaid diagram, and a screen it describes gets a screenshot.
8. Every number a reader may question keeps its source on hover in a `<wiki-cite>` (c202), and every date is UTC.
9. The page ends with links to the next pages, each named by its title.

| `doc_kind`    | The reader                             | Sections, in order                                                                 |
| ------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| `start`       | opens the space for the first time     | intro, "Start here" with 3 pages, then one section per folder with a line per page |
| `tutorial`    | is new and learns by doing             | intro, "Before you start", stages of steps, "Check it worked", "When it goes wrong", "Next steps" |
| `how-to`      | knows the basics and has one task      | intro, "Before you start", steps, "Check it worked", "When it goes wrong"          |
| `reference`   | looks up one fact                      | intro, then tables with a sentence or two before each                              |
| `explanation` | wants to know how parts fit and why    | intro, prose sections with a diagram per flow, links to tutorials and reference    |
| `design`      | the owner, deciding                    | short prose that answers his questions in order, as "Plan, spec and status pages" says |

A tutorial or how-to step works like this.

1. Each step is one `<li>` in an `<ol>`, with a sentence or two on what to do and why, then the real command in `<pre><code>`, then what it printed or a screenshot.
2. Copy the output from a real run on this box, trimmed with `...`, and never write output you did not see.
3. Each section's step list starts at 1, and the page API leaves a documentation page's `start=` values as written.
4. "Check it worked" shows the command or screen that proves the result and says what the reader should see.
5. "When it goes wrong" names each real error seen while you wrote the page, with its cause and its fix.

The structure comes from these pages, which a writer reads for shape, never for words.

1. Diátaxis splits docs into [tutorials](https://diataxis.fr/tutorials/), [how-to guides](https://diataxis.fr/how-to-guides/), [reference](https://diataxis.fr/reference/) and [explanation](https://diataxis.fr/explanation/), each for a different reader need.
2. The [Docker Compose Quickstart](https://docs.docker.com/compose/gettingstarted/) has a short intro, "Prerequisites", numbered "Step N" sections that each run a real command, and "Where to go next".
3. Stripe's [Set up your development environment](https://docs.stripe.com/get-started/development-environment) says what you learn, installs, then has a "Confirm setup" check and "See also" links.
4. Atlassian's [how-to article template](https://www.atlassian.com/software/confluence/templates/how-to-article) is a short intro, numbered steps and related articles.

`node apps/wiki/scripts/prose-lint.mjs <page>` reads `doc_kind` and runs these rules, and the page API runs the same ones on every write.

| Rule             | Kinds                 | What it refuses                                                                  |
| ---------------- | --------------------- | -------------------------------------------------------------------------------- |
| `doc-paragraph`  | every page            | a paragraph or step over 4 sentences or 100 words                                |
| `doc-intro`      | the five prose kinds  | a `<wiki-tldr>`, or anything but a `<p>` right under the `<h1>`                  |
| `doc-sections`   | start, tutorial, how-to | a missing section from the table, or a "Check it worked" with no code or image |
| `doc-step-proof` | tutorial, how-to      | a step `<li>` with no `<pre>` block, diagram or image inside it                  |
| `doc-diagram`    | explanation           | a page over 300 words with fewer than one diagram or image per 800 words         |
| `design-length`  | design                | a page over 800 words (c83, c201)                                                |
| `doc-kind`       | any                   | a `doc_kind` value outside the six kinds                                         |
| `core-length`    | all but start, tutorial, how-to | a warning on an `apps/` or `domains/` page past 800 words outside link-only lines, and a 422 on the write that first takes it past (c243) |
| `core-layers`    | all but start         | a warning on an `apps/` or `domains/` page with no diagram, steps, table, field list or code (c243) |
| `diagram-shape`  | any                   | a warning on an `apps/` or `domains/` flowchart that counts 2 to 4 instances in one node, or has over 12 nodes and no subgraph (c243) |

1. On the five prose kinds, `visuals` does not run, and a reference page also skips `table-share`.
2. Every other rule still runs, such as banned words, em dashes, label openers, bullet sentences, sentence length, bold, `english-only` and the UTC date rules.
3. An explanation needs one diagram per 800 words, half the rate of one per 400 that `visuals` asks of a page with no `doc_kind`.
4. A tutorial step needs its own code block or image, because the owner follows a tutorial step by step and checks each result against the page.
5. On a `design` page, `visuals` asks for one diagram whatever the page's length, because c83 allows one and `design-length` caps the size.

## How a page reads

The reader is the owner, who reads as a busy manager.
He should scan the page once, top to bottom, and come away with the answer and the reasons for it.

1. The page opens with the `<h1>` and an intro paragraph of two or three sentences that gives the answer: what the thing is, where it runs and what the page holds.
2. The body is prose paragraphs of two to four sentences and at most 100 words each, under sentence-case headings that name what each section holds.
3. A numbered list holds only steps a reader does or a system runs in order, such as a call stack or a deploy, and each step may hold two or three sentences.
4. Never write a page or a section as a string of numbered one-sentence lines, because the owner called that form unreadable on 2026-11-24 (c235, c243).
5. Fields, keys, ports and other facts a reader looks up go in a table, with a sentence before it that says what the table lists.
6. A design or plan page for the owner is about 1/10 the length of a full spec and answers his questions in the order he asked them, each in a short plain sentence with one concrete example, before any options, tables or numbers.
7. On 2026-10-29 the owner could not follow the long spec at `sessions/2026/10/30/0215-wiki-in-sw-factory-design/design.html`, asked his seven questions again, and asked for a 1/10 plan in 메르 style (c201). Since c235 and c243 that style means short plain sentences that answer his questions in order, written as prose paragraphs, never as numbered lines.
8. Set `doc_kind` on every new page, so the page API leaves each list's `start=` as written. On a page with no `doc_kind` the API still numbers top-level lists on across sections and moves an in-page "item N" with its line (`apps/wiki/scripts/ol-numbering.mjs`), which keeps older numbered-line pages whole, and a write whose "item N" names a number two lines share is refused with a 422.
9. Numbers, file paths and dates sit inside the line as evidence, with identifiers in `<code>`, and every date and time is UTC, which for a commit is its own day from `git log -1 --format=%cI <sha>`, never the owner's KST day. On 2026-10-27 four curated pages, such as `domains/architecture/ci-deploy.html`, dated `3abfc49767`, committed at 20:11Z on 10-27, as 2026-10-28 or "04:26Z on 10-28", and the prose lint rule `future-utc-time` now refuses a Z time or a "since" day later than the write. On 2026-10-28 a job wrote `"updated": "2026-10-29"` and "removed on 2026-10-29" into `apps/crawler-v3/platforms/linkedin/fields.html` at 15:30Z, so `future-utc-time` also refuses a day after a past-tense verb, such as "removed on" or "landed on", and `future-meta-date` refuses a header `date`, `updated` or `last_verified` later than the write, while a plan day such as "expires on 2026-11-30" passes.
10. A line about a commit that has not reached staging or prod goes stale at the next land, so state what dev/sieun runs and name the dev sha instead, because on the 2026-11-09 05:02 dream run writers added 3 such lines that land 5e967cb262 made false minutes later. A dated line such as "At 14:38Z on 2026-11-08 `9cf9e582c6` had not landed" goes stale the same way, because wiki-health flags it from the land that carries the commit, as it flagged retrieval-profile-pass.html on 2026-11-17. So once a commit has landed, name the land that carried it, as in "staging land bff022d7b6 carried `4a9b3a985c` at 23:49Z on 2026-11-16", and write no "neither ... nor ... had landed", "when no staging land carried", "until a promote carries" or "still needs a promote" clause. Find that land in auto-sns-agent with `git merge-base --is-ancestor <sha> <dev sha a land names>`, and for prod with `git merge-base --is-ancestor <land> origin/main`. `git merge-base --is-ancestor <sha> origin/staging` fails even after a land, because a land is a one-parent commit titled `land: dev/sieun <tip>`, and on 2026-11-16 at 08:01Z a session wrote that `d60109b34` had not landed on `domains/architecture/telemetry-map.html`, though land c2cb3f9c81 had carried it since 06:18Z. The page API refuses (422) a write that adds such a line about a commit a staging land already carries, or for prod, whose land `origin/main` holds, and its answer names the first land that carried the commit, so rewrite the line with that land. Every other such line a write adds gets a warning in the answer's `warnings` that names the dev-sha phrasing, as in "on dev/sieun since `8c1f60df87`", and the write saves, because in the 2026-11-17 wiki dream runs at 00:19Z and 01:06Z the same 5 pages, such as `census-scheduling.html`, were rewritten again only because the land after each write had made such a line false. A value only a dev branch runs, as in a table cell "4, or up to 84 on dev/sieun", names its sha in the same cell, because on 2026-11-08 such a cell outlived the land of `42d3206e43` by 9 days. wiki-health (`apps/wiki/scripts/wiki-health.mjs` `landedClaims`) flags a line a later land makes false, from the first land whose dev tip holds the sha, and a prod line once `main` holds that land, as a `landed:` ref in the stale list, and the wiki dream rewrites it. A line in the dev-sha phrasing, as in "On dev/sieun since `6f8c28973d`, ...", stays true after every land, so leave it as written and do not rewrite it to name the land, because on 2026-11-18 writers spent up to 82 line rewrites on 30 pages doing that, and the dream reports counted them as false lines.
11. Every number a reader may question shows its source on hover in a `<wiki-cite src="..." note="...">`, and a number nobody measured is written as unknown or a range in a cite with only a `note` that states the assumption, as the hover section of `page-authoring.md` shows.
12. On 2026-10-29 a plan page stated "$5,714 of StepFun list-price API usage" with no source behind it, and nobody could say where the number came from when the owner asked (c202).
13. Sections are short, a few paragraphs with one diagram or table each, under a sentence-case heading that names what they hold.
14. Agent-only detail, such as raw counts and file lists, goes on the session page, and a session page may keep it in a collapsed `<details>` block at the end.

## Diagrams drawn for a person

The owner's words, #dev-crawler p23 on 2026-11-24: "그냥 relation을 diagram에 모델링하는데 그치지 말고 인간이 이해학 쉽게, e.g. proper placing & hierarchy, shapes, things that are multiple -> 여러개".

1. Every flow, pipeline, state change or structure the page describes gets a mermaid diagram next to the paragraph that explains it, and every screen it talks about gets a screenshot in the page's `assets/` folder.
2. Every before and after, or option against option, gets a diagram, a small table or two screenshots.
3. A page with no `doc_kind` carries one diagram or image per 400 words once it passes 300 words, an explanation one per 800 words, and a design page one (c83). A table never counts toward that.
4. Lay a diagram out for a person, beyond a graph of relations: the entry at the top or left, the main path in one straight line, and each part inside the box of the thing that holds it.
5. Show hierarchy with a `subgraph` for each host, container or owner that holds the parts, and nest them when one holds another.
6. Pick the direction for the reading order: `flowchart LR` for a pipeline read left to right, and `flowchart TD` for a hierarchy or a call stack read top down. A `direction` line inside a subgraph turns one row, though mermaid ignores it once that subgraph's nodes link outside it.
7. Shapes tell kinds apart, and one kind keeps one shape across the page, as the table below lists.
8. A thing that exists several times is drawn several times, so three tiers are three boxes side by side, each with its own copy inside. A count inside one label, such as "relay x2" or "3 tiers", is the defect, and the lint warns with `diagram-shape` for a count of 2 to 4.
9. Past four of the same thing, draw one stacked node with the count, such as `w@{ shape: procs, label: "24 workers" }`.
10. Labels are one to three words and use the real name, such as `chat.sqlite` or `relay :7791`, and the paragraph under the diagram carries the detail.
11. Keep a diagram to about 8 to 12 nodes, and split a larger one into two, such as one for the hosts and one for a request's path. The lint warns with `diagram-shape` on a flowchart over 12 nodes with no subgraph.
12. A diagram makes one point, which the sentence before it states, and a diagram that needs a legend gets redrawn.
13. On 2026-11-23 the tier diagram on `domains/devops/clickhouse-layout.html` drew one box "same on every tier" where local, staging and prod each hold the `crawler` database, and 6 of its 8 diagrams were left-to-right chains of names (c243).

| Kind | Mermaid shape |
| --- | --- |
| a service, job or process | rounded box `("chat server :5184")` |
| a database, table or store | cylinder `[("chat.sqlite")]` |
| a queue | horizontal cylinder `q@{ shape: h-cyl, label: "outbox" }` |
| a person | stadium `(["owner"])` |
| a decision or check | diamond `{"prose lint"}` |
| many of one thing | stack `w@{ shape: procs, label: "24 workers" }` |

### Worked example: hosts as boxes, one node per instance

The chat server runs on us-metal02 only, and each box with agents runs its own relay and pi-host (`apps/chat/docs/agent-model.md`, "The three tiers").
Each host is a subgraph, the two relays are two nodes, and the reading goes top down from the owner.

```html
<pre class="mermaid">
flowchart TD
  owner(["owner"]) --> chat
  subgraph m02["us-metal02"]
    chat("chat server :5184") --> db[("chat.sqlite")]
    chat --> r1("relay :7791") --> p1("pi-host")
  end
  subgraph mac["Mac"]
    r2("relay :7791") --> p2("pi-host")
  end
  chat --> r2
</pre>
```

### Worked example: a pipeline read left to right

A page write goes through the page API on :5176, which runs the prose lint and answers 422 when the write adds errors, and the backup timer later commits what the engine wrote.
The pipeline reads left to right, the check is a diamond and both stores are cylinders.

```html
<pre class="mermaid">
flowchart LR
  job("writer job") --> api("page API :5176")
  api --> lint{"prose lint"}
  lint -- new errors --> refuse("422 answer")
  lint -- passes --> files[("content folder")]
  files --> timer("backup timer") --> git[("git")]
</pre>
```

### Worked example: repeated threads and a stack of jobs

An agent has one comm thread per room and one work thread, and the work thread starts jobs.
The three comm threads are three boxes, because there are three rooms, while the jobs, whose number changes, are one stacked node.

```html
<pre class="mermaid">
flowchart TD
  subgraph rooms["rooms"]
    direction LR
    r1["#sw-factory-build"]
    r2["#dev-crawler"]
    r3["DM"]
  end
  subgraph agent["agent factory on pi-host"]
    c1("comm thread")
    c2("comm thread")
    c3("comm thread")
    w("work thread")
    jobs@{ shape: procs, label: "jobs" }
  end
  r1 --> c1
  r2 --> c2
  r3 --> c3
  c1 & c2 & c3 --> w
  w --> jobs
</pre>
```

## Paragraphs, not strings of numbered lines

On 2026-10-09 the owner asked for numbered lines in 메르 style (c20), and on 2026-10-10 he rejected a prose rewrite of the gateway page. On 2026-11-24 he called the numbered lines unreadable (c235, c243), so the same facts now read as a short paragraph.

This form is out:

```html
<ol start="12">
	<li>The gateway forwards a request as it came and never translates it.</li>
	<li>The gateway retries only calls with an idempotency key and 429 answers that say when to try again.</li>
	<li>The caller sets a deadline, 10 seconds by default, and the gateway never waits past it.</li>
</ol>
```

This form is in:

```html
<p>
	The gateway forwards requests and never translates them. It retries only calls that are safe to repeat, which are
	calls with an idempotency key and 429 answers that say when to try again. The caller sets a deadline, 10 seconds by
	default, and the gateway never waits past it.
</p>
```

A line with a bold label and stuffed clauses is still out, as it was on 2026-10-09:

```html
<li>
	<strong>Layer 1, LLM proxy.</strong> As in the 1918 page. It maps a call type to a model, tries CLIProxyAPI first,
	uses a paid fallback only where a row allows it, and never retries. It is stateless and never touches the database.
</li>
```

## Plan, spec and status pages

A plan shows that the writer cared about the problem, as the owner asked on 2026-09-10: "make sure future prime-agents report a plan in a format/style and insight just like [this page], not just superficially, but care about the problem!"
These lines held the spec-report skill's rules until 2026-11-17, when that skill went unread for 14 days and moved here.

1. A plan, spec, design or status page starts from the user's job and the real artifact, says why today's flow fails, and makes one concrete recommendation.
2. Trace the whole task a person does, such as create, edit, preview, publish and use, past the symptom someone reported.
3. Inspect the real workflow, source, data and lifecycle through their own interfaces, and drive web pages with the `aside-browser` skill.
4. Keep the owner's own words, what others said and your own proposals apart, and quote the owner as he wrote.
5. Each claim says whether it is observed behavior, a source risk, a proposal or a verified change, and the page names the evidence you could not get.
6. A line about today states what you checked this turn in the tree, a query or a screenshot, never what a worker said.
7. Correctness and trust come before cosmetic work when the evidence supports that order.
8. Steps go in order of dependency and risk, each one ends in a check a reader can run, and work already in flight says so.
9. A real product choice names the concrete alternatives, why each one lost, and the default you recommend.
10. You check an observable fact yourself instead of asking the owner.
11. A rendered spec or mock proves the design, never the implementation.
12. A status page names the final state, what is true today with its check, and the next steps in order.
13. The page is ready when a reader can say what the user wants to finish, why today's flow fails, which facts changed the plan and how each step gets proven.
14. A design page for the owner's decision sets `"doc_kind": "design"`, and the lint rule `design-length` refuses one over 800 words.

## Tables and bold

1. A table holds numbers and short facts in cells of a few words.
2. A cell that needs a full sentence belongs in the paragraph under the table instead.
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

1. The lint reads an `<ol>` item as a step, which `doc-paragraph` holds to 4 sentences and 100 words like any paragraph, and no rule asks for numbered lines.
2. `label-opener` refuses `label: value` lines and bold openers.
3. `visuals` refuses a page with no `doc_kind`, or a design page, that has too few diagrams or images for its words.
4. A page with a prose `doc_kind` gets the rules of the section "Documentation pages" in place of `visuals`, and `core-length`, `core-layers` and `diagram-shape` warn on `apps/` and `domains/` pages only.
5. `session-link` refuses a link from a curated page to a file in a session folder other than the session log `index.html`.
6. `job-folder-link` warns on the same kind of link into a pi-host job folder `agents/<slug>/jobs/YYYY/MM/DD/<job>/`, and the finding names the job log `index.html` to link instead.
7. When a page needs the fact from such a file, move the fact into the line itself or into the curated page that owns it, and link the log.
8. `english-only` refuses each Korean sentence outside a quote of the owner (`"..."`, `<q>`, `<blockquote>`) or code, per owner rules c2 and c102, and Korean kept on purpose passes under `lang="ko"` or a `ko/` folder.
9. The rule exists because the bloat, soft-caps and multi-box design pages of 2026-10-18 were written in Korean.
10. `apps/wiki/tests/fixtures/prose-lint/good-tutorial.html` is the passing prose example, and `domains/devops/clickhouse-layout.html` as rewritten on 2026-11-23 is a short curated page.
11. The page write API (`POST` and `PATCH /api/agent/page`) answers 422 when a write adds lint errors.
12. The lint warns on size only through `core-length`, and the write API accepts a page over the 64 KiB `PAGE_READ_LIMIT` in `apps/wiki/src/lib/server/wiki.ts`, but the reader then shows a "truncated preview" cut mid-page and `GET /api/agent/page` answers 413.
13. On 2026-10-19 a lint rewrite of `experiments/2026-08-16-email-finder-round2` grew about 30% and passed 64 KiB, so keep a rewrite under about 62 KB by moving detail to the session page and stripping indentation inside mermaid blocks.
14. The engine runs the same lint on every write, and no page reaches git except through the backup timer, which commits what the engine wrote.
15. An edit to an old page passes when it adds no new errors, so legacy pages stay editable.
16. The lint skips `requests.html` and session log `index.html` files, because they hold verbatim text, and it skips `archive/` and `@code/`.
17. Write pages through the page API so the write check runs, and never write page files directly.
18. On 2026-10-28 parallel dream writers kept their page write bodies in the machine's shared temp folder, so a writer that ran `curl --data @r7-patch.json` there sent another job's body under the same name and applied that edit to `apps/search/onboarding-orgs.html` instead of its own page.
19. Write a page write body to `$SESSION/<uuid>-patch.json` in your workspace folder, or pass the JSON on stdin with `--data @-`, and check that the `path` field of the response names your page.
