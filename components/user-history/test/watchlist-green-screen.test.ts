// Owner 10-09 (goal p35): "make this screen functional all green". On 10-19 every prod Watchlist chip read Status unavailable while owner_green_pct
// read 91.8%, because the screen's status read ran past its budget; these cases pin how d2 counts that read in watchlist_risks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ScreenChunk, SCREEN, SCREEN_SAMPLE, type WatchData, SUMMARY_URL, report, screenFailed, screenKeys, screenRead } from "../scripts/duties/watchlist-green.ts";

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

test("screenRead sends the keys in the screen's chunks, at most SCREEN.inFlight at once, and a failed request reads status 0", async () => {
  const keys = Array.from({ length: 60 }, (_, i) => `instagram:posts:h${i}`);
  let open = 0;
  let peak = 0;
  const sent: string[][] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    assert.equal(url, SUMMARY_URL);
    assert.equal((init.headers as Record<string, string>)["x-api-key"], "k");
    const chunk = (JSON.parse(String(init.body)) as { keys: string[] }).keys;
    sent.push(chunk);
    open += 1;
    peak = Math.max(peak, open);
    await new Promise(resolve => setTimeout(resolve, 5));
    open -= 1;
    if (chunk.length < SCREEN.chunkKeys) throw new Error("socket hang up");
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const chunks = await screenRead(fetcher, "k", keys, AbortSignal.timeout(5_000));
  assert.deepEqual(chunks.map(chunk => [chunk.keys, chunk.status]), [[25, 200], [25, 200], [10, 0]]);
  assert.deepEqual(sent.flat().sort(), [...keys].sort());
  assert.ok(peak <= SCREEN.inFlight);
});

test("screenFailed keeps chunks that were not a 200 or ran past the budget", () => {
  const chunks: ScreenChunk[] = [{ keys: 25, status: 200, ms: 900 }, { keys: 25, status: 0, ms: SCREEN.budgetMs + 40 }, { keys: 25, status: 500, ms: 300 }];
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
