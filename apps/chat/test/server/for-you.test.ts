/**
 * /api/for-you while pi-host is slow. A pi-host call waits behind every command queued there, such as a search that takes seconds, so For you
 * must answer from the boards it already read and read the rest at once, not one chat after another.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/for-you.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { start, type Running } from "./helpers.ts";

let s: Running;
let realDocGet: typeof s.host.docGet;
before(async () => {
  s = await start();
  realDocGet = s.host.docGet.bind(s.host);
});
after(async () => {
  s.host.docGet = realDocGet;
  await s.close();
});

const forYou = async (): Promise<{ items: unknown[] }> => {
  const response = await fetch(`${s.base}/api/for-you`, { signal: AbortSignal.timeout(3_000) });
  assert.equal(response.status, 200);
  return (await response.json()) as { items: unknown[] };
};

test("For you reads every chat's board at once, so it waits on pi-host once", async () => {
  let inFlight = 0;
  let most = 0;
  s.host.docGet = async (thread, name) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise(resolve => setTimeout(resolve, 200));
    inFlight -= 1;
    return realDocGet(thread, name);
  };
  (s.app.boards as unknown as { cache: Map<string, unknown> }).cache.clear();
  const items = (await forYou()).items;
  s.host.docGet = realDocGet;
  assert.ok(items.length > 0);
  assert.ok(s.app.boards.chats().length > 1);
  assert.equal(most, s.app.boards.chats().length);
});

test("For you answers from the boards it read when pi-host stops answering", async () => {
  const before = (await forYou()).items;
  assert.ok(before.length > 0);
  s.host.docGet = () => new Promise(() => {});
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    assert.deepEqual((await forYou()).items, before);
  } finally {
    Date.now = realNow;
  }
});
