// Owner 10-09 (goal p35): "make this screen functional all green". On 10-19 every prod Watchlist chip read Status unavailable while owner_green_pct
// read 91.8%, because the screen's status read ran past its budget; these cases pin how d2 counts that read in watchlist_risks.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO } from "../scripts/duties/estate-reads.ts";
import { type ScreenChunk, GROUP_CALLER, GROUP_FIRST_READ_LIMIT_S, GROUP_WARM_READ_LIMIT_S, PROD_GROUP_URL, SCREEN, SCREEN_SAMPLE, type WatchData, SUMMARY_URL, groupRead, readCrawlerKey, report, screenFailed, screenKeys, screenRead } from "../scripts/duties/watchlist-green.ts";

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
      isPrivate: false, errStreak: 0, due: true, lastOkAt: 0, addedAt: 0, renamed: false }] };
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

test("a first group read past 10 s or a warm one past 3 s adds one Watchlist risk, and their seconds go to run detail (p314, p302, 11-05)", () => {
  const screen = data([{ keys: 25, status: 200, ms: 800 }]);
  const page = (ms: number, status = 200): ScreenChunk => ({ keys: 5000, status, ms });
  const fast = report({ ...screen, group: { first: [page(6_770), page(900)], warm: [page(1_720), page(800)] } }, metrics);
  assert.equal(fast.metrics.watchlist_risks, 0);
  assert.equal(fast.metrics.group_first_read_max_s, 6.8);
  assert.equal(fast.metrics.group_warm_read_max_s, 1.7);
  const coldSlow = report({ ...screen, group: { first: [page(GROUP_FIRST_READ_LIMIT_S * 1000 + 1)], warm: [page(1_000)] } }, metrics);
  assert.equal(coldSlow.metrics.watchlist_risks, 1);
  const warmSlow = report({ ...screen, group: { first: [page(5_000)], warm: [page(GROUP_WARM_READ_LIMIT_S * 1000 + 1)] } }, metrics);
  assert.equal(warmSlow.metrics.watchlist_risks, 1);
  const failed = report({ ...screen, group: { first: [page(31_500, 503)], warm: [page(31_500, 503)] } }, metrics);
  assert.equal(failed.metrics.watchlist_risks, 1);
});

test("groupRead reads every page of the org in order as a member, following next until the last page", async () => {
  const asked: { after?: string | undefined; caller: string | null }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    assert.equal(url, PROD_GROUP_URL);
    const sent = JSON.parse(String(init.body)) as { after?: string };
    asked.push({ after: sent.after, caller: new Headers(init.headers).get("x-virev-caller") });
    const next = sent.after ? null : "instagram:posts:b";
    return new Response(JSON.stringify({ data: { rows: [{ key: "k" }], next } }), { status: 200 });
  }) as typeof fetch;
  const pages = await groupRead(fetcher, "k", "d3fde08b431c5e52", AbortSignal.timeout(5_000));
  assert.deepEqual(pages.map(page => [page.keys, page.status]), [[1, 200], [1, 200]]);
  assert.deepEqual(asked, [{ after: undefined, caller: GROUP_CALLER }, { after: "instagram:posts:b", caller: GROUP_CALLER }]);
});

test("readCrawlerKey decrypts the prod crawler key from the auto-sns-agent checkout by default", { skip: !existsSync(join(REPO, "apps/crawler-v3/.env.keys")) }, async () => {
  // 11-04: b4497e1a57 took CRAWLER_API_KEY out of apps/search/.env, and the 01:47Z d2 run wrote watchlist_risks as its placeholder.
  const key = await readCrawlerKey();
  assert.ok(key.length > 0 && !key.startsWith("encrypted:"));
});
