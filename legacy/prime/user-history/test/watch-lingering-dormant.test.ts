// Guards d7's 05:52Z run on 11-09: the 05:51Z release's successor left slack green guy (Mac) and vent (us-metal02) detached at its first pass,
// 4 min after the d2 precheck's tab opens of 05:41Z restarted their idle clocks, while the old process still held their attach. The hub gave no
// idle clock for a dormant chat, so d7 counted both from their 04:02Z lastActivityAt and named them lingering 110 min; both unloaded by 05:53:30Z.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadHub } from "../src/chat-threads.ts";
import { type Footprints, watchLine } from "../src/mac-usable-watch.ts";

const MIN = 60_000;
const footprints: Footprints = { workers: { 41483: { pids: 3, bytes: 2e8 } }, kernels: [], orphans: [], swap_used_bytes: null, pressure_level: null, cpu_s: 0 };

test("a chat left dormant keeps the idle clock it went dormant with, so d7 counts it lingering only past the unload window by that clock", async () => {
  let now = Date.parse("2026-11-09T05:52:29Z");
  const catalog = { subscribe: () => () => {} };
  const hub = new ThreadHub("/isolated-watch-lingering-dormant.sock", catalog as never, () => ({ provider: null, modelId: null, thinkingLevel: null }), undefined,
    { now: () => now });
  try {
    const id = "01a11b0b-7c15-73da-9481-8de15903eab4";
    const rows = [{ sessionId: id, sessionName: "slack green guy", lifecycle: "live", activeSessionId: "b4de", activity: "idle", isSessionActive: false,
      attachedClients: 1, workerPid: 41483, lastActivityAt: new Date(now - 110 * MIN).toISOString() }];
    const lingering = () => watchLine({ now, rows, footprints, queue: null, chats: new Set([id]), title: () => null, cpuMs: 0, idleClock: chat => hub.idleClock(chat) })
      .lingering?.map(row => [row.name, row.idleMin]);
    hub.pin(id);
    hub["dormant"].sleep(id, 4 * MIN, "left detached");
    assert.equal(hub.idleClock(id), now - 4 * MIN);
    assert.deepEqual(lingering(), undefined, "4 min idle by the hub's clock is inside the window, whatever the old lastActivityAt");
    now += 14 * MIN;
    assert.deepEqual(lingering(), [["slack green guy", 18]], "a dormant chat still loaded past the window by its clock lingers");
    hub["dormant"].wake(id, "open");
    assert.equal(hub.idleClock(id), undefined, "a woken chat with no live thread has no clock");
    hub.unpin(id);
    assert.equal(hub.idleClock(id), undefined);
  } finally {
    await hub.close();
  }
});
