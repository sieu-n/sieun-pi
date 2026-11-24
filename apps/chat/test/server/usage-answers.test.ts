/**
 * api/usage's kept answers (server/usage-answers.ts): built once per change of the sums, built again off the request path, and served as
 * they are in between.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Threads } from "../../server/threads.ts";
import { UsageAnswers } from "../../server/usage-answers.ts";
import type { UsageRange, UsageTotal } from "../../server/usage-store.ts";

const threads = { thread: () => undefined, threadsList: () => [] } as unknown as Threads;
const HOUR = 3_600_000;

function sums() {
  const store = { reads: 0, fail: false, turns: 1, now: 10 * HOUR + 60_000, versionNow: 1 };
  const row = (bucket: number): UsageTotal => ({
    bucket, host: "h", client: "pi-host", agent: "", thread: "t", threadName: "t", model: "m", series: "h|pi-host||t|m", chat: "h|pi-host||t",
    turns: store.turns, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, unpriced: 0,
  });
  return Object.assign(store, {
    version: () => store.versionNow,
    async usage(range: UsageRange) {
      store.reads++;
      if (store.fail) throw new Error("no store");
      return [row(range.since)];
    },
  });
}

test("an answer is built once per version and again off the request path when the version moves", async () => {
  const store = sums();
  const answers = new UsageAnswers(store, threads, () => store.now);
  const first = await answers.report({ range: "24h", bucket: "hour" });
  const reads = store.reads;
  assert.ok(reads > 0);
  assert.equal(await answers.report({ range: "24h", bucket: "hour" }), first, "the same version serves the kept answer");
  assert.equal(store.reads, reads, "and reads no sums");

  store.versionNow = 2;
  store.turns = 5;
  await (answers as unknown as { rebuild(): Promise<void> }).rebuild();
  const built = store.reads;
  assert.ok(built > reads, "a moved version builds the asked answers again with no call");
  const next = await answers.report({ range: "24h", bucket: "hour" });
  assert.equal(store.reads, built, "the call after the rebuild reads no sums");
  assert.notEqual(next, first);

  store.now += HOUR;
  await answers.report({ range: "24h", bucket: "hour" });
  assert.ok(store.reads > built, "an answer whose last bucket ended is built again");
});

test("a failed build is not kept, so the next call tries again", async () => {
  const store = sums();
  store.fail = true;
  const answers = new UsageAnswers(store, threads, () => store.now);
  await assert.rejects(answers.report({ range: "24h", bucket: "hour" }), /no store/);
  await new Promise(resolve => setImmediate(resolve));
  store.fail = false;
  const reads = store.reads;
  await answers.report({ range: "24h", bucket: "hour" });
  assert.ok(store.reads > reads);
});

test("sums with no version keep nothing", async () => {
  const store = sums();
  const answers = new UsageAnswers({ usage: range => store.usage(range) }, threads, () => store.now);
  await answers.report({ range: "24h", bucket: "hour" });
  const reads = store.reads;
  await answers.report({ range: "24h", bucket: "hour" });
  assert.ok(store.reads > reads);
});
