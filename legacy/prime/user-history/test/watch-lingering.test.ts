// Guards d7's count of finished sessions still loaded on any box. At 03:12Z on 10-28 a hand count of the Mac's `sessions --json` read 56
// archived sessions "still sat in workers", though every one was a spawn-ledger row with no activeSessionId, no runtime and no kernel, stamped
// with its tree worker's pid. No watch line counted the sessions a worker really held idle past the unload window, on the Mac or the box.
import assert from "node:assert/strict";
import { test } from "node:test";
import { lingering } from "../scripts/duties/whole-system.ts";
import { type Footprints, hostWatchLine, LINGER_MS, type WatchLine, watchLine } from "../src/mac-usable-watch.ts";

const now = Date.parse("2026-10-28T03:20:00Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const footprints: Footprints = { workers: { 55844: { pids: 30, bytes: 3e9 } }, kernels: [], orphans: [], swap_used_bytes: null, pressure_level: null, cpu_s: 0 };
const loaded = (id: string, minutes: number, more: Record<string, unknown> = {}) => ({ sessionId: id, sessionName: id, parentSessionId: "root", lifecycle: "live",
  activeSessionId: `a-${id}`, activity: "idle", isSessionActive: false, attachedClients: 0, workerPid: 55844, lastActivityAt: ago(minutes), ...more });
const rows = [
  { sessionId: "root", sessionName: "frontend bro", lifecycle: "live", activeSessionId: "a-root", activity: "working", isStreaming: true, attachedClients: 1, workerPid: 55844, lastActivityAt: ago(0) },
  { sessionId: "p6-trending", sessionName: "p6-trending", parentSessionId: "root", lifecycle: "archived", activity: "idle", attachedClients: 0, workerPid: 55844, lastActivityAt: ago(364) },
  { sessionId: "staging-walk", sessionName: "staging-walk", parentSessionId: "root", lifecycle: "live", activity: "idle", attachedClients: 0, workerPid: 55844, lastActivityAt: ago(207) },
  loaded("finished", 40),
  loaded("fresh", 5),
  loaded("viewed", 40, { attachedClients: 1 }),
  loaded("ticking", 40, { hasRegisteredHeartbeat: true }),
  loaded("busy", 40, { activity: "working", isStreaming: true }),
  { ...loaded("chat", 30, { attachedClients: 1 }), parentSessionId: undefined, sessionName: "slack green guy" },
];
const line = (input: readonly unknown[]) => watchLine({ now, rows: input, footprints, queue: null, chats: new Set(["chat"]), title: () => null, cpuMs: 0 });

test("a loaded session idle past the unload window lingers, and an archived or ledger row with a worker pid does not", () => {
  assert.equal(LINGER_MS, 17 * 60_000);
  assert.deepEqual(line(rows).lingering, [
    { session: "finished", name: "finished", tree: "frontend bro", worker: 55844, idleMin: 40 },
    { session: "chat", name: "slack green guy", tree: "slack green guy", worker: 55844, idleMin: 30 },
  ]);
  assert.equal(line(rows.slice(0, 3)).lingering, undefined);
});

test("d7 reads lingering sessions on the Mac through its relay, and names each box it read", async () => {
  const mac = await hostWatchLine({ name: "mac", rows, read: async () => ({ usable: null, footprints }) }, { now, chats: new Set(["chat"]), title: () => null });
  assert.deepEqual(mac.lingering?.map(row => row.session), ["finished", "chat"]);
  const box: WatchLine = { at: "2026-10-28T03:20:30Z", host: "us-metal02", usable: null, workers: 0, workerGb: 0, top: [], live: 0, working: 0, queue: null,
    mac: { swapGb: null, pressureLevel: null }, cpuMs: 0, hosts: [mac, { name: "offline-box", usable: null, workers: 0, workerGb: 0, top: [], live: 0, working: 0, swapGb: null, offline: true }] };
  assert.deepEqual(lingering(box).map(read => [read.host, read.sessions.length]), [["us-metal02", 0], ["mac", 2]]);
});
