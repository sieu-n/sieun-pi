import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readCallLogs, readPrimeCalls } from "../scripts/duties/prime-call-logs.ts";

const now = Date.parse("2026-11-04T12:00:00Z");
const at = (iso: string) => `2026-11-04T${iso}Z`;
const rename = (ts: string, ms: number, outcome = "ok") => JSON.stringify({ ts: at(ts), src: "supervisor", method: "rename", target: "s", ms, outcome });
const stall = (ts: string, ms: number, src = "worker") => JSON.stringify({ ts: at(ts), src, event: "event_loop_stall", ms, spans: [] });

test("reads rename p90 from successful renames in the last 6 h", () => {
  const lines = [...Array.from({ length: 9 }, (_, i) => rename(`10:0${i}:00.000`, 40 + i)), rename("10:10:00.000", 4_880),
    rename("10:11:00.000", 9_000, "error"), rename("05:59:00.000", 30_000)];
  const reading = readPrimeCalls(new Map([["daemon.sock.a.calls.jsonl", lines]]), now);
  assert.equal(reading.renames, 10);
  assert.equal(reading.renameP90S, 0.048);
  assert.equal(reading.renameMaxS, 4.88);
});

// 11-02 22:38:12Z: 9 workers stalled 5.0 to 9.9 s in the same 3 s at full box CPU; that is load, not one worker's code.
test("counts worker stalls of 5 s or more and leaves out bursts of 3 or more workers and the supervisor", () => {
  const files = new Map<string, string[]>([
    ["worker-a.sock.1.calls.jsonl", [stall("06:27:35.000", 5_070), stall("08:00:00.000", 4_900), stall("09:00:01.000", 6_000)]],
    ["worker-b.sock.2.calls.jsonl", [stall("09:00:03.000", 7_000)]],
    ["worker-c.sock.3.calls.jsonl", [stall("09:00:05.000", 5_500), "not json", stall("07:30:37.000", 5_983)]],
    ["daemon.sock.a.calls.jsonl", [stall("10:00:00.000", 10_300, "supervisor")]],
  ]);
  const reading = readPrimeCalls(files, now);
  assert.equal(reading.workerStalls, 2);
  assert.equal(reading.burstStalls, 3);
  assert.equal(reading.supervisorStalls, 1);
  assert.equal(reading.lastStallAt, Date.parse(at("07:30:37.000")));
  assert.equal(reading.renameP90S, undefined);
});

test("reads every call log written in the window, the rotated one included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prime-calls-"));
  try {
    writeFileSync(join(dir, "daemon.sock.a.calls.jsonl"), `${rename("11:00:00.000", 100)}\n`);
    writeFileSync(join(dir, "daemon.sock.a.calls.jsonl.old"), `${rename("07:00:00.000", 2_000)}\n`);
    writeFileSync(join(dir, "worker-old.sock.1.calls.jsonl"), `${stall("01:00:00.000", 9_000)}\n`);
    utimesSync(join(dir, "worker-old.sock.1.calls.jsonl"), new Date(now - 2 * 86_400_000), new Date(now - 2 * 86_400_000));
    writeFileSync(join(dir, "daemon.sock.a.log"), "not a call log\n");
    const files = await readCallLogs(dir, now);
    assert.deepEqual([...files.keys()].sort(), ["daemon.sock.a.calls.jsonl", "daemon.sock.a.calls.jsonl.old"]);
    assert.equal(readPrimeCalls(files, now).renames, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
