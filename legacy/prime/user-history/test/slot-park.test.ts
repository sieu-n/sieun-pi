import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileSlotPark, parsePoolQueue, slotParkOf, slotParkWords } from "../src/slot-park.ts";

const ID = "01a17f25-f22d-71ef-9327-e68919164bb4";
const lines = readFileSync(new URL("./fixtures/slot-park-01a17f25-1028.jsonl", import.meta.url), "utf8").trim().split("\n");
const upTo = (iso: string) => lines.filter(line => (JSON.parse(line) as { timestamp: string }).timestamp <= iso);
const at = (iso: string) => Date.parse(iso);

test("01a17f25 reads parked from its first park until the pool's wake wrote provider_quota_resume", () => {
  const first = slotParkOf(upTo("2026-10-27T20:56:58.575Z"), ID, at("2026-10-27T21:00:00Z"), null);
  assert.deepEqual(first, { since: at("2026-10-27T20:55:56.986Z"), place: 134, total: 139, resumeAt: at("2026-10-27T21:16:58.000Z") });
  assert.equal(slotParkWords(first!), "waits for a working slot, place 134 of 139");
  const second = slotParkOf(upTo("2026-10-27T21:12:20.715Z"), ID, at("2026-10-27T21:13:00Z"), null);
  assert.deepEqual(second, { since: at("2026-10-27T20:55:56.986Z"), place: 104, total: 185, resumeAt: at("2026-10-27T21:32:21.000Z") });
  assert.equal(slotParkOf(upTo("2026-10-27T21:17:00.755Z"), ID, at("2026-10-27T21:18:00Z"), null), null);
});

test("a new pi-pool-queue place opens a wait again and the turn that ran clears it", () => {
  const queued = slotParkOf(upTo("2026-10-27T21:22:12.687Z"), ID, at("2026-10-27T21:22:13Z"), null);
  assert.deepEqual(queued, { since: at("2026-10-27T21:22:09.542Z"), place: 104, total: 193 });
  assert.equal(slotParkOf(lines, ID, at("2026-10-27T21:23:00Z"), null), null);
});

test("pi-pool's line wins for the place, and a wait the pool dropped is over once its time passed", () => {
  const parked = upTo("2026-10-27T21:12:20.715Z");
  const pool = parsePoolQueue(JSON.stringify({ enabled: true, working: [], queued: [{ session: ID, position: 61, total: 170, parked: true }] }));
  assert.deepEqual(slotParkOf(parked, ID, at("2026-10-27T21:14:00Z"), pool), { since: at("2026-10-27T20:55:56.986Z"), place: 61, total: 170, resumeAt: at("2026-10-27T21:32:21.000Z") });
  const starting = parsePoolQueue(JSON.stringify({ enabled: true, working: [{ session: ID }], queued: [] }));
  assert.equal(slotParkWords(slotParkOf(parked, ID, at("2026-10-27T21:16:40Z"), starting)!), "waits for its working slot to start");
  const empty = parsePoolQueue(JSON.stringify({ enabled: true, working: [], queued: [] }));
  assert.ok(slotParkOf(parked, ID, at("2026-10-27T21:20:00Z"), empty));
  assert.equal(slotParkOf(parked, ID, at("2026-10-27T21:33:00Z"), empty), null);
});

test("an owner stop clears a wait and an idle unload does not", () => {
  const parked = upTo("2026-10-27T20:56:57.912Z");
  const state = (reason: string) => JSON.stringify({ type: "session_state", timestamp: "2026-10-27T20:58:00.000Z", state: { status: "archived", reason } });
  assert.ok(fileSlotPark([...parked, state("idle_unload")]).park);
  assert.equal(fileSlotPark([...parked, state("owner_stop")]).park, undefined);
});
