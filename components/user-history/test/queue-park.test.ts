import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PARK_AFTER_S, PARK_CONTINUE, parkPlan, parkTick, type QueueView } from "../src/queue-park.ts";

// pi-pool's queue at 20:03Z on 10-15, 50 min after the fleet stop switch was lifted: 14 turns working in 5 trees, 47 queued for 12 slots,
// while 33 Prime workers held 21.2 GB and the fleet budget had been shut since 19:23Z. 36 of the 38 queued trees had no turn working; 20 of
// those were duty run keys, which hold no worker until the run's job starts.
const view = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/pi-pool-queue-1015-2003.json"), "utf8")) as QueueView;
const NOW = Date.parse("2026-10-15T20:03:00Z");
const CHATS = new Set(["01a1164b-4a2d-742d-b27a-82f086ed0200", "01a115e2-9544-7204-b8db-8ce4d5319048"]);

test("the 20:03Z queue parks the lone root jobs that only wait behind a full round of slots", () => {
  const { park, unpark } = parkPlan(view, [], CHATS, NOW);
  // 20 of the 47 queued were duty run keys that hold no worker yet, and 11 lone roots sat within one round of the front.
  assert.deepEqual(park.map(entry => entry.position), [13, 17, 19, 36]);
  for (const entry of park) {
    assert.equal(entry.parent, null);
    assert.ok(entry.position > view.limit && entry.waitS >= PARK_AFTER_S);
    assert.ok(!view.working.some(working => working.tree === entry.tree), "a tree with a working turn keeps its worker anyway");
    assert.ok(!CHATS.has(entry.session));
  }
  assert.ok(!park.some(entry => entry.position <= view.limit), "a turn within one round of the front stays");
  assert.deepEqual(unpark, [], "no slot is free while 47 wait for 12");
});

// From 20:08Z to 20:57Z on 10-15 the first parker parked 14 jobs and resumed none: it waited for fewer than 12 turns to wait at all, and 19 to
// 41 waited all hour (service.log "queue park" lines). A parked job now keeps its place: it goes back once fewer than the limit of the turns
// that asked before it parked still wait.
test("a parked job goes back once the turns that asked before it parked fit in one round, oldest first, even with a long queue behind it", () => {
  const entry = (i: number, askedMinAgo: number) => ({ session: `01a14200-0000-7000-8000-0000000000${String(i).padStart(2, "0")}`, tree: `t${i}`, parent: null,
    class: "high", position: i + 1, waitS: askedMinAgo * 60 });
  // 30 turns wait: 10 asked 50 min ago, 20 asked in the last 5 min.
  const queued = [...Array.from({ length: 10 }, (_, i) => entry(i, 50)), ...Array.from({ length: 20 }, (_, i) => entry(10 + i, 5)).map(e => ({ ...e, waitS: 60 }))];
  const parked = [{ session: "a", at: NOW - 40 * 60_000, position: 14 }, { session: "b", at: NOW - 30 * 60_000, position: 16 }, { session: "c", at: NOW - 20 * 60_000, position: 20 }];
  const { unpark, drop } = parkPlan({ working: [], queued, limit: 12 }, parked, CHATS, NOW);
  assert.deepEqual(drop, []);
  assert.deepEqual(unpark.map(item => item.session), ["a", "b"], "10 asked before them, so 2 of the 12 slots of the next round are theirs");
});

test("a resumed job is not parked again while its turn waits, and its entry ends once it leaves the queue; a job woken some other way is dropped", () => {
  const id = "01a14069-563d-719b-a7cc-8aa7de6fa076";
  const filler = Array.from({ length: 20 }, (_, i) => ({ session: `f${i}`, tree: `f${i}`, parent: null, class: "high", position: i + 1, waitS: 10 }));
  const waitingAgain = { session: id, tree: id, parent: null, class: "high", position: 21, waitS: 600 };
  const resumed = [{ session: id, at: NOW - 3_600_000, position: 14, resumedAt: NOW - 600_000 }];
  const queuedView = { working: [], queued: [...filler, waitingAgain], limit: 12 };
  assert.deepEqual(parkPlan(queuedView, resumed, CHATS, NOW).park, []);
  assert.deepEqual(parkPlan(queuedView, resumed, CHATS, NOW).drop, []);
  assert.deepEqual(parkPlan({ ...queuedView, queued: filler }, resumed, CHATS, NOW).drop, resumed);
  const parked = [{ session: id, at: NOW - 3_600_000, position: 14 }];
  assert.deepEqual(parkPlan({ working: [{ session: id, tree: id }], queued: filler, limit: 12 }, parked, CHATS, NOW).drop, parked);
});

test("a turn is not parked twice, nor a duty key, a subagent, or one that has waited under 120 s", () => {
  const base = { tree: "x", parent: null, class: "high", position: 30, waitS: 500 };
  const queued = [
    { ...base, session: "01a14000-aaaa-7000-8000-000000000001", tree: "01a14000-aaaa-7000-8000-000000000001" },
    { ...base, session: "duty:01a11b0b:d1", tree: "duty:01a11b0b:d1" },
    { ...base, session: "01a14000-aaaa-7000-8000-000000000002", tree: "01a14000-aaaa-7000-8000-000000000009", parent: "01a14000-aaaa-7000-8000-000000000009" },
    { ...base, session: "01a14000-aaaa-7000-8000-000000000003", tree: "01a14000-aaaa-7000-8000-000000000003", waitS: 60 },
    ...Array.from({ length: 20 }, (_, i) => ({ ...base, session: `filler-${i}`, tree: `filler-${i}`, position: i + 1 })),
  ];
  const { park } = parkPlan({ working: [], queued, limit: 12 }, [{ session: "01a14000-aaaa-7000-8000-000000000001", at: 0, position: 30 }], new Set(), NOW);
  assert.deepEqual(park, []);
});

test("parkTick aborts what it parks, keeps the list on disk, and resumes through the fleet budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "queue-park-"));
  const file = join(dir, "queue-parked.json");
  const aborted: string[] = [];
  const unloaded: string[] = [];
  const resumed: [string, string][] = [];
  let current = view;
  let open = false;
  const deps = { file, queue: async () => current, chats: async () => CHATS, log: () => {}, abort: async (id: string) => { aborted.push(id); }, unload: async (id: string) => { unloaded.push(id); },
    resume: async (id: string, text: string) => { resumed.push([id, text]); },
    fleet: { place: async () => open ? () => {} : null }, now: () => NOW };
  const first = await parkTick(deps);
  assert.equal(first.parked, aborted.length);
  assert.deepEqual(unloaded, aborted, "each parked job's worker stops at once, after its abort released the queue entry");
  assert.equal(JSON.parse(await readFile(file, "utf8")).length, aborted.length);
  current = { ...view, queued: [] };
  assert.equal((await parkTick(deps)).resumed, 0, "the budget is shut, so nothing goes back");
  open = true;
  const back = await parkTick(deps);
  assert.equal(back.resumed, Math.min(12, aborted.length));
  assert.equal(resumed[0]![0], aborted[0]);
  assert.equal(resumed[0]![1], PARK_CONTINUE);
});
