# The page publish gate

A curated page is not done until it passes this gate.
§8 of the system spec defines what the engine enforces, and this file is the procedure you run against `https://us-metal02-dev.tail0c093d.ts.net:5184/wiki`.

```
0 · LOCATE → 1 · DRAFT → 2 · VERIFY (5 layers, loop until green) → publish → 3 · WRAP
```

## 0 · Locate

1. Search first with `/api/agent/search?q=`, `/grep?pattern=` for an exact phrase, or `/find?glob=` by path, and edit the page you find instead of creating a duplicate.
2. Tell the canonical page from a stale duplicate by the `updated`, `views` and `edits` in the result rows.
3. Place the page by topic under the owning `apps/<app>/` or `projects/<project>/` tree, with `kind:` in frontmatter (`spec`, `architecture`, `design`, `plan`, `eval`, `guide` or `decision`).
4. Read the raw code or data the page describes, so every claim traces to a `source_ref` such as a code path, log or experiment.

## 1 · Draft

1. Draft in your workspace folder with `wiki.write("<name>.html", html)`, and publish to `<hub>/<slug>/index.html` only at the end of the gate.
2. A writer subagent writes the page per `writing.md` and the format section of `page-authoring.md`, with links to owning pages, experiments and assets.
3. Keep assets in the page's `assets/` and CSV in its `data/`.

## 2 · Verify, the five layers

| #   | Layer                     | How to check                                                                                                                          | Pass condition                                                                                                                                                             |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Schema                    | Read the file head; check meta JSON parses, one `<h1>`, `date`/`updated` present and current, correct space                           | All true; page linked from its hub                                                                                                                                         |
| L2  | Links                     | `curl -s '…/api/agent/lint' \| jq '{broken,orphans}'` filtered to your path                                                           | 0 broken links involving the page; page has ≥1 inbound link (not an orphan)                                                                                                |
| L3  | Render                    | `curl -s '…/api/agent/page?path=<path>' \| jq '{title,toc:(.toc\|length),htmlLen:(.html\|length)}'`                                   | HTTP 200; title correct; TOC non-empty; html contains your tables/figures (components expanded, nothing load-bearing stripped)                                             |
| L4  | Content quality + writing | Read the rendered page end-to-end at `/wiki/<path>` against `writing.md`, then run `node apps/wiki/scripts/prose-lint.mjs <file>` | Every claim traceable to raw source or a cited log; real numbers; no hallucination; the page is numbered one-sentence lines with diagrams; the prose lint reports 0 errors |
| L5  | Freshness / graduation    | Review adjacent state                                                                                                                 | Affected app/domain pages updated; session log closed; `updated` dates bumped; graduation check done                                                                       |

`POST /api/agent/verify` (body `{path}`, or `GET ?path=`) runs L1 to L3 in one call and returns pass or fail per check.
Its L1 also needs `kind` in the meta.

## 3 · Wrap

1. Link the page from its owning hub `index.html`, and cross-link related pages both ways so none is an orphan.
2. Run the tree sweep from the rules in `SKILL.md`, so the topic has one obvious page.
3. Bump `updated` on every touched page, close your workspace with `wiki.close(...)`, and re-run lint until it is clean.
4. Graduate what you learned: a quirk seen in 2 or more logs becomes a `.claude/rules/` rule, deep knowledge becomes a skill or an `apps/` or `domains/` page, and policy goes to `CLAUDE.md`.

## Gate semantics

1. L1 to L3 are mandatory machine checks, so no page publishes with a broken link, a parse error, a missing H1, or a render that drops content.
2. L4 and L5 are a review pass, careful for a spec, architecture page or project hub, and a self-review for a session log or small fix.
3. If the user asked for a peer review of the work, put the page in that same peer conversation, not a separate one per page.
4. A page that fails any layer goes back to Draft.

## Verification commands

```bash
WIKI=https://us-metal02-dev.tail0c093d.ts.net:5184/wiki
P=apps/llm-wiki/index.html   # the engine spec page; a folder path resolves to its index.html

# L1-L3 in one call
curl -s -X POST "$WIKI/api/agent/verify" -H 'content-type: application/json' -d "{\"path\":\"$P\"}" | jq .

# L3: page renders, components expanded, TOC built
curl -s "$WIKI/api/agent/page?path=$P" | jq '{title, kind, toc: (.toc|length), htmlLen: (.html|length)}'

# whole-wiki health must stay clean
curl -s "$WIKI/api/agent/health" | jq .
```

If the wiki does not answer, check `systemctl --user status sieun-pi-wiki.service` on us-metal02 (`ssh sieun@100.83.139.73`).
If the engine's `/wiki/api/agent/health` on its loopback port (`systemctl --user cat sieun-pi-wiki.service`) answers and `:5184/wiki/...` does not, check `sieun-pi-apps-chat.service`, which fronts the engine.
The Local dev servers duty probes the `wiki` url in `~/.config/sieun-pi/hosts.json`, so read that file first when the duty and the public URL disagree. On 2026-10-18 at 03:09Z a local edit pointed it at a localhost port, a stray Mac vite, and the duty missed the public outage.
Check the page in the running server, because a page write needs no build.
