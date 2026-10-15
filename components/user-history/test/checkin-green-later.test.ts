import assert from "node:assert/strict";
import { test } from "node:test";
import { greenLater } from "../src/checkin-findings.ts";
import { parseTrain } from "../src/checkin-load.ts";

/** The CI cache's runs on 10-15 for origin 2d6cdcaec0 and the push after it, as ~/.cache/virev/ci-runs.json held them at 15:27Z. */
const run = (id: number, name: string, sha: string, status: string, conclusion: string | null, created: string, updated: string) =>
  ({ run: { id, name, head_branch: "sieun/dev", head_sha: sha, path: `.github/workflows/${name}.yml`, event: "push", status, conclusion, created_at: created, updated_at: updated } });
const OLD = "2d6cdcaec0d10f9468e6ea8733d9b8bf141e62f7";
const NEW = "a43b35a24b0000000000000000000000000000aa";
const cache = (later: ReturnType<typeof run>) => parseTrain({ fetchedAt: "2026-10-15T15:27:36.132Z", runs: {
  a: run(38725138542, "verify-dev", OLD, "completed", "cancelled", "2026-10-15T11:07:46Z", "2026-10-15T13:35:56Z"),
  b: run(38725138203, "ci-cd-health", OLD, "completed", "failure", "2026-10-15T11:07:46Z", "2026-10-15T13:48:54Z"),
  c: run(38725138243, "disk-guard", OLD, "completed", "success", "2026-10-15T11:07:46Z", "2026-10-15T12:01:41Z"),
  d: later,
} });
const p192 = { waitFor: "origin 2d6cdcaec0's push verify-dev run green" };

test("a wait for a commit's push run to go green is over when a newer push cancelled it and the next push run of that workflow went green (VP of CI 10-15, p192)", () => {
  const green = cache(run(38743107248, "verify-dev", NEW, "completed", "success", "2026-10-15T13:29:20Z", "2026-10-15T15:09:16Z"));
  assert.match(greenLater(p192, green) ?? "", /run 38725138542 on 2d6cdcaec0 was cancelled, and the later push run 38743107248 on sieun\/dev at a43b35a24b, which holds it, is green/);
  assert.equal(greenLater({ waitFor: "origin 2d6cdcaec0's push verify-dev run green; then Fable told" }, green), undefined, "a clause the cache cannot check keeps the wait");
  assert.equal(greenLater({ waitFor: "origin 2d6cdcaec0's push run green" }, green), undefined, "with no workflow named, ci-cd-health's failure keeps it");
});

test("the wait holds while the later run goes or failed", () => {
  assert.equal(greenLater(p192, cache(run(38743107248, "verify-dev", NEW, "in_progress", null, "2026-10-15T13:29:20Z", "2026-10-15T14:00:00Z"))), undefined);
  assert.equal(greenLater(p192, cache(run(38743107248, "verify-dev", NEW, "completed", "failure", "2026-10-15T13:29:20Z", "2026-10-15T15:09:16Z"))), undefined);
  assert.equal(greenLater({ waitFor: "run 38725138542 green" }, cache(run(1, "disk-guard", NEW, "completed", "success", "2026-10-15T13:29:20Z", "2026-10-15T13:30:00Z"))), undefined,
    "a run id is no commit");
});
