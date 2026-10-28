// Guards d1's read of which process pushed a remote box into swap. At 09:15:30Z on 10-28 the Mac hit 11,538 swapouts/s while the sep launch!!
// tree's kernels grew from about 1.8 to 5.9 GB, and its watch line named no process, because hostWatchLine kept the box's workers but dropped
// the chat trees and their largest processes that this box's own line carries.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Footprints, hostWatchLine } from "../src/mac-usable-watch.ts";

const now = Date.parse("2026-10-28T09:15:30Z");
const GB = 1024 ** 3;
const vitest = { pid: 4242, bytes: 2.64 * GB, started: 1793178900, command: "node node_modules/.bin/vitest run --passWithNoTests tests/unit/app-urls.test.ts" };
const footprints: Footprints = { workers: { 23735: { pids: 40, bytes: 4.84 * GB } }, swap_used_bytes: 11.3 * GB, pressure_level: 2, cpu_s: 0,
  kernels: [{ pid: 4100, root: "", session: "port", pids: 14, bytes: 3.9 * GB, own: 0.05 * GB, biggest: vitest }], orphans: [] };
const rows = [
  { sessionId: "root", sessionName: "sep launch!!", lifecycle: "live", activeSessionId: "a-root", activity: "working", workerPid: 23735, lastActivityAt: new Date(now).toISOString() },
  { sessionId: "port", sessionName: "port-ui-libui", parentSessionId: "root", lifecycle: "live", activeSessionId: "a-port", activity: "working", isRunningTools: true,
    workerPid: 23735, lastActivityAt: new Date(now).toISOString() },
];
const mac = (prints: Footprints) => hostWatchLine({ name: "mac", rows, read: async () => ({ usable: null, footprints: prints }) }, { now, chats: new Set(["root"]), title: () => null });

test("a remote box's watch line names each chat tree's footprint and its largest process", async () => {
  const line = await mac(footprints);
  assert.deepEqual(line.trees, [{ root: "root", tree: "sep launch!!", gb: 3.9, biggest: { pid: 4242, gb: 2.64, started: 1793178900, command: vitest.command } }]);
});

test("a remote box with no kernel or orphan leaves trees out of its line", async () => {
  const line = await mac({ ...footprints, kernels: [] });
  assert.equal(line.trees, undefined);
});
