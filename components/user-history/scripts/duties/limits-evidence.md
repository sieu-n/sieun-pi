# Limits rest on evidence

The owner wants every made-up safety limit in auto-sns-agent found and removed, every day. This is the playbook of the duty job. The precheck in `limits-evidence.ts` lists the candidates; this job judges and removes them.

## Inputs

1. The precheck output file named in the brief holds `candidates`, new ones first, each with its key, app, file, line, kind and text. It scans the committed sieun/dev tree, never the shared working tree, so another job's unsaved edit is not a candidate.
2. The ledger is `apps/llm-wiki/content/domains/devops/limits-ledger.json` in auto-sns-agent, with a verdict per candidate key under `limits` and one record per run under `runs`.
3. Read the ledger first, and write it last, after the stacks are sent.
4. The precheck output's `leftovers` lists each dropped limit whose name a tree still uses, searched on sieun/dev for `removed` entries and on the stack's ci/ ref for `unbacked` ones. Each one gets a commit in this run's stack for its app that removes the leftover lines. A line that uses a different limit of the same name stays, and the report names it.

```json
{
  "limits": {
    "apps/crawler-v3/src/platforms/instagram/census/tuning.py#PRIORITY_HEAVY_OWNERS_MAX": { "verdict": "unbacked", "evidence": "none: wiki search, git log -S and vendor docs show no measurement", "commit": "<sha> on ci/limits-crawler-v3-261013", "at": "2026-10-13" },
    "convex/search/ruleTags.ts#DRAIN_BATCH": { "verdict": "kept", "evidence": "Convex docs on the documents one function may read, https://docs.convex.dev/production/state/limits", "at": "2026-10-13" }
  },
  "runs": [{ "at": "2026-10-13T03:30:00+09:00", "found": 41, "removed": 38, "kept": 120, "owner": 3 }]
}
```

## Verdicts

1. `kept` means the limit cites real evidence, and the `evidence` field says which.
2. `not_limit` means the match is no safety limit, such as a vendor page size passed to an API, a protocol constant or a schema length the vendor enforces, and `evidence` says why.
3. An auth, billing or abuse bound on outside input, such as a request body cap or a login attempt limit, is out of scope and gets `not_limit` with `evidence` that starts with "out of scope:".
4. `unbacked` means no evidence exists and its removal is on a ci/ ref but not yet on the local sieun/dev tip; `commit` names the sha and the ref.
5. `removed` means the key is gone from the candidate list because the removal reached the tip.
6. `owner` is retired, because the owner chose "Remove all" for unmeasured money, send and ban caps on 10-14 (board choice t23), and the precheck counts an `owner` entry still in the code as unbacked.
7. A `kept` or `not_limit` entry with an empty `evidence` counts as unjudged.

## Evidence

1. A measurement counts when it was taken on this system and written down with its date, in a wiki page, a commit message, a session data file or a code comment that cites the run.
2. A published vendor limit counts with its doc link, such as Convex function limits, Stripe page sizes or an API's documented rate limit.
3. An incident counts when a commit, wiki page or ticket records the failure the limit prevents.
4. A comment that says "conservative", "to be safe" or "caution" is not evidence, and neither is a round number, a guess or an author's claim with no source.
5. Look in this order for each candidate: `git log -S<name> --format='%h %ad %s' -- <file>` for the commit that added it and its message, the wiki search `GET http://localhost:5176/api/agent/search?q=<name>`, the code around it, and the vendor docs for a limit on a vendor call.
6. Search the code with rg on a narrow path, and never search all of apps/llm-wiki/content.

## Removal

1. Delete the limit and every line that only served it, such as the constant, the check, the retry or backoff loop, the batching wrapper, the config field, the env var and its docs.
2. A loop that chunked work only for the cap becomes one call, and a timeout with no evidence goes, so the library default applies.
3. Leave the code simpler than you found it, with no shim, alias or fallback that keeps the old cap alive.
4. A money, send or ban limit with measured evidence stays as `kept`, and one with no evidence goes like any other (t23).
5. Before you build each commit, search the stack's base for the limit's name, and for its env var and config key if it has them, with `git grep -n -w <name> <base> -- . ':(exclude)apps/llm-wiki/content'`. This is rg over the whole repo, read from the commit the stack builds on, because the shared tree holds other jobs' edits.
6. Update every caller, import, test, doc and config line that search finds in the same commit as the drop.
7. A test that pins the old value changes to assert the new behavior, and a test that only checked the cap goes.

## Shipping

1. Work in your wiki session folder, never in the shared tree, and never write `.git/index`.
2. Start every shell with `export GIT_INDEX_FILE=<session folder>/<app>.index`, then run `git read-tree $(git rev-parse sieun/dev)` with that index.
3. For each limit, copy the file with `git show <base>:<path>` into the session folder, edit the copy, then `git hash-object -w`, `git update-index --cacheinfo`, `git write-tree` and `git commit-tree -p <previous commit>`.
4. Each commit removes one limit, with the message `chore(<app>): drop unbacked limit <name>` and a body line `Evidence check: <what you searched>, none found.` plus a `Session-Id:` trailer.
5. Check that `git diff --stat <base> <stack tip>` names only the files you meant.
6. Run `node --import tsx ~/Documents/Github/sieun-pi/components/user-history/scripts/duties/limits-evidence.ts --leftovers <base> <stack tip>`. It lists each line in the tip's tree that still names a constant a drop commit removed, and exits 1 when there is one. Fold each fix into the drop commit that left the line, and build the later commits again on top of it. It cannot trace a lowercase name such as `timeout`, or a name another file still defines, so it lists those for you to search by hand.
7. Check out the stack tip in your session folder with `git worktree add --detach --no-checkout <session folder>/tree <stack tip>`, then run `git sparse-checkout set --no-cone '/*' '!/apps/llm-wiki/content/'` and `git checkout -q` in it. On 10-15 this took 3 s and 352 MB.
8. Link the installed dependencies from the shared tree into that checkout. A Python app gets a `.venv` symlink to the app's `.venv`. A TS app gets symlinks to the root and app `node_modules`, and a SvelteKit app also gets `.svelte-kit` and `src/lib/paraglide`.
9. Run these checks in the checkout's app folder, one at a time, each under `nice -n 20`.
   1. Run `uv run --no-sync ruff check <files>` and `uv run --no-sync ty check <files>` on the touched Python files.
   2. Run `tsc --noEmit -p .` on a TS app, or `svelte-check --tsconfig ./tsconfig.json --threshold error` on a SvelteKit app, once per stack. In search on 10-15 at load 25, it took 66 s and 4 GB and found the `CH_INSERT_TIMEOUT_MS` import left behind by d3a8762bf3.
   3. Run the test files the stack touched, plus the test files that import a touched module, with `uv run --no-sync pytest <files>`, `vitest run <files>` or `node --test <files>`. Never run a whole suite.
10. Fold each fix into the drop commit that caused the failure in the same way, then run the failed check again. If a repo guard refuses a check, send this chat the refusal text and let the probe run it. Never route around a guard.
11. Remove the checkout with `git worktree remove --force <session folder>/tree`.
12. Push the whole stack to a fresh `ci/limits-<app>-<yymmdd>` with a plain push, never `--force`. Read its run with `gh run list --workflow verify-dev.yml --branch ci/limits-<app>-<yymmdd> --limit 1`, and send this chat the ref, the stack tip sha and the run id.
13. Wait for the run with `board.wake(run=<id>)` and end the turn. When it is red, add a fix commit on top and push to the same ref as a fast-forward.
14. The stack goes to the ops train only on that run's green. Send this chat the sha and run id for the release owner, and stop there.

## Ledger and report

1. Set `unbacked` with the commit for each limit you removed and `kept` or `not_limit` with evidence, then move each `unbacked` entry whose key left the candidate list to `removed`.
2. Append one run record with the unbacked limits found, removed, kept and left for the owner.
3. Commit the ledger with `node scripts/repo/agent/commit.mjs -m "docs(limits): ledger <date>" apps/llm-wiki/content/domains/devops/limits-ledger.json`.
4. Send this chat one `scratch_add` op with the counts and a `wiki:domains/devops/limits-ledger.json` link.
