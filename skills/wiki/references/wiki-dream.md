# Wiki dream daily runbook

The duty job "Wiki dream" follows this file once a day at 01:30 KST.
It keeps the wiki in sync with the repo and with itself, and it turns agent mistakes that repeat into skill rules.
It copies Claude Code's auto-dream loop (orient, gather signal narrowly, consolidate, prune and rebuild the index) and adds one step, mistakes to skills.
The design and evidence are in `sessions/2026/10/10/1433-llm-wiki-dream-duty-design/data/` (`design.md`, `build-contract.md`, `wiki-audit.md`).

The owner asked for it in these words: "a daily job that cleans wiki, find anti-patterns agent mistakes alot, then fixes related skills so that doesn't happen again. the main wiki all articles and whcih articles exist itself should always be up to date".

## Inputs and where they live

| Input                              | Where                                                                                                                        | Who writes it                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Precheck metrics and flagged items | your job brief                                                                                                               | the `wiki-dream.ts` duty adapter in sieun-pi `components/user-history`           |
| Wiki findings in full              | `node apps/wiki/scripts/wiki-health.mjs --since <iso>` from the sieun-pi checkout                                          | the wiki engine (`/api/agent/lint`, `/api/agent/stale`, `prose-lint.mjs --json`) |
| Ledger                             | `~/.prime/agent/browser-chat/duties/01a1164b-4a2d-742d-b27a-82f086ed0200/wiki-dream-ledger.json`                             | this job, last step of the run                                                   |
| Run records                        | `~/.prime/agent/browser-chat/duties/01a1164b-4a2d-742d-b27a-82f086ed0200.runs.jsonl`                                         | the duty runner                                                                  |
| Owner corrections                  | `~/.prime/agent/browser-chat/corrections.json`                                                                               | the chat server                                                                  |
| Harness memories                   | `~/.prime/agent/harness/harness_state.json`, or `rlm.get_harness_state()`                                                    | every Prime session                                                              |
| Skill reads per skill              | `GET https://us-metal02-dev.tail0c093d.ts.net:5184/wiki/api/agent/skill-metrics?days=7` (`reads`, `reader_sessions`, `last_read`) | `read-skill.mjs` telemetry                                                       |

1. `wiki-health.mjs` exits 2 when the wiki does not answer, and the precheck then sets `source_errors` and puts 999999 on the metrics that input feeds.
2. A wiki that is down is the ops guy's to fix (owner correction c36), so report it and stop, and never start or restart the wiki server from this job.
3. Never read a session folder's `data/` dumps or whole transcripts, and open only the page, log or memory the precheck names.
4. Search the repo with `rg` and a narrow path, never over the content root `~/.pi/wiki/content` as a whole, which is 97 GiB and mostly session data.

## Phase 1 · orient, then the quiet-day gate

1. Read the brief's metrics and flagged items, the ledger, and the last two lines of this duty's runs file.
2. Open one workspace for the run with `wiki.workspace("wiki dream run", slug="wiki-dream")`, and log each change to it with `wiki.log` as you go.
3. Run `node apps/wiki/scripts/wiki-health.mjs --since <last run iso>` once from the sieun-pi checkout and save its JSON in the workspace's `data/` with `wiki.put`.
4. End the run at once, with no message and no board op, when every metric is met, no `stale_vs_code` page is flagged, fewer than 5 session logs are new since the last run, and the precheck shows no new correction, repo-fact memory or log signal.
5. On that quiet day, append the run to the ledger with the summary `nothing changed`.
6. When fewer than 5 session logs are new and no correction is new, run phases 2 to 4 only and skip phase 5, which is the dream's "24 h and 5 sessions" gate.
7. Do not reopen a settled item for 30 days unless its page or skill file changed after the ledger date, where settled means a page in `verified` or a class with status `fixed`.
8. A pair verdict has no expiry, and the precheck counts the pair again only when its score rises above the `score` its ledger row records.

## Fan-out

1. The job plans, spawns, reads results and commits, and it never edits a page or skill in its own context.
2. Each output item gets its own subagent: one hub, one duplicate pair, one stale page, one page on the writing glide, one mistake class, or one skill file of memory moves.
3. Every flagged item gets its subagent in the same run, all started at once, with no daily cap. The 2026-10-15 01:30 run fixed 50 missing dates (missing_meta 51 to 1) and judged 30 pairs in one go, and none of its commits was reverted.
4. Each page writer brief carries the standard line from `writing.md`, the target path, the flagged item, and the sources to read.
5. Each writer first reads the page's `last_verified` on the wiki and stops with no write when it is later than every flagged ref's change, because a code session often verifies its pages minutes after the precheck. On 2026-10-31 the job started at 14:44Z on a 12:12Z precheck, session `01a191dd` had verified all six flagged `promote.yml` pages in 8b762731d4 at 12:17Z, and four writers bumped `last_verified` again until the job wrote HEAD's bytes back.
6. The writer makes `node apps/wiki/scripts/prose-lint.mjs <page>` pass with 0 errors and writes through the page API (`POST /api/agent/page` with `{path, content}`, or `PATCH` with `{path, edits}`), which answers 422 on a write that adds lint errors.
7. The job reads every rendered page against `writing.md` and runs the lint again before it ends the run.
8. A subagent runs at the depth limit and cannot spawn, so the job itself runs any trigger probe and any writer for a second page.
9. Each page writer writes a result file before it ends, and the job checks that file for every writer it started, because on 2026-10-22 14 writers started at 04:00Z exited on failed model requests with no page write and no report, and their 14 pages counted in `wiki_problems` two hours later.
10. The job starts a new writer for each page with no result file and checks the page against the stale list again, and it ends the run only when every flagged page has a result or a second writer.

## Phase 2 · index and links, every run, first

1. Fix each flagged `dead_link`, `superseded_linked` and `session_link` in the page that holds the link, one subagent per page.
2. Point a link into `sessions/`, other than a session log `index.html`, at the curated page that graduated from that session.
3. When no such page exists, remove the link and move the fact it backed into the line itself or into the owning curated page.
4. Point a link to a superseded page at the page named in its `superseded_by`.
5. Fix a `hub_orphan` under a hub that holds `<wiki-children>` by fixing the page's folder, its `status` or the hub's `exclude` list, never by adding a hand row.
6. Add the missing row to a hub that still has a hand-kept list, until that hub moves to `<wiki-children>`.
7. Fix `missing_meta` by setting `updated`, writing a `description`, or matching the `<h1>` to `title`.
8. Rewrite relative dates such as "yesterday" or "last week" to the absolute date while a page is open anyway.
9. The page API refuses a write whose page title and `<h1>` differ or that retires a page a current hub links (`apps/wiki/scripts/page-gate.mjs` in sieun-pi), so a new title gap or `superseded_linked` item here came from a file written on disk past the API.

## Phase 3 · consolidate duplicates and stale facts

1. Judge every `dupPairs` item the ledger has not settled, one subagent per pair, highest score first.
2. The page API refuses a curated page write that makes a new pair (`heldByWrite` in `apps/wiki/scripts/dup-held.mjs`, judged by `newPairs` in `dup-gate.mjs`), so the writer merges or adds `distinct_from` at write time, and a new pair here came in through a retitle of the other page.
3. The 422 names each look-alike page and the `distinct_from` line to add.
4. A write that only keeps a pair that held the page before it still saves with a `held` note, so a writer can always save the fix, and an `unlanded` item here is such a page whose writer skipped the note.
5. The pair subagent reads both pages and decides `merged` or `distinct`, and a score near 0.35 often means a shared template rather than a shared topic.
6. On a merge, one page survives with every live fact from both.
7. The other page gets `status: superseded` plus `POST /api/agent/supersede {path: old, by: survivor}`, which sets `superseded_by`, or it moves to `archive/` with `archived_reason`.
8. Repoint every curated link to the old page in the same run.
9. Record each verdict, `distinct` included, in `pairs` under the sorted key `a|b` with the pair's `score`, so the pair drops out of `dup_unjudged`.
10. Check every `stale_vs_code` page, one subagent per page.
11. The flagged line gives the time the page was checked and the minute the tip changed each ref, as in `checked 2026-10-20T01:12Z (last_verified 2026-10-20); code changed since: apps/vent/src/vent/tables.py (2026-10-20T02:14Z)`.
12. That subagent reads `git log --first-parent -p --since=<checked> HEAD -- <ref>` for each ref first, then the current code wherever the diff touches a fact the page states.
13. It fixes those facts in place and deletes facts the code now contradicts, and when the diff changes nothing the page states, it changes only `last_verified`, because 16 of 29 such flags read from 2026-10-16 to 2026-10-20 changed nothing on the page.
14. When the page states only some definitions of a cited file, the subagent replaces that ref with one `path::name` entry per definition the page states, as in `apps/crawler-v3/src/control/controls.py::_instagram_census_specs`, so an edit elsewhere in the file no longer flags the page.
15. A name can also be a route key or a Markdown heading, as in `convex/http.ts::/api/search-admin/access` or `ops/runbooks/dev-boxes.md::When an alert fires`, so a page that states some routes of a route table or some sections of a skill file or runbook cites those entries, because in the 7 days to 2026-10-28 10:28Z a Markdown ref was behind 58 rechecks that changed only `last_verified` and was the only ref behind 39 of them, and the writers of 2026-10-28 kept `convex/http.ts` and `.agents/skills/repo/git-workflow/SKILL.md` whole only because a ref could not name such an entry.
16. It keeps the whole-file ref when the page states a fact about the file as a whole, such as a line number, a behavior spread over the file or a count of its entries, because a filter on the definitions each page names in `<code>` caught only 72 of the 105 checks from 2026-10-16 to 2026-10-21 that changed the page, and most of the 33 it missed changed line numbers or file-wide behavior.
17. It sets `last_verified` to the UTC time of its check, as in `2026-10-20T15:02Z`, because a bare day cannot tell a second check on the same day from no check. It stamps the time it last read the code, and before it writes it runs `git log --first-parent --since=<that read time> HEAD -- <ref>` for each cited file and rechecks every commit that landed while it worked, because a later stamp hides that commit from the engine. On 2026-11-02 a writer checked `apps/crawler-v3/adding-a-platform/retrieval.html` against c39f9a0d44 and stamped 05:30Z, so f234d204ad, which changed the cited `apps/crawler-v3/src/catalog/profile_face.py` at 05:22:39Z, never flagged the page while it stated the old head-account rule, until 80117e1dc fixed it.
18. The engine (`apps/wiki/src/lib/server/wiki-stale.ts`) dates both sides on the first-parent history of HEAD: the check by that time, or for a bare day by the end of that day, and each ref by the newest commit that changed it, where a `path::name` ref counts only a commit that changed the code of that definition, read without its comments and docstrings, and only while HEAD's code differs from the code at the check, and HEAD without the definition reads as `(missing)`, and a ref git does not track at HEAD reads as `(missing)` even when a gitignored file sits at its path, so its writer swaps it for a tracked file, because until 2026-10-29 the engine dated such a ref by its mtime, and in the 7 days to 2026-10-29 06:20Z 6 rechecks cited a gitignored file under `apps/virev-demo/src/routes` that each materialize rewrites, 4 of them on `apps/search/enterprise-mock.html` and 5 of the 6 changing only `last_verified`.
19. Since 2026-10-22, a whole-file or folder ref counts only a commit that touches what the page states: a changed line holds a distinctive word of the page's `<code>` spans (one with `_`, `-` or a digit, camelCase, or ALLCAPS), the commit changes the text of a definition the page names in `<code>`, or the page cites line numbers of that file, and a page with no distinctive `<code>` word counts every commit, because on a replay of 2026-10-20 07:51Z to 2026-10-22 07:51Z this kept 104 of the 106 behind spells that ended in a page body change and dropped 56 of the 141 that changed only `last_verified`. Since 2026-10-27, both kinds of ref read the code without its comments and docstrings (`apps/wiki/src/lib/code-text.mjs`: Python `#` comments, docstrings and a lone `pass`, TypeScript, JavaScript and Svelte `//`, block and `<!-- -->` comments, shell `#` comments, and since 2026-10-28 YAML and TOML `#` comments outside quoted strings, TOML multi-line strings and YAML block scalar bodies, and since 2026-10-29 Caddyfile `#` comments that start a token outside quotes and heredocs, whole-line comments of a Dockerfile, a systemd unit and a `.gitignore`, `.env` comments, and the comments of a file with no dot in its name read by its `#!` line, such as `.githooks/pre-push`), so a commit that only changes comments counts for nothing, while a page that cites line numbers of a file still counts every commit, because a comment cut moves those lines. A comment sweep landed 69 such commits on sieun/dev from 2026-10-26 23:20Z to 2026-10-27 00:18Z, and a replay of the report at c842f86a0c read 116 pages as behind code before this rule and 11 after it: 3 pages that cite line numbers, 6 pages whose files changed code, and 2 refs to files git does not track. Since 2026-10-28, a word inside a path in a `<code>` span names no definition, and a turbo task id such as `search#build` or `//#ci:guards` names its `turbo.json` task whole, because the `tasks` of `scripts/ci/tasks/guard-tests.sh` named turbo.json's top-level `"tasks"` block, so 39 of the 40 turbo.json commits from 2026-10-20 22:17Z to 2026-10-27 14:00Z touched `domains/devops/ci-cd-pipeline/checks-and-monitor.html` and all 40 touched `dev-push-checks.html`, against 32 and 27 after the fix. Since 2026-10-28, a path in a `<code>` span counts only when a changed line holds it whole, and a `path::name` ref to a table keyed by route, such as `ROUTE_ACCESS`, follows only the routes the page names in `<code>`, because the `search-admin` of `/api/search-admin/access` touched every `convex/http.ts` line of another search-admin route. A replay of the 1,151 dream rechecks from 2026-10-21 10:28Z to 2026-10-28 10:28Z (`~/work/wiki-dream-repeat-flags/`) found 954 of them behind an engine flag, and the new rules kept all 441 that ended in a page body change and dropped 38 of the 513 that changed only `last_verified`, with 1 new flag from a Markdown heading the page names. On 2026-10-29 f942d53743 added staging routes the page never names to `apps/infra/metal/config/caddy/staging.Caddyfile` with a comment that holds `POST`, a `<code>` word of `domains/architecture/telemetry-map.html`, which flagged that page, and a replay of the 1,668 dream rechecks from 2026-10-22 06:20Z to 2026-10-29 06:20Z (`~/work/wiki-stale-miscounts-1029/`) found 1,396 behind a flag, and the Caddyfile and `.gitignore` comment rule dropped 5 of them: 4 that changed only `last_verified` and 1 page fix, `7585a6bc99`, which added the `read_body_idle` setting the page had never named and was flagged only by the word `vent-staging` in the comment above it.
20. Since 2026-10-29, a `path::name` ref to any table keyed by quoted strings follows only the rows whose key the page names whole in `<code>`, as `meta_ads.advertiser_walks_per_minute` does for `apps/crawler-v3/src/settings.py::_PROD_CONTROL_DEFAULTS`, and a page that names no key still follows the whole table (`entryKeys` in `wiki-stale.ts`). This holds because 29355fa1b8 changed one row of that table, all 5 pages citing it were flagged, and 4 of their rechecks changed only `last_verified`.
21. Until 2026-10-20 it read a bare day as its end, which hid every change landed later on the check's own day and brought them all at once the next UTC day, so at 02:20Z on 2026-10-20 it read 0 while 32 pages cited a file changed after their check.
22. A page counts in `pages_behind_code` only after it has been behind for 70 min (`FOLLOW_WINDOW_MS` in the sieun-pi repo's wiki-dream duty), the p90 gap between push runs (16.5 min) plus the p90 rewrite from a run's start to the page landing (52.7 min over four cycles on 2026-10-19 and 2026-10-20).
23. A page behind for less is the part `wiki_problems_following`, its flagged line says when it counts, and a push run starts for it while every metric is met (sieun-pi `src/duty-push.ts`), so rewrite it like any other flagged page. Since sieun-pi 819fefcb on 2026-10-29, a met duty with parts is read again every 15 min (`PART_READ_MS`) instead of each hourly check-in, because from 10-27 to 10-29 the run after a met run came at p50 60.3 min, so a page that fell behind just after a read counted before any writer saw it.
24. A `(missing)` ref whose file a commit deleted gets the same 70 min, counted from that commit (`dateMissingRefs` in the sieun-pi wiki-dream duty, since 2026-10-27), because on 2026-10-27 0f56a96354 and 263f8054be deleted files 9 pages cite, and the 07:34Z and 08:35Z runs read `wiki_problems` 3 and 6 off target within 2 min of each commit. Any other `(missing)` ref counts at once, such as a removed definition or a path that never existed, because the follow gate of step 30 refuses a commit that removes a definition a page cites, so such a ref came from a write that skipped the gate.
25. A ref marked `(missing)` can also be a repo path the page cites in `<code>` that git no longer has, from the root or under the page's `apps`, because on 2026-10-19 `domains/platform-apis/rumble.html` described a Rumble adapter deleted on 2026-07-20 while every metric read 0.
26. That subagent rewrites the line to the current path, or says on the same line that the path was removed or deleted, which `wiki-health.mjs` reads as history.
27. When the page's whole subject is gone from the code, such as an adapter or the tables a migration dropped, that subagent moves the page to `archive/` with `status: archived` and an `archived_reason` that names the removing commit and what replaced it, repoints its curated links, because a rewrite of a dead page only hides it, as the Pinterest page and the Bluesky, Rumble, Reddit and Threads pages showed on 2026-10-22.
28. Record each checked page in `verified` with the page version that holds the fix.
29. The page API refuses a curated page with no `last_verified` when it is new, when the write drops the field, or when the write adds a repo path, and it refuses a repo path a write adds in `<code>` or `source_refs` that git lacks (`pageWriteReasons` in `apps/wiki/scripts/page-gate.mjs`). A session that edits a page ahead of its code writes the page right after its code commit lands, because the stale report reads the page against the tip.
30. Since 2026-10-20, `commit.mjs` and `land-object.mjs` also refuse a code commit that deletes or renames a repo path a current curated page cites in `<code>` or `source_refs`, unless the page on the wiki already resolves the citation (`apps/wiki/scripts/follow-gate.mjs` in sieun-pi, which reads the pages from the content root in `~/.config/sieun-pi/wiki.json` and skips on a box that has none), because 22 of the 116 tip commits that deleted a path in the 48 h to 2026-10-19 21:30Z left a page citing it, such as e5b1874f01 under `apps/crawler-v3/architecture/ops-controls/index.html`. Since 2026-10-25 they also refuse a commit that keeps the file of a `source_refs` entry `path::name` and removes or renames that definition, read as `apps/wiki/src/lib/definitions.mjs` reads it, unless the page already drops the entry or names the new definition, because 8ec6907d16 removed `promoteOnly` from `scripts/repo/release.mjs` under `domains/devops/convex-deployments.html` and 17 of the 1,311 tip commits in the 48 h to 2026-10-25 11:23Z left a page citing a removed definition the same way. Since 2026-10-30 the `source_refs` check reads every page the stale report reads, experiment and settled pages included, while a `<code>` path on an experiment or settled page stays history, because 053c39867a removed `run_stockists` from `apps/crawler-v3/scripts/resolve_undo.py`, which `experiments/2026-10-29-profile-entity-resolution/index.html` cites, the gate skipped experiment pages, and the 06:17Z run counted the page in `wiki_problems` at once. Of the 4,277 first-parent tip commits from 2026-10-28 06:00Z to 2026-10-30 06:30Z, the wider check refuses 2 more, 053c39867a and c3eb87150a, both under experiment pages.
31. So a new `(missing)` ref here came from a write that skipped those scripts, and a new dated ref came from a session that passed the warning of step 32, a take-in of `staging` that `land-object.mjs` lands, or a `sieun-pi:` ref.
32. Since 2026-10-29, `commit.mjs` warns, and since 2026-11-01 `land-object.mjs` warns on the stack it lands, on a code commit that changes what a curated page states through its `source_refs` while the page on the wiki still states the old code, and names those pages, judged by the stale report's own rules (`behindWarning` in `apps/wiki/scripts/follow-gate.mjs`, rules in `apps/wiki/src/lib/stale-rules.mjs`), and the stale report reads a page that a commit changes with its cited code as checked against that commit. The warning lets the commit through, because a page behind its code guards no data, money, auth, outside send or vendor limit (owner rules c98 and c108), and the committing session then fixes each fact the diff changed, or sets `last_verified` when the diff changes nothing the page states, and writes the page through the API. In the 7 days to 2026-10-29 20:14Z, 665 code commits put 1,557 page flags on the wiki, 621 of those commits came from agent sessions that ran `commit.mjs`, and those sessions fixed 15 of their 1,452 flags themselves within 70 min. 88% of the 867 page-hours that counted in `wiki_problems` fell while the dream made no commit for over 45 min, 65% while its one job was parked on model quota or a pi-pool slot (`~/work/wiki-stale-churn-1030/FINDINGS.md`). Until then no gate checked content changes, because on 2026-10-19 a test on the names and numbers a diff shares with the page flagged 22 of 29 judged flags, 11 of them with no fact changed, which the engine rules of steps 14 to 20 and 34 have since narrowed. On 2026-11-01 the 76 lands through `land-object.mjs` printed no such warning, and 21 of them left 60 page flags, such as 96426129ff, which left 5 pages behind its `_shared.py` change (`~/work/d4-wiki-behind-code-1102/evidence.md`).
33. The `path::name` refs of step 14 are the content check the engine runs instead, and they matter because 162 of the 267 checks that followed a flag from 2026-10-16 to 2026-10-21 changed only `last_verified`, while a filter on the definitions each page names would have skipped 122 of those 162. In the 7 days to 2026-10-28 10:28Z, 673 of the 1,151 dream rechecks changed only `last_verified` or `source_refs`, and 249 of the 513 such flags in the replay came only from `path::name` refs whose definition changed in a part the page does not state, so a narrower ref at check time is what cuts them, because a filter that asked those changed lines for a word of the page dropped 148 of the 513 and also 39 of the 441 page fixes.
34. Since 2026-10-31, a `path::name` ref to a class, interface or object type skips a field added with a default value that the page does not name in `<code>`, such as `connect_floor: float | None = None`, once the page names at least two members of the class at its check (`memberKeys` in `stale-rules.mjs`). This holds because dc9b5aca13 added only that field to `packages/sirocco/src/sirocco/surfaces.py::Fingerprint`, all 5 pages citing it were flagged, and all 5 rechecks changed only `last_verified`. On a replay of the 7 days to 2026-10-31 11:43Z, 119 dream rechecks had a flagged class ref, 59 with a page body change and 60 with `last_verified` only, and the rule drops 12 of the 60 and none of the 59 (`~/work/wiki-stale-class-refs-1031/`). A page that names fewer members still follows the whole class, because `apps/crawler-v3/configuration/index.html` names one `RuntimeProfile` field and describes the rest in prose, and an added method or field with no default still counts, because pages that list `FleetPool` methods added `render_fresh` when 6d37342863 added it.

## Phase 4 · writing rules on a glide path

1. The glide plan started 2026-10-11 at 250 failing pages and drops 5 pages a day, so `lint_over_glide` misses only when the dream falls behind.
2. Take `lint_page` items in the precheck's order, which puts the most views in 30 days first.
3. The writer rewrites the page into the numbered-line format of `writing.md` with the diagrams it needs, keeps every live fact, and checks each fact against the code before it keeps it.
4. Make no style edit to a page that is not on the day's list.
5. Do not rewrite an `archive_candidate`, which is a page at least 60 days old with 0 views in 60 days and no curated inbound link, and add it to `archiveCandidates` with today's date instead, because on 2026-10-18 the precheck flagged `domains/devops/ci-risks/index.html` a few minutes after the VP of CI chat wrote it, until `apps/wiki/scripts/wiki-health.mjs` read each page's age from the git commit that added it.
6. Move each candidate to `archive/` with `archived_reason` in the run that finds it, then remove it from the list, because a page with 0 views in 60 days gains nothing from a wait.

## Phase 5 · mistakes to skills

The signal is the adapter's flagged items.
They are owner corrections and their repeats since the last run, harness memories and refinements created since the last run, and session logs whose text hit a fixed phrase list (`commit.mjs refused`, guard refused, OOM, CI red, land failed, reverted, owner correction).
Log hits are keyword matches, and logs mention CI and git in normal work, so read the excerpt before you count one.

1. Group the signal into classes and match each to a ledger class first, because the ledger was seeded with the 8 classes in section D of `wiki-audit.md`.
2. A class qualifies when it showed up 2 or more times in 7 days, or once as an owner correction that repeats an earlier one.
3. Take every class that qualifies, `reopened` first, then `open` by count, with one subagent per class.
4. The subagent finds the owning skill in `.agents/skills/repo/skill-creation/references/skill-map.md`, then the line that should have stopped the mistake.
5. It names the gap, and the gap decides the fix.

| Gap         | How you know                                                                                                   | Fix                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| text        | No skill or rule states it.                                                                                    | Edit the owning skill body. Replace or merge the nearest line, and never stack a second near-copy of a rule. |
| trigger     | The rule exists, and the session that erred never read the skill (`skill-metrics` reads, the log's own reads). | Edit the description to lead with the use case that missed, then run the trigger probe.                      |
| enforcement | The rule loaded and the agent broke it anyway.                                                                 | Start a fix job with `rlm.create_session` that lands the lint, guard or check in code with a test.           |

6. The enforcement fix job ships its code through the object and probe flow below, and on 2026-10-15 board_and_delegation, slop_in_replies_and_pages and wiki_upkeep had sat 5 days as plan-step proposals under p249 with no job, so none got a check.
7. Write the rule as a past mistake with its date and one concrete case, per the content standard in `repo/skill-creation`.
8. Put repo knowledge in `.agents/skills`, which Claude Code and Codex read, never in a global Prime memory.
9. Put a rule about Prime chats, jobs or the board in `~/.prime/agent/AGENTS.md` or a global skill, both in sieun-pi.
10. When the ledger shows a recurrence inside a fixed class's `watchUntil`, set the class to `reopened`, append the date to `recurred`, and read why the fix did not hold before you write another.

### Skill edit checks and commits

1. Run `scripts/skills/check-skill-spec.sh .agents/skills` on the box the run uses after every skill edit, because the agent guard's local-check table does not list it and CI does not run it, and it takes about 90 s.
2. `node scripts/ci/check-skill-paths.mjs` runs here in under 1 s and again in CI through `pnpm ci:guards`, and every `apps/**`, `convex/**` or `packages/**` path a skill cites must resolve.
3. Run `node scripts/skills/generate-skill-map.mjs` and `./scripts/skills/sync-claude-skills.sh` only when a description changed or a skill was added, moved or deleted.
4. A description change needs the trigger probe in `.agents/skills/repo/skill-creation/references/trigger-probe.md`, one fresh subagent on a prompt that does not name the skill and one on a nearest-miss prompt.
5. The probe passes only when the skill shows in CONTEXT LOADED and every sentinel holds.
6. A skill edit is not a wiki-only change, so it follows "Ship a change" in `repo/git-workflow`.
7. Commit each change on the tip as its own commit right after the checks above, with `node scripts/repo/agent/commit.mjs -m "docs(wiki-dream): <what>" <files>`, and ask nobody for a probe slot or a go.
8. Until 2026-10-18 this step sent the object's sha to the chat to ask Fable for a probe slot, after the owner had said on 2026-10-12: "NEVER wait for something, or ask for my permission to push to Github etc."
9. Commit every drafted rule in the same run. On 2026-10-10 two drafted rules were left "for tomorrow" with no sha sent, and they landed only on 2026-10-14.
10. A wiki page change needs no commit: write it with `wiki.write()` or `PUT https://us-metal02-dev.tail0c093d.ts.net:5184/wiki/<path>`, and `wiki-backup.timer` copies it to the private repo `sieu-n/wiki-content` within 5 minutes.
    A revert of a page is a new write of its older revision, read from `GET /wiki/api/agent/history?path=<path>` and `/wiki/api/agent/diff`, and the ledger records the page version instead of a commit.
11. Commit a global skill or `config/AGENTS.md` in sieun-pi locally with `git -C <sieun-pi checkout> add -- <new files>` and `git -C <sieun-pi checkout> commit -m "docs(wiki-dream): <what>" -- <files>`, then confirm it with `git log -3 --stat`, where the checkout is `/Users/sieunpark/Documents/Github/sieun-pi` on the Mac and `/home/sieun/src/sieun-pi` on us-metal02.
12. A sieun-pi commit is live at once through the `~/.prime/agent/skills` symlinks.
13. Never push either repo, and never pass `--allow-shared`.
14. After the commit lands, set the class to `fixed` with `fixCommit`, `fixedAt`, and `watchUntil` 7 days out.

## Memory moves

On 2026-10-10, 306 of 502 global harness memories were auto-sns-agent repo facts.
Claude Code and Codex never see them, and they drift from the skills that state the same rule in other words.
The glide plan in `wiki-dream.ts` expects at least 10 a day from 2026-10-11, and the run moves every one it can, with no daily cap.

1. A repo-fact memory is a global memory whose `path` or `title` starts with `auto-sns-agent`.
2. Move memories that feed an open class first, then the oldest.
3. Find each memory's owning skill file and give all memories of one file to one subagent, which checks whether the file states each rule already, so no two subagents edit a file at once, because `commit.mjs` commits whole files and on 2026-10-21 4b90ff5258 carried two sibling memories' hunks in `deploy-and-infra.md` under its own message and 0dcda0ef07 carried a sibling's hunk in `.claude/rules/app-crawler-v3.md`.
4. If it does, the move needs no edit, and the commit is the one that added the line (`git log -S '<phrase>' -1 -- <skill file>`).
5. If it does not, add the rule through the skill edit flow above, as part of that day's skill commits.
6. Delete the memory with `rlm.harness.delete_memory(<id>, global_=True)` only after the skill commit is on the local tip.
7. Delete a memory the current code contradicts without a move, and name the code path that proves it wrong in its ledger row.
8. Keep a memory that is half repo fact and half Prime behaviour until its Prime half has a home.
9. Record each move in `memoryMoves` with the skill, the commit and `deletedAt`.

## Commits, churn guards and "when unsure, leave it"

1. Every commit the job makes uses the scope `wiki-dream`, such as `docs(wiki-dream): merge deploy-runbook into production-runbook`, because the precheck finds dream commits, reverts and retouched pages by that scope.
2. One change is one commit, so one `git revert` undoes one change.
3. Before a subagent starts on files, check them with one `node scripts/repo/agent/whose.mjs <path>...` call and skip a file a live session owns. With no path it reads the whole tree, and on 2026-10-15 a job that ran it once per page took 88.8 s a call at load 157 and sat in one cell for 40 minutes.
4. When `commit.mjs` refuses, report the refusal and leave the file, because a guard refusal is never routed around.
5. A flagged invariant item gets fixed even on a page a `(wiki-dream)` commit touched in the last 7 days, and `pages_retouched` only tells you to read the revert reason in step 6 first. On 2026-10-15 the precheck read pages_retouched 7 and dream_reverts 0.
6. A revert of a dream commit means the change was wrong, so read the revert's reason and record it on the class or page before the dream touches that file again.
7. Leave it and ask the owner when a merge is unclear, an archive would hit a page agents still read, a rule would move from one skill to another, or a fix would contradict an owner correction.
8. The dream sends nothing outside the machine, so no email, ticket reply, message or post.

## The ledger, written last

The job writes the ledger after its last commit lands.
A run that dies mid-way leaves the ledger as it was, so the next run redoes its items, and each fix checks the live state before it edits.

```json
{
	"version": 1,
	"pairs": { "<a>|<b>": { "verdict": "distinct|merged", "at": "<iso>", "job": "<name>", "score": 0.4 } },
	"verified": { "<path>": { "at": "<iso>", "commit": "<sha>" } },
	"classes": {
		"<slug>": {
			"title": "...",
			"skill": "<path>",
			"gap": "text|trigger|enforcement",
			"status": "open|fixed|reopened",
			"firstSeen": "<iso>",
			"fixCommit": "<sha>",
			"fixedAt": "<iso>",
			"watchUntil": "<iso>",
			"recurred": ["<iso>"],
			"sources": ["..."]
		}
	},
	"archiveCandidates": { "<path>": { "since": "<iso>" } },
	"memoryMoves": { "<memory id>": { "skill": "<path>", "commit": "<sha>", "deletedAt": "<iso>" } },
	"runs": [{ "at": "<iso>", "job": "<name>", "commits": ["<sha>"], "summary": "..." }]
}
```

Write the whole file through a temp file and a rename, so the precheck never reads half a ledger.

## Reporting

1. After the ledger write, rerun the precheck from sieun-pi `components/user-history` with `OUTPUT_FILE=<session data>/precheck.json LAST_RUNS_FILE=~/.prime/agent/browser-chat/duties/01a1164b-4a2d-742d-b27a-82f086ed0200/d4.last-runs.json node --import tsx scripts/duties/wiki-dream.ts` (without `LAST_RUNS_FILE` it finds no ledger and prints 999999), and go again until wiki_problems, open_mistakes, mistakes_back and dup_unjudged are all 0, or name the blocker and whose it is. The 2026-10-15 01:30 run stopped with stale_vs_code at 11 and no blocker named.
2. A quiet day sends nothing, and the runner keeps its run record.
3. A day with changes sends the chat one `plan_update` on p200, the wiki goal the duty brief names, since p249 is no longer on the board, whose note gives the metrics before and after and the commit SHAs, and closes the run's wiki session with the commit list.
4. The report has owner lines only for a skill rule that changed (the class, the rule line, the commit), an open question from "leave it and ask", or a metric missed 2 runs in a row, and otherwise it says "nothing for the owner".
5. Owner lines use short everyday words with no internal names, per correction c32.
6. On Monday's run, one writer subagent writes a weekly page in the run's session folder, with the glide paths as a chart and each mistake class with its fix and recurrences.
