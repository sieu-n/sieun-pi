# Limits rest on evidence

The owner wants every made-up safety limit in auto-sns-agent found and removed, every day. This is the playbook of the duty job. The precheck in `limits-evidence.ts` lists the candidates; this job judges and removes them.

## Inputs

1. The precheck output file named in the brief holds `candidates`, new ones first, each with its key, app, file, line, kind and text.
2. The ledger is `apps/llm-wiki/content/domains/devops/limits-ledger.json` in auto-sns-agent, with a verdict per candidate key under `limits` and one record per run under `runs`.
3. Read the ledger first, and write it last, after the stacks are sent.

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
3. `unbacked` means no evidence exists and its removal is on a ci/ ref but not yet on the local sieun/dev tip; `commit` names the sha and the ref.
4. `removed` means the key is gone from the candidate list because the removal reached the tip.
5. `owner` means the limit guards money, an outside send or account ban risk and has no evidence, so the owner decides.

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
4. Never touch a limit that guards real money, an outside send or account ban risk when it has measured evidence, and mark such a limit with no evidence as `owner`.
5. A limit that a test checks loses that test case in the same commit.

## Shipping

1. Work in your wiki session folder, never in the shared tree, and never write `.git/index`.
2. Start every shell with `export GIT_INDEX_FILE=<session folder>/<app>.index`, then run `git read-tree $(git rev-parse sieun/dev)` with that index.
3. For each limit, copy the file with `git show <base>:<path>` into the session folder, edit the copy, then `git hash-object -w`, `git update-index --cacheinfo`, `git write-tree` and `git commit-tree -p <previous commit>`.
4. Each commit removes one limit, with the message `chore(<app>): drop unbacked limit <name>` and a body line `Evidence check: <what you searched>, none found.` plus a `Session-Id:` trailer.
5. Check that `git diff --stat <base> <stack tip>` names only the files you meant.
6. Check the syntax of each changed file from a `git archive` copy, such as `python3 -m py_compile` or `node --check`, because checks on this machine are guard-refused.
7. Send this chat the app, the stack tip sha and a fresh ref name `ci/limits-<app>-<yymmdd>`; the chat asks Fable for the probe slot, and the stack goes to that ref only on Fable's go, with a plain push and never `--force`.
8. Read the run with `gh run list --workflow verify-dev.yml --branch ci/limits-<app>-<yymmdd> --limit 1`; when it is red, add a fix commit on top and push to the same ref as a fast-forward.
9. When it is green, send this chat the sha and run id for the release owner, and stop there.

## Ledger and report

1. Set `unbacked` with the commit for each limit you removed, `kept` or `not_limit` with evidence, and `owner` for the guard limits, then move each `unbacked` entry whose key left the candidate list to `removed`.
2. Append one run record with the unbacked limits found, removed, kept and left for the owner.
3. Commit the ledger with `node scripts/repo/agent/commit.mjs -m "docs(limits): ledger <date>" apps/llm-wiki/content/domains/devops/limits-ledger.json`.
4. Send this chat one `scratch_add` op with the counts and a `wiki:domains/devops/limits-ledger.json` link, and one `todo_add` per `owner` limit with its file, what it guards and the choices "remove it" and "keep it".
