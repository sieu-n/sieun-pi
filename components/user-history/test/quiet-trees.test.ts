// The owner on 10-19: "look, when everybody's asleep it should drop ram", with 15 minutes as the quiet window (p717). d7's quiet_agent_gb read a
// box only once all of it had gone 15 min with no session working, and from 14:29Z on 10-19 us-metal02 never did: autonomous jobs kept 80 to
// 126 sessions working day and night, so the headline was never measured. Prime runs a chat and all its jobs in one worker, so d7 now sums the
// workers none of whose sessions has worked for the quiet window. The fixture is the daemon's session list and the worker footprints on
// us-metal02 at 20:29:46Z on 10-19, with 83 workers holding 74 GB: 11 of them had no session working, holding 5.79 GB.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { MemoryGroup } from "../../prime-relay/host-stats.ts";
import { measure, quietReadings } from "../scripts/duties/whole-system.ts";
import { type Footprints, watchLine, type WatchLine } from "../src/mac-usable-watch.ts";
import { judge } from "../src/shared/chat-duties.ts";

const GB = 1024 ** 3;
const MIN = 60_000;
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/daemon-rows-1019-2029.json"), "utf8")) as
  { rows: Record<string, unknown>[]; workers: Footprints["workers"] };
const duty = JSON.parse(readFileSync(join(import.meta.dirname, "../scripts/duties/whole-system.duty.json"), "utf8")) as { metrics: Parameters<typeof judge>[0] };
const footprints: Footprints = { workers: fixture.workers, kernels: [], swap_used_bytes: 16.7 * GB, pressure_level: null, cpu_s: 0 };
const memory = { groups: [{ id: "agents", label: "Agent sessions", bytes: 58.12 * GB, swapBytes: 16.74 * GB, top: [] }] satisfies MemoryGroup[], cacheBytes: 17.2 * GB };
const RUN = Date.parse("2026-10-19T20:30:08Z");
const VENT = 511321;
/** The fixture's rows with a session of vent's worker streaming. */
const ventAtWork = fixture.rows.map(row => row.workerPid === VENT && row.lifecycle === "live" && typeof row.activeSessionId === "string" ? { ...row, isStreaming: true, activity: "working" } : row);
const lineAt = (at: number, rows: readonly unknown[]): WatchLine => ({ host: "us-metal02",
  ...watchLine({ now: at, rows, footprints, queue: null, chats: new Set(), title: () => null, cpuMs: 0, usable: null, memory }) });
/** One line a minute at hh:mm:30 from 20:00:30Z to 20:29:30Z; `rows` picks each minute's rows. */
const lines = (rows: (at: number) => readonly unknown[]): WatchLine[] =>
  Array.from({ length: 30 }, (_, index) => Date.parse("2026-10-19T20:00:30Z") + index * MIN).map(at => lineAt(at, rows(at)));
/** The same lines as the watch wrote them before 10-20, with no `byWorker`. */
const old = (watch: readonly WatchLine[]): WatchLine[] => watch.map(({ byWorker: _byWorker, ...line }) => line);

test("the watch lists every worker with its sessions at work, not only the 5 largest", () => {
  const line = lineAt(RUN, fixture.rows);
  assert.equal(line.top.length, 5);
  assert.equal(line.byWorker?.length, 83);
  assert.equal(line.byWorker?.filter(worker => worker.working === 0).length, 11);
  const vent = line.byWorker!.find(worker => worker.pid === VENT)!;
  assert.deepEqual({ gb: vent.gb, tree: vent.tree, working: vent.working }, { gb: 0.9, tree: "vent", working: 0 });
  assert.ok(line.byWorker!.reduce((sum, worker) => sum + worker.working, 0) <= line.agents!.working);
});

test("with 100 sessions at work on the box, quiet_agent_gb reads the 5.79 GB that the 11 quiet trees held", () => {
  const watch = lines(() => fixture.rows);
  assert.ok(watch.every(line => line.agents!.working > 100), "the whole box never sat quiet");
  assert.equal(measure({ now: RUN, watch: old(watch), log: { holds: [] }, chats: [], quietMs: 15 * MIN }).metrics.quiet_agent_gb, undefined,
    "lines without byWorker leave the headline unmeasured, as every run did from 14:29Z on 10-19");
  const output = measure({ now: RUN, watch, log: { holds: [] }, chats: [], quietMs: 15 * MIN });
  assert.equal(output.metrics.quiet_agent_gb, 5.79);
  assert.equal(output.metrics.quiet_agent_gb_us_metal02, 5.79);
  assert.equal(judge(duty.metrics, output).metrics.quiet_agent_gb?.met, false);
  assert.match(output.flagged?.find(slice => slice.kind === "quiet_agents")?.excerpt ?? "",
    /^us-metal02's 11 trees with no session working for 15 min or more held 5\.79 GB at 20:\d\dZ: vent \(pid 511321, 0\.9 GB, quiet since 20:00Z\), .* and 6 more\./);
});

test("a tree counts only once its own sessions sat quiet for the window", () => {
  const watch = lines(at => at === Date.parse("2026-10-19T20:20:30Z") ? ventAtWork : fixture.rows);
  const latest = quietReadings(watch, RUN - 30 * MIN, RUN, 15 * MIN).at(-1)!;
  assert.equal(latest.trees.length, 10, "vent's worker had a session streaming at 20:20:30Z, 9 min before");
  assert.equal(latest.gb, 4.89);
  assert.equal(measure({ now: RUN, watch, log: { holds: [] }, chats: [], quietMs: 15 * MIN }).metrics.quiet_agent_gb, 5.79,
    "the headline is the worst minute of the window, from 20:15Z up to vent's turn at 20:20Z");
  const gap = watch.filter(line => Date.parse(line.at) < Date.parse("2026-10-19T20:10:00Z") || Date.parse(line.at) > Date.parse("2026-10-19T20:14:00Z"));
  assert.ok(quietReadings(gap, RUN - 30 * MIN, RUN, 15 * MIN).every(reading => reading.trees.every(tree => tree.since >= Date.parse("2026-10-19T20:14:00Z"))),
    "a watch gap restarts each tree's stretch");
});
