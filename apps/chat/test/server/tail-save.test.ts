/**
 * A restarted server takes the tails the stopping one saved, so the first read of a page after a restart costs one one-entry pi-host read.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/tail-save.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { EntriesQuery, EntryRecord } from "../../server/host/types.ts";
import { TailCache } from "../../server/tail-cache.ts";

const dir = mkdtempSync(join(tmpdir(), "tail-save-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A conversation of `count` entries with ids 1..count, read as pi-host reads it, with each read's query kept. */
function host(count: () => number) {
  const reads: EntriesQuery[] = [];
  const all = () => Array.from({ length: count() }, (_, i) => ({ id: i + 1, conversationId: 1, kind: "pi.assistant", model: [] }) as unknown as EntryRecord);
  return {
    reads,
    async entries(_thread: string, query: EntriesQuery) {
      reads.push(query);
      const limit = query.limit ?? 50;
      if (query.after !== undefined) {
        const rest = all().filter(e => e.id > query.after!);
        return { entries: rest.slice(0, limit), more: rest.length > limit };
      }
      const rest = all().filter(e => query.before === undefined || e.id < query.before).reverse();
      return { entries: rest.slice(0, limit), more: rest.length > limit };
    },
  };
}

test("the first newest read after a restart takes the saved tail and reads only the entries added since", async () => {
  let count = 300;
  const old = host(() => count);
  const before = new TailCache(old, 64, 2300, join(dir, "tails"));
  const page = await (await before.reader("t", 1, undefined))(undefined, 140);
  assert.equal(page.entries.length, 140);
  await before.save();

  count = 303;
  const next = host(() => count);
  const after = new TailCache(next, 64, 2300, join(dir, "tails"));
  const again = await (await after.reader("t", 1, undefined))(undefined, 140);
  assert.deepEqual(again.entries.map(e => e.id), Array.from({ length: 140 }, (_, i) => 303 - i));
  assert.deepEqual(next.reads.map(r => ({ limit: r.limit, after: r.after })), [{ limit: 1, after: undefined }, { limit: 100, after: 300 }]);
  assert.equal(readdirSync(join(dir, "tails")).length, 0, "a saved tail is taken once");
});

test("a saved tail older than 10 minutes is not read and goes at the next save", async () => {
  const old = host(() => 50);
  const before = new TailCache(old, 64, 2300, join(dir, "old"));
  await (await before.reader("t", 2, undefined))(undefined, 40);
  await before.save();
  const file = join(dir, "old", readdirSync(join(dir, "old"))[0]!);
  const stale = (Date.now() - 11 * 60_000) / 1000;
  utimesSync(file, stale, stale);

  const next = host(() => 50);
  const after = new TailCache(next, 64, 2300, join(dir, "old"));
  await (await after.reader("t", 2, undefined))(undefined, 40);
  assert.deepEqual(next.reads.map(r => r.limit), [40], "a stale file reads the page again");
  assert.equal(existsSync(file), false);
});
