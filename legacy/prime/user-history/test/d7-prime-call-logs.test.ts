// d7 reads Prime stalls, slow renames and hung tool calls as dirty minutes of clean_min_30 (owner c133 and c75: one headline the owner reads
// by hand). Until 11-04 they were the separate metrics worker_stalls_24h, rename_p90_6h and hung_calls, so d7 had 6 metrics and every run asked
// the chat to rework its shape.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { measure } from "../scripts/duties/whole-system.ts";
import { readCallLogs, readPrimeEvents } from "../scripts/duties/prime-call-logs.ts";
import { readServiceFaults } from "../src/daemon-faults.ts";
import type { HungCall } from "../src/hung-calls.ts";
import type { WatchLine } from "../src/mac-usable-watch.ts";
import { updateSpan } from "../src/prime-update.ts";

const now = Date.parse("2026-11-04T12:00:00Z");
const at = (iso: string) => `2026-11-04T${iso}Z`;
const rename = (ts: string, ms: number, outcome = "ok") => JSON.stringify({ ts: at(ts), src: "supervisor", method: "rename", target: "9eb4457e77f7", ms, outcome });
const stall = (ts: string, ms: number, src = "worker") => JSON.stringify({ ts: at(ts), src, event: "event_loop_stall", ms, spans: [] });

test("reads stalls of 5 s or more and renames over 1 s that overlap the window, from worker and supervisor logs", () => {
  const files = new Map<string, string[]>([
    ["worker-ee92e1d8c39e-c9310437b8b4.sock.f6408364.calls.jsonl", [stall("11:40:00.000", 5_070), stall("11:41:00.000", 4_900), "not json", stall("11:20:00.000", 9_000)]],
    ["daemon.sock.a.calls.jsonl", [stall("11:50:00.000", 10_300, "supervisor"), rename("11:55:00.000", 1_400), rename("11:56:00.000", 1_000), rename("11:57:00.000", 2_000, "error")]],
  ]);
  const events = readPrimeEvents(files, now - 30 * 60_000, now);
  assert.deepEqual(events.map(event => [event.kind, event.kind === "stall" ? event.src : event.target, event.source, event.ms]), [
    ["stall", "worker", "c9310437b8b4", 5_070],
    ["stall", "supervisor", "supervisor", 10_300],
    ["rename", "9eb4457e77f7", "supervisor", 1_400],
    ["rename", "9eb4457e77f7", "supervisor", 2_000],
  ]);
  assert.equal(events[0]!.from, Date.parse(at("11:39:54.930")), "a stall with no since starts its ms before its line");
});

test("reads every call log written in the window, the rotated one included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prime-calls-"));
  try {
    writeFileSync(join(dir, "daemon.sock.a.calls.jsonl"), `${rename("11:50:00.000", 1_100)}\n`);
    writeFileSync(join(dir, "daemon.sock.a.calls.jsonl.old"), `${rename("11:40:00.000", 2_000)}\n`);
    writeFileSync(join(dir, "worker-a-old.sock.1.calls.jsonl"), `${stall("01:00:00.000", 9_000)}\n`);
    utimesSync(join(dir, "worker-a-old.sock.1.calls.jsonl"), new Date(now - 86_400_000), new Date(now - 86_400_000));
    writeFileSync(join(dir, "daemon.sock.a.log"), "not a call log\n");
    for (const name of ["daemon.sock.a.calls.jsonl", "daemon.sock.a.calls.jsonl.old"]) utimesSync(join(dir, name), new Date(now - 60_000), new Date(now - 60_000));
    const files = await readCallLogs(dir, now - 32 * 60_000);
    assert.deepEqual([...files.keys()].sort(), ["daemon.sock.a.calls.jsonl", "daemon.sock.a.calls.jsonl.old"]);
    assert.equal(readPrimeEvents(files, now - 32 * 60_000, now).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The 10-25 20:17:47Z run on us-metal02 (test/prime-update-maintenance.test.ts) reads all 30 minutes clean once its update span is known.
const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const watch = fixture("prime-update-1025-2010.watch.jsonl").split("\n").filter(Boolean).map(line => JSON.parse(line) as WatchLine);
const service = fixture("prime-update-1025-2010.service.txt").split("\n");
const record = JSON.parse(fixture("prime-update-1025-2010.record.json")) as unknown;
const RUN = Date.parse("2026-10-25T20:17:47.036Z");
const ts = (clock: string) => Date.parse(`2026-10-25T${clock}Z`);
const hung: HungCall = { session: "01a150f1-5231-71cd-ae83-0911bf1d9f7a", name: "restart-cold-start", root: "01a14ff6-e911-7508-8f16-2d51528f55d5",
  tree: "d7 clean minutes", silentMin: 75, workCores: 0, kernelCores: 0, command: null, why: "no progress" };
const withHung = watch.map(line => line.at.startsWith("2026-10-25T20:15") ? { ...line, hung: [hung] } : line);
const run = (events: Parameters<typeof measure>[0]["prime"], lines = watch) => measure({ now: RUN, watch: lines, log: { holds: [] }, chats: [],
  daemonFaults: readServiceFaults(service, "us-metal02"), primeUpdates: [{ ...updateSpan(record)!, host: "us-metal02" }], ...events ? { prime: events } : {} });

test("a Prime worker or supervisor stall of 5 s or more, a rename over 1 s and a hung call each make their minute dirty and name their cause", () => {
  assert.equal(run(undefined).metrics.clean_min_30, 30);
  const { metrics, flagged } = run({ host: "us-metal02", events: [
    { kind: "stall", src: "worker", source: "c9310437b8b4", from: ts("19:52:10"), to: ts("19:52:16"), ms: 6_385 },
    { kind: "stall", src: "supervisor", source: "supervisor", from: ts("19:59:55"), to: ts("20:00:05.3"), ms: 10_300 },
    { kind: "rename", source: "supervisor", target: "9eb4457e77f7", from: ts("20:05:20"), to: ts("20:05:21.4"), ms: 1_400 },
    { kind: "stall", src: "worker", source: "a5608ba18a31", from: ts("20:11:00"), to: ts("20:11:06"), ms: 6_000 },
  ] }, withHung);
  assert.equal(metrics.clean_min_30, 25, "19:52Z, 19:59Z and 20:00Z for the stalls, 20:05Z for the rename and 20:15Z for the hung call; 20:11Z is inside the update");
  assert.equal(metrics.prime_stall_min_30, 3);
  assert.equal(metrics.slow_rename_min_30, 1);
  assert.equal(metrics.hung_call_min_30, 1);
  for (const gone of ["rename_p90_6h", "worker_stalls_24h"]) assert.equal(metrics[gone], undefined);
  const dirty = flagged?.find(slice => slice.kind === "dirty_minutes")?.excerpt ?? "";
  assert.match(dirty, /19:52Z us-metal02 Prime event loops stalled 5 s or more \(worker c9310437b8b4 6\.4 s\)/);
  assert.match(dirty, /20:00Z us-metal02 Prime event loops stalled 5 s or more \(supervisor 10\.3 s\)/);
  assert.match(dirty, /20:05Z us-metal02 Prime session renames took over 1 s \(9eb4457e77f7 1\.4 s\)/);
  assert.match(dirty, /20:15Z 1 tool call hung \(restart-cold-start 75 min\)/);
  assert.match(flagged?.find(slice => slice.kind === "prime_calls")?.excerpt ?? "", /19:52Z worker c9310437b8b4 stall 6\.4 s, .*20:05Z rename of 9eb4457e77f7 1\.4 s/);
});
