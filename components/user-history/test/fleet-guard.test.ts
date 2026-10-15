import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FLEET_STATE_FILE, FLEET_STOP_FILE, FleetBudget } from "../src/fleet-budget.ts";
import { FLEET_STATE_FRESH_MS, fleetGuard, fleetStopGuard, parseFleetState } from "../src/fleet-guard.ts";

const now = Date.UTC(2026, 9, 15, 19, 4, 0);
// The cell that started "5180 restart cause fix" at 19:04Z on 10-16 KST, with the budget shut at 17.9 GB.
const cell = { code: 'h = rlm.create_session(name="5180 restart cause fix", prompt=brief)\nprint(h)' };

test("a create_session cell is blocked while the fleet budget is shut, with the reason and what to do instead", () => {
  const held = fleetGuard("ipython", cell, { at: now - 5_000, closed: "the Prime workers hold 17.9 GB (budget 16 GB)" }, now);
  assert.equal(held?.block, true);
  assert.match(held!.reason, /17\.9 GB/);
  assert.match(held!.reason, /board\.wake/);
  assert.equal(fleetGuard("ipython", { code: "from rlm import create_session\ncreate_session(name='x')" }, { at: now, closed: "pi-pool reads memory pressure critical" }, now)?.block, true);
});

test("the guard lets the cell through when the budget is open, the state is stale or missing, or the cell starts no root", () => {
  assert.equal(fleetGuard("ipython", cell, { at: now, closed: null }, now), undefined);
  assert.equal(fleetGuard("ipython", cell, { at: now - FLEET_STATE_FRESH_MS - 1, closed: "x" }, now), undefined, "a stopped service never holds jobs forever");
  assert.equal(fleetGuard("ipython", cell, null, now), undefined);
  assert.equal(fleetGuard("ipython", { code: "rlm.spawn(task='look')" }, { at: now, closed: "x" }, now), undefined, "subagents are pi-pool's");
  assert.equal(fleetGuard("bash", { command: "echo create_session(" }, { at: now, closed: "x" }, now), undefined);
});

test("parseFleetState reads only a well-formed state", () => {
  assert.deepEqual(parseFleetState('{"at":1,"closed":null}'), { at: 1, closed: null });
  assert.equal(parseFleetState("{"), null);
  assert.equal(parseFleetState('{"at":"1","closed":null}'), null);
  assert.equal(parseFleetState(null), null);
});

test("a budget with a stop file publishes its state next to it, and stop() ends the publishing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-state-"));
  try {
    const budget = new FleetBudget({ gb: async () => 17.9, live: async () => false, log: () => {}, stopFile: join(dir, FLEET_STOP_FILE), readMs: 60_000 });
    let state = null;
    for (let i = 0; i < 50 && !state; i++) { await new Promise(resolve => setTimeout(resolve, 10)); state = parseFleetState(await readFile(join(dir, FLEET_STATE_FILE), "utf8").catch(() => null)); }
    budget.stop();
    assert.equal(state?.closed, "the Prime workers hold 17.9 GB (budget 16 GB)");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// 10-16 about 04:10 KST: with the stop switch on, duty runs of launch main bro and frontend bro still opened jobs through their own agent tools.
test("while the stop switch is on a duty or fix job's spawn and create_session cells are blocked, and nothing else is", () => {
  const stop = "the fleet stop switch is on";
  const spawn = { code: "h = await rlm.spawn('look at p150', name='p150-probe')" };
  assert.equal(fleetStopGuard("ipython", spawn, stop, true)?.block, true);
  assert.equal(fleetStopGuard("ipython", cell, stop, true)?.block, true);
  assert.match(fleetStopGuard("ipython", spawn, stop, true)!.reason, /stop switch is on/);
  assert.equal(fleetStopGuard("ipython", spawn, null, true), undefined, "switch off");
  assert.equal(fleetStopGuard("ipython", spawn, stop, false), undefined, "a chat or the owner's job");
  assert.equal(fleetStopGuard("ipython", { code: "print(1)" }, stop, true), undefined);
  assert.equal(fleetStopGuard("bash", { command: "rlm.spawn(" }, stop, true), undefined);
});
