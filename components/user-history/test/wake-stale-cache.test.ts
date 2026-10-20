// Guards the wakes on promote run 39382235504 on 10-20: every ci-cache cycle on us-metal02 failed from 11:23:57Z to 13:08:28Z, ci-run-status
// answered "has not moved since 11:23:16Z" from 11:34Z, and the ticker sent the run's wakes out at 11:45:16Z as unreadable. gh still read GitHub.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { beatStale, CACHE_INTERVAL_S, cacheWatch, CI_CACHE_REPO, parseBeat, readBeat, readRunState, REAL_GH, STALE_CYCLES } from "../src/wakes.ts";

const RUN = 39382235504;
const NOW = Date.parse("2026-10-20T11:35:16Z");
const RUNNING = JSON.stringify({ id: RUN, status: "in_progress", conclusion: null, workflow: "promote.yml", headBranch: "sieun/dev", url: "u", cacheFetchedAt: "2026-10-20T11:23:16.497Z" });
const DONE = JSON.stringify({ status: "completed", conclusion: "failure", url: `https://github.com/${CI_CACHE_REPO}/actions/runs/${RUN}`, workflowName: "promote", headBranch: "sieun/dev" });
const DEAD = `ci-run-status: /home/sieun/.cache/virev/ci-runs.json has not moved since 2026-10-20T11:23:16.497Z; check launchd ai.virev.ci-cache`;

function exec(asked: string[], cache: () => string) {
  return async (command: string, args: string[]): Promise<string> => {
    asked.push(command);
    if (command === "ci-run-status") return cache();
    assert.equal(args[args.indexOf("--repo") + 1], CI_CACHE_REPO);
    return DONE;
  };
}
const finished = { done: true, conclusion: "failure", url: `https://github.com/${CI_CACHE_REPO}/actions/runs/${RUN}`, label: "promote on sieun/dev" };

test("while the cache is stale a run wake reads its run from GitHub with the real gh, past the cache's shims", async () => {
  const asked: string[] = [];
  assert.deepEqual(await readRunState({ kind: "run", run: RUN }, exec(asked, () => RUNNING), async () => true), finished);
  assert.deepEqual(asked, [REAL_GH]);
});

test("a fresh cache answers as before, and a cache ci-run-status calls dead is read past with the real gh", async () => {
  const asked: string[] = [];
  assert.deepEqual(await readRunState({ kind: "run", run: RUN }, exec(asked, () => RUNNING), async () => false), { done: false });
  assert.deepEqual(asked, ["ci-run-status"]);
  const dead: string[] = [];
  assert.deepEqual(await readRunState({ kind: "run", run: RUN }, exec(dead, () => { throw new Error(DEAD); }), async () => false), finished);
  assert.deepEqual(dead, ["ci-run-status", REAL_GH]);
});

test("the cache goes stale after STALE_CYCLES of the poller's own pace, so a backed-off poller is not called stale", () => {
  const beat = parseBeat({ at: "2026-10-20T11:35:10Z", ok: false, error: "fetch failed", fetchedAt: "2026-10-20T11:23:16.497Z" })!;
  assert.equal(beat.intervalSeconds, CACHE_INTERVAL_S);
  assert.equal(beat.error, "fetch failed");
  assert.equal(beatStale(beat, NOW), true);
  assert.equal(beatStale(beat, beat.fetchedAt + STALE_CYCLES * CACHE_INTERVAL_S * 1000), false);
  const slow = parseBeat({ ok: true, error: null, fetchedAt: "2026-10-20T11:30:00Z", intervalSeconds: 600 })!;
  assert.equal(beatStale(slow, NOW), false);
  assert.equal(parseBeat({ fetchedAt: null }), null);
});

test("the watch reads the heartbeat file and logs each change once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-beat-"));
  try {
    const lines: string[] = [];
    let now = NOW;
    const stale = cacheWatch(line => lines.push(line), () => readBeat(dir), () => now);
    assert.equal(await stale(), false);
    await writeFile(join(dir, "ci-cache.heartbeat.json"), JSON.stringify({ at: "2026-10-20T11:35:10Z", ok: false, error: "fetch failed", fetchedAt: "2026-10-20T11:23:16.497Z" }));
    assert.equal(await stale(), true);
    assert.equal(await stale(), true);
    await writeFile(join(dir, "ci-cache.heartbeat.json"), JSON.stringify({ at: "2026-10-20T13:08:51Z", ok: true, error: null, fetchedAt: "2026-10-20T13:08:48.261Z", intervalSeconds: 30 }));
    now = Date.parse("2026-10-20T13:09:00Z");
    assert.equal(await stale(), false);
    assert.deepEqual(lines, [
      "wakes: CI cache stale since 2026-10-20T11:23:16.497Z (pace 30 s, last cycle: fetch failed); run wakes read GitHub with gh run view",
      "wakes: CI cache fresh again at 2026-10-20T13:08:48.261Z; run wakes read the cache",
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
