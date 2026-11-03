---
name: wiki
description: Use at session start, for every artifact you write, and to record or look up project knowledge. The pre-imported `wiki` module opens your job's workspace folder and reads and writes wiki pages through :5184, plus the rules for session folders and curated pages.
---

# Wiki

The wiki is our work written down as notes that must be true today.
Query it before you re-derive a fact from code, and write what you learn back to it.

One wiki serves every box at `https://us-metal02-dev.tail0c093d.ts.net:5184/wiki/<path>`.
The engine is sieun-pi `apps/wiki`, the `sieun-pi-wiki.service` unit on us-metal02, which listens on loopback only, and the apps/chat server on :5184 fronts it.
The pages live on us-metal02 under one content root, `~/.pi/wiki/content`, named by `contentRoot` in `~/.config/sieun-pi/wiki.json`, and an agent's space `agents/<slug>/` is its folder `~/.pi/agent/agents/<slug>/`.
Agents on every box, the Mac too, read and write pages only through the API, because a file written straight into a folder skips the gates, the index and the backup.

## The kernel module

Call the pre-imported `wiki` module in the Python REPL.
In a pi-host thread it reads your conversation from `RLM_SESSION_DIR` (`<thread>-<n>`) and sends it as `x-pi-conversation`, so the server stamps your agent, conversation, parent and host on the log and on every write.
A Prime session has no pi-host conversation, so it passes `author=` once or sets `WIKI_AUTHOR`.

```python
ws = wiki.workspace("what this job does")    # opens the folder on the first call; later calls return it
wiki.write("plan.html", html)                # a page in the workspace; a full path such as apps/x/index.html also works
wiki.write("notes.html", md, markdown=True)  # markdown in, stored as HTML (pi-host threads)
wiki.edit("plan.html", [(old, new)])         # exact-string edits
wiki.put("data/run.log", "/path/run.log")    # any file that is not a page
wiki.log("ran the bench, 3 of 4 green")      # an event on the workspace log
wiki.read("apps/search/index.html")          # markdown made from the stored HTML; html=True gives the HTML
wiki.search("crawler frontier", agent="vent")
wiki.publish("apps/search/index.html", html) # a curated page plus the verify gate; close() lists it in graduated_to
wiki.supersede(old_path, new_path)
wiki.close("what changed", no_durable_knowledge=True)  # or graduated_to=[...] or gaps_created=[...]
```

1. A pi-host job's folder is `agents/<slug>/jobs/YYYY/MM/DD/hhmm-<job>/` (KST day), and an agent's work thread gets its standing notebook `agents/<slug>/work/`, which never closes.
2. A Prime session's folder is `sessions/YYYY/MM/DD/hhmm-<slug>/`, and its first `wiki.workspace(goal, author=...)` call names the goal.
3. A refused write raises `wiki.WikiError` with the server's status and its reason, such as 422 for a prose-lint error or a duplicate page, 409 for a stale `base_version` and 403 for a closed folder.
4. The module keeps the open folder in `wiki-workspace.json` under `RLM_SESSION_DIR`, so a resumed kernel finds it again.
5. A link for the owner is the `url` each call returns, such as `https://us-metal02-dev.tail0c093d.ts.net:5184/wiki/agents/vent/jobs/2026/11/03/1250-x/plan.html`, never a disk path.

## HTTP for scripts and other tools

1. `GET /wiki/<path>` on :5184 renders the page, and `?format=md` or `Accept: text/markdown` returns markdown made with Turndown from the stored HTML.
2. `PUT /wiki/<path>` creates or replaces a page from an HTML body, a markdown body (`?format=md`) or JSON `{content}`, `POST` creates only, and `PATCH` takes JSON `{edits: [{old_string, new_string}]}`.
3. A write names its conversation in the `x-pi-conversation` header, and a write without one is stamped `unknown`.
4. `POST /api/c/<conversation>/workspace` opens the folder, `.../workspace/events` appends a log event and `.../workspace/close` closes it.
5. Every other `/wiki/*` path passes through to the engine, so the engine's agent API answers at `/wiki/api/agent/*`, such as `/wiki/api/agent/search?q=` and `/wiki/api/agent/sessions`.
6. Old links and calls on the engine's old tailnet port (`/page/<path>`, `/raw/<path>`, `/api/agent/*`) still answer, because the engine puts `/wiki` in front of a path that lacks it, but every new link and call uses `:5184/wiki/`.

## The page format

Every page, curated or workspace, is in the 메르 style: numbered short lines in `<ol>`, one plain sentence each, with a mermaid diagram or image for every flow, structure or comparison.
A subagent writes every page, one page per subagent, and the parent reviews it.
Before you write a page, read `references/writing.md` and the format section of `references/page-authoring.md`.
The page API refuses a write that adds errors from `node apps/wiki/scripts/prose-lint.mjs <page>`, run from the sieun-pi checkout.

## The rules

This list is the single source for these rules.

1. At the start of every substantive session, open your workspace with `wiki.workspace()`.
2. Put drafts, plans, analysis, reviews, scripts, data dumps and screenshots in that folder with `wiki.write` and `wiki.put`, never in `/tmp`, which other agents cannot see and a reboot deletes.
3. Never write a work-in-progress page in `apps/`, `domains/`, `projects/` or `experiments/` mid-thread.
4. Append every user request, verbatim, to `requests.html` in your folder as it arrives.
5. Present a plan, review, findings or comparison as a page in your folder (`plan.html`, `findings.html`) and link its URL, so the chat message stays a summary.
6. When you find a stale page or learn something new, fix the page now, and when substantial work lands, put its facts on the owning app or domain page.
7. Edit the existing page instead of adding a second one, and place it by topic, with its type in the `kind:` frontmatter.
8. End every wiki update with a tree sweep: search the topic, merge or retire each overlapping page (`status: superseded`, or `archive/` with `archived_reason`), and prune the hub to one page per topic.
   Repoint or drop every hub link to a page before you give it a retired status, and change its meta title and first `<h1>` together, because the page API refuses either half-done write.
9. Two pages that answer one question are a defect to fix before you close the folder.
10. Write a curated page (`apps/`, `domains/`, `projects/`, `experiments/`) with `wiki.publish` at wrap-up or once the knowledge is settled, through the gate in `references/verification-algorithm.md`.
11. Query through the API instead of raw file reads, cite the pages you used, and write the page for any question the wiki could not answer.
12. Write pages as HTML (`<!--wiki {json}-->`, one `<h1>`, `<wiki-tldr>`) per `references/page-authoring.md`, and always set `description`.
13. Never edit `@code/` (the read-only repo mirror), another agent's folder or a closed log.
14. Every wiki path starts at the content root, such as `sessions/...`, `agents/...` or `apps/...`, and the API answers 400 to a path that starts with a disk prefix such as `content/` or the old repo folder.
15. Mask a raw `ps` capture or any command output before you save it, because app command lines carry keys, and the page API refuses a page that betterleaks flags.
16. Close with `wiki.close(outcome, ...)`, which needs `graduated_to`, `gaps_created` or `no_durable_knowledge`, and a closed folder answers 403 to every write except `supersede`.
17. A curated page links a workspace log (`index.html`) or a page it graduated, never another file in a folder, and the prose lint rule `session-link` refuses such a link.

## Query

| Verb      | Call |
| --------- | ---- |
| search    | `wiki.search(q, agent=None, sessions=False, app=, kind=, status=)`, or `GET /wiki/api/agent/search?q=` |
| read      | `wiki.read(path, section=, lines=)` |
| grep      | `GET /wiki/api/agent/grep?pattern=<regex>&context=2` |
| find      | `GET /wiki/api/agent/find?glob=<path-glob>&kind=` |
| tree      | `GET /wiki/api/agent/tree?path=<folder>&depth=2` |
| bundle    | `GET /wiki/api/agent/context-pack?q=<terms>&budget=8000` |
| freshness | `GET /wiki/api/agent/stale`, `/changes?since=`, `/history?path=`, `/diff?path=` |

1. A page read through `/wiki/api/agent/page?path=` returns `backlinks`, so follow them.
2. Every page read adds one view to the page, so note a page's `views` before you probe it when views feed a ranking.
3. Discovery skips workspace logs and `archive/` unless you pass `includeSessions=true` or `includeArchive=true`.
4. Every result row carries `description`, `created`, `updated`, `views`, `edits`, `kind` and `status`, so triage from the row before you open the page.

## Reference map

1. `apps/llm-wiki/index.html` on the wiki is the system spec for the engine, page model, API and gate.
2. `references/writing.md` says how a page reads, who writes it, and what the prose lint enforces.
3. `references/page-authoring.md` holds the format, the HTML template, title rules, `<wiki-*>` components, diagrams and images.
4. `references/verification-algorithm.md` is the 5-layer publish gate.
5. `references/wiki-dream.md` is the runbook of the daily Wiki dream duty job (d4).
6. The engine's code, tests and release script are in sieun-pi `apps/wiki` and `scripts/release-wiki.mjs`, and its tests run with `node tests/run.mjs` from `apps/wiki`.
7. The product specs behind the `/specs` page stay in auto-sns-agent, at the folder `specsDir` names in `~/.config/sieun-pi/wiki.json`, and that repo's `workflows/specs` skill covers them.

## Validation

1. The prose lint reports 0 errors on every page you wrote.
2. `wiki.publish` returned `verify.pass` true for every curated page you wrote.
3. Your folder is closed with `graduated_to`, `gaps_created` or `no_durable_knowledge`.
