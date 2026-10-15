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
const CHATS = new Set(["01a1164b-4a2d-742d-b27a-82f086ed0200", "01a115e2-9544-7204-b8db-8ce4d5319048"]);

test("the 20:03Z queue parks the lone root jobs that only wait behind a full round of slots", () => {
  const { park, unpark } = parkPlan(view, [], CHATS);
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

test("parked sessions go back oldest first, one per free slot", () => {
  const short: QueueView = { ...view, queued: view.queued.slice(0, 9) };
  const parked = [{ session: "c", at: 3, position: 40 }, { session: "a", at: 1, position: 20 }, { session: "b", at: 2, position: 30 }, { session: "d", at: 4, position: 41 }];
  const { park, unpark } = parkPlan(short, parked, CHATS);
  assert.deepEqual(park, []);
  assert.deepEqual(unpark.map(entry => entry.session), ["a", "b", "c"], "12 slots, 9 waiting: 3 go back");
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
  const { park } = parkPlan({ working: [], queued, limit: 12 }, [{ session: "01a14000-aaaa-7000-8000-000000000001", at: 0, position: 30 }], new Set());
  assert.deepEqual(park, []);
});

test("parkTick aborts what it parks, keeps the list on disk, and resumes through the fleet budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "queue-park-"));
  const file = join(dir, "queue-parked.json");
  const aborted: string[] = [];
  const resumed: [string, string][] = [];
  let current = view;
  let open = false;
  const deps = { file, queue: async () => current, chats: async () => CHATS, log: () => {}, abort: async (id: string) => { aborted.push(id); },
    resume: async (id: string, text: string) => { resumed.push([id, text]); },
    fleet: { tryAdmit: async () => open ? () => {} : null }, now: () => 1000 };
  const first = await parkTick(deps);
  assert.equal(first.parked, aborted.length);
  assert.equal(JSON.parse(await readFile(file, "utf8")).length, aborted.length);
  current = { ...view, queued: [] };
  assert.equal((await parkTick(deps)).resumed, 0, "the budget is shut, so nothing goes back");
  open = true;
  const back = await parkTick(deps);
  assert.equal(back.resumed, Math.min(12, aborted.length));
  assert.equal(resumed[0]![0], aborted[0]);
  assert.equal(resumed[0]![1], PARK_CONTINUE);
});
