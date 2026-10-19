// Guards the 10-19 steady block: each check-in measure parsed the 52 MB CI cache on the chat server's main thread (0.6 to 0.9 s), and the prod
// turns tick decoded and scanned it (0.25 s), every 30 s.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readTrain } from "../src/checkin-load.ts";
import { ciRuns } from "../src/ci-runs.ts";
import { startProdTurns } from "../src/prod-turns.ts";

const job = { name: "build", steps: Array.from({ length: 40 }, (_, at) => ({ name: `step ${at}`, status: "completed", conclusion: "success", log: "x".repeat(400) })) };
function cache(runs: number): string {
  const entries = Object.fromEntries(Array.from({ length: runs }, (_, at) => [String(1000 + at), {
    run: { id: 1000 + at, name: at === 0 ? "land: land 40: tip" : "ci", path: at === 0 ? ".github/workflows/land.yml" : at === 1 ? ".github/workflows/promote.yml" : ".github/workflows/ci.yml",
      head_branch: "main", head_sha: "abc", event: "push", status: at < 2 ? "in_progress" : "completed", conclusion: at < 2 ? null : "success",
      created_at: "2026-10-19T02:00:00Z", updated_at: "2026-10-19T02:01:00Z", actor: { login: "sieu-n" } },
    jobs: [job, job] }]));
  return JSON.stringify({ version: 1, fetchedAt: "2026-10-19T02:01:30Z", runs: entries });
}

test("the CI cache is parsed off the main thread, once per version of the file, without its jobs", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ci-runs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "ci-runs.json");
  await writeFile(file, cache(300));
  const parse = JSON.parse;
  let big = 0;
  t.mock.method(JSON, "parse", (text: string, ...rest: []) => { if (typeof text === "string" && text.length > 1_000_000) big++; return parse(text, ...rest); });
  const train = await readTrain(file);
  assert.equal(big, 0, "no parse of the whole cache on this thread");
  assert.equal(train?.all?.size, 300);
  assert.deepEqual(train?.runs.map(run => [run.id, run.key, run.running]), [["1000", "40", true], ["1001", "promote", true]]);
  const runs = await ciRuns(file);
  assert.equal(await ciRuns(file), runs, "an unchanged file is not parsed again");
  assert.equal("jobs" in Object.values(runs!.runs)[0]!, false);
  await writeFile(file, cache(3));
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(Object.keys((await ciRuns(file))!.runs).length, 3, "a rewritten file is read again");
});

test("the prod turns tick reads its running deploys from the parsed cache", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ci-runs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "ci-runs.json");
  await writeFile(file, cache(5));
  let record: unknown;
  const set = new Promise<void>(resolve => {
    const stop = startProdTurns({ runsFile: file, bridgeFile: join(dir, "none.json"), log: () => {}, set: async value => { record = value; stop(); resolve(); } }, 60_000);
  });
  await set;
  assert.deepEqual((record as { trees: Record<string, string> }).trees, { "01a10810-34b5-710f-88fe-3d369f89a8c9": "promote.yml run 1001", "01a11d24-ac9b-757d-ac51-9b2b7598782f": "promote.yml run 1001" });
});
