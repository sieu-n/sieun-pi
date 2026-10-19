// Owner 10-09 (goal p35): "make this screen functional all green". On 10-19 every prod Watchlist chip read Status unavailable while owner_green_pct
// read 91.8%, because the screen's status read ran past its budget; these cases pin how d2 counts that read in watchlist_risks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ScreenChunk, SCREEN, SCREEN_SAMPLE, type WatchData, parseScreen, report, screenFailed, screenKeys } from "../scripts/duties/watchlist-green.ts";

const metrics = [
  { key: "owner_green_pct", target: 100, direction: "min" },
  { key: "watchlist_risks", target: 0, direction: "max" },
] as never;

test("screenKeys takes SCREEN_SAMPLE crawler keys spread over the org's 9,855 accounts, posts and collab", () => {
  const keys = Array.from({ length: 9_855 }, (_, i) => [`instagram:account:H${i}`, `instagram:tagged:h${i}`]).flat();
  const picked = screenKeys(keys);
  assert.equal(picked.length, SCREEN_SAMPLE);
  assert.equal(picked[0], "instagram:posts:h0");
  assert.equal(new Set(picked).size, SCREEN_SAMPLE);
  assert.ok(picked.some(key => key.includes(":tagged:")) && picked.some(key => key.includes(":posts:")));
});

test("parseScreen reads the chunk lines and screenFailed keeps chunks that were not a 200 or ran past the budget", () => {
  const chunks = parseScreen(`noise\nscreen\t25\t200\t900\nscreen\t25\t0\t${SCREEN.budgetMs + 40}\nscreen\t25\t500\t300\n`);
  assert.deepEqual(chunks.map(chunk => chunk.status), [200, 0, 500]);
  assert.deepEqual(screenFailed(chunks).map(chunk => chunk.status), [0, 500]);
});

function data(screen: ScreenChunk[]): WatchData {
  return { now: 0, keys: ["instagram:account:a"], errors: [], streams: [], screen,
    rows: [{ platform: "instagram", kind: "posts", target: "a", paused: false, lastOutcome: "ok", lastRunAt: 0, lastStopReason: "", lastErrorCode: "",
      isPrivate: false, errStreak: 0, due: true, noAccountSince: null }] };
}

test("a screen read with a late chunk adds one Watchlist risk while every row is green", () => {
  const ok = report(data([{ keys: 25, status: 200, ms: 800 }]), metrics);
  assert.equal(ok.metrics.owner_green_pct, 100);
  assert.equal(ok.metrics.watchlist_risks, 0);
  assert.equal(ok.metrics.screen_read_ok_pct, 100);
  const late = report(data([{ keys: 25, status: 200, ms: 800 }, { keys: 25, status: 0, ms: SCREEN.budgetMs + 50 }]), metrics);
  assert.equal(late.metrics.owner_green_pct, 100);
  assert.equal(late.metrics.watchlist_risks, 1);
  assert.equal(late.metrics.screen_read_ok_pct, 50);
});
