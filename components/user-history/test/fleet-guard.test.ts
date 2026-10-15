import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FLEET_STATE_FILE, FLEET_STOP_FILE, FleetBudget } from "../src/fleet-budget.ts";
import { fleetStopGuard, parseFleetState } from "../src/fleet-guard.ts";

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
const cell = { code: 'h = rlm.create_session(name="5180 restart cause fix", prompt=brief)\nprint(h)' };

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
