import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileSlotPark, parkStopNotice, parkStopText, parsePoolQueue, slotParkOf, slotParkWords } from "../src/slot-park.ts";

const ID = "01a17f25-f22d-71ef-9327-e68919164bb4";
const lines = readFileSync(new URL("./fixtures/slot-park-01a17f25-1028.jsonl", import.meta.url), "utf8").trim().split("\n");
const upTo = (iso: string) => lines.filter(line => (JSON.parse(line) as { timestamp: string }).timestamp <= iso);
const at = (iso: string) => Date.parse(iso);

test("01a17f25 reads parked from its first park until the pool's wake wrote provider_quota_resume", () => {
  const first = slotParkOf(upTo("2026-10-27T20:56:58.575Z"), ID, at("2026-10-27T21:00:00Z"), null);
  assert.deepEqual(first, { since: at("2026-10-27T20:55:56.986Z"), place: 134, total: 139, resumeAt: at("2026-10-27T21:16:58.000Z"), ended: true });
  assert.equal(slotParkWords(first!), "waits for a working slot, place 134 of 139");
  const second = slotParkOf(upTo("2026-10-27T21:12:20.715Z"), ID, at("2026-10-27T21:13:00Z"), null);
  assert.deepEqual(second, { since: at("2026-10-27T20:55:56.986Z"), place: 104, total: 185, resumeAt: at("2026-10-27T21:32:21.000Z"), ended: true });
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
  assert.deepEqual(slotParkOf(parked, ID, at("2026-10-27T21:14:00Z"), pool), { since: at("2026-10-27T20:55:56.986Z"), place: 61, total: 170, resumeAt: at("2026-10-27T21:32:21.000Z"), ended: true });
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

test("Prime's wake that ran no turn reads as a dropped park until the next queue place, and a queue place is a live wait, not an ended turn", () => {
  assert.deepEqual(fileSlotPark(upTo("2026-10-27T21:17:00.755Z")), { dropped: at("2026-10-27T21:16:40.332Z"), complete: true });
  assert.equal(fileSlotPark(upTo("2026-10-27T21:22:09.542Z")).dropped, undefined);
  assert.equal(fileSlotPark(upTo("2026-10-27T21:22:09.542Z")).park?.ended, undefined);
});

test("the token hook's older slot waits read as waits too, and another error does not", () => {
  const error = (errorMessage: string) => JSON.stringify({ type: "message", timestamp: "2026-10-18T16:10:39.071Z", message: { role: "assistant", stopReason: "error", errorMessage } });
  const hook = "Failed to resolve API key for provider \"anthropic\" from shell command: /home/sieun/.config/pi-pool/bin/pi-pool-token pi-pool: this session " +
    "waits for its slot at 2026-10-18T16:45:52.000Z. Try again in 35 minutes.";
  assert.deepEqual(fileSlotPark([error(hook)]).park, { since: at("2026-10-18T16:10:39.071Z"), resumeAt: at("2026-10-18T16:45:52.000Z"), ended: true });
  assert.equal(fileSlotPark([error("Provider overloaded (529)")]).park, undefined);
});

test("a park-stop notice reads as parked, dropped or run since, never as cancelled", () => {
  const notice = { role: "custom", customType: "rlm_child_terminal_notice", content: "[child-exited: cancelled child:pi-pool-move]\n\nStopped while its turn waited for a provider credential",
    details: { kind: "cancelled", childId: "sub-f59b5a2f", sessionName: "pi-pool-move", reason: "Stopped while its turn waited for a provider credential" } };
  assert.deepEqual(parkStopNotice(notice), { child: "sub-f59b5a2f", name: "pi-pool-move" });
  assert.equal(parkStopNotice({ ...notice, content: "[child-exited: cancelled child:x]", details: { childId: "sub-1", reason: "aborted" } }), null);
  const parked = parkStopText("pi-pool-move", { park: slotParkOf(upTo("2026-10-27T20:56:58.575Z"), ID, at("2026-10-27T21:00:00Z"), null) });
  assert.match(parked, /^\[child-parked child:pi-pool-move\] pi-pool-move was not cancelled: Prime stopped its worker while it waits for a working slot, place 134 of 139/);
  const dropped = parkStopText("pi-pool-move", { park: null, ...fileSlotPark(upTo("2026-10-27T21:17:00.755Z")) });
  assert.match(dropped, /^\[child-park-dropped child:pi-pool-move\] .*its slot park was dropped at .*the job sweep sends it one continue .*\. Send it a message only if/);
  assert.doesNotMatch(parked + dropped, /exited|cancelled child/);
});

test("load.2's wait with a credential_unavailable diagnostic reads as a healthy wait at its place, as chat-2572's 01a17f01 at 07:34:59 KST", () => {
  const wait = JSON.stringify({ type: "message", timestamp: "2026-10-27T22:34:59.000Z", message: { role: "assistant", stopReason: "error", content: [],
    errorMessage: "pi-pool: this run waits for a working slot, place 106 of 164; the pool wakes it when the slot starts, or it asks again at 2026-10-27T22:55:00.000Z.",
    diagnostics: [{ type: "provider_stream_failure", details: { kind: "credential_unavailable", retryAtMs: Date.parse("2026-10-27T22:55:00.000Z") } }] } });
  const park = slotParkOf([wait], ID, at("2026-10-27T22:40:00Z"), null);
  assert.equal(slotParkWords(park!), "waits for a working slot, place 106 of 164");
  assert.equal(park!.ended, true);
  const cancelled = JSON.stringify({ type: "custom", customType: "provider_quota_resume", timestamp: "2026-10-27T22:55:01.000Z", data: { outcome: "cancelled" } });
  assert.deepEqual(fileSlotPark([wait, cancelled]), { dropped: at("2026-10-27T22:55:01.000Z"), complete: true }, "only a later cancelled resume strands it");
});
