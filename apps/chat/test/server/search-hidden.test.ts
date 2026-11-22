/**
 * Search leaves out the entries of comm threads and of walks' test agents through each document's `hidden` field, so its filter does not
 * name every such thread: on 11-22 they were 1,012 threads and 41 KB of filter text on us-metal02. A thread that becomes hidden, or stops
 * being hidden, keeps the answer and its exact count (c191) right before and after `flagHidden` marks its documents.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/search-hidden.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { SearchResult } from "../../web/src/lib/api/types.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";

type FakeThread = ReturnType<FixtureHost["addThread"]>;
import { filterText, type Cond } from "../../server/search-engine.ts";
import { start, type Running } from "./helpers.ts";

const WORD = "wombatflag";
let s: Running;
let plain: FakeThread;
let walk: FakeThread;
let hiddenThread: string;
const extra = new Set<string>();
const filters: string[] = [];

// Copies of one entry share a document, so each entry gets a time of its own.
let clock = Date.now() - 60_000;
const add = (thread: FakeThread, i: number) => (s.host as FixtureHost).append(thread, 1, {
  kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: `the ${WORD} note ${i}` }], timestamp: clock++ }],
});

before(async () => {
  s = await start();
  const host = s.host as FixtureHost;
  plain = host.addThread({ name: "Plain", createdAt: Date.now() - 3600_000 });
  walk = host.addThread({ name: "Walk agent", createdAt: Date.now() - 3600_000 });
  hiddenThread = walk.row.id;
  for (let i = 0; i < 3; i++) add(plain, i);
  for (let i = 0; i < 4; i++) add(walk, i);
  const engine = s.app.searchEngine;
  const base = engine.hiddenThreads;
  engine.hiddenThreads = () => [...base(), ...extra];
  const search = engine.search.bind(engine);
  engine.search = (q: string, where: Cond, opts, split) => {
    filters.push(filterText(where));
    return search(q, where, opts, split);
  };
  await engine.settled();
  await engine.flagHidden();
});
after(() => s.close());

const total = async () => (await s.get<SearchResult>(`/api/search?q=${WORD}&limit=100`)).total;

test("a thread that becomes hidden leaves search at once, and its id leaves the filter once its documents are marked", async () => {
  assert.equal(await total(), 7);
  extra.add(hiddenThread);
  assert.equal(await total(), 3);
  assert.ok(filters.at(-1)!.includes(hiddenThread), "the thread is not named before its documents are marked");
  await s.app.searchEngine.flagHidden();
  assert.equal(await total(), 3);
  assert.ok(!filters.at(-1)!.includes(hiddenThread), "the marked thread is still named in the filter");
  assert.ok(filters.at(-1)!.includes("hidden = true"));
});

test("an entry written to a hidden thread after the marking stays out, and a scoped search still finds the thread's entries", async () => {
  add(walk, 9);
  await s.app.searchEngine.settled();
  assert.equal(await total(), 3);
  assert.ok(!filters.at(-1)!.includes(hiddenThread));
  const scoped = await s.get<SearchResult>(`/api/search?q=${WORD}&in=${encodeURIComponent(`${hiddenThread}:1`)}&limit=100`);
  assert.equal(scoped.total, 5);
});

test("a thread that stops being hidden comes back at once with the exact count, and leaves the filter once its documents are cleared", async () => {
  extra.delete(hiddenThread);
  assert.equal(await total(), 8);
  await s.app.searchEngine.flagHidden();
  assert.equal(await total(), 8);
  assert.ok(!filters.at(-1)!.includes(hiddenThread));
});
