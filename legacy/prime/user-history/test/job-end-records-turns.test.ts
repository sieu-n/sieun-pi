// 11-23 us-metal02: a job end read every other owned.json record at once, and their answers came back in one loop turn. On a rig with the
// box's 2,364 records that turn took 80 ms, and with 10,000 records 317 ms (~/work/pi-host-stalls/k-job-end/report.md); pi-host runs
// every job end of its threads on its one loop. The records are now read one at a time, so no read's answer waits behind thousands of others.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const RECORDS = 10_000;

test("a job end reads 10,000 other ownership records without holding the loop 150 ms, and keeps the path another record names", async t => {
  const home = mkdtempSync(join(tmpdir(), "job-end-records-turns-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  const artifacts = join(home, ".prime", "agent", "session-artifacts");
  for (let i = 0; i < RECORDS; i++) {
    const folder = join(artifacts, randomUUID());
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "owned.json"), JSON.stringify({ paths: [join(home, "scratch", `other-${i}`, "x")], units: [] }));
  }
  const job = join(artifacts, randomUUID(), "sub-1");
  mkdirSync(job, { recursive: true });
  const shared = join(home, "scratch", "other-7");
  mkdirSync(join(shared, "x"), { recursive: true });
  writeFileSync(join(job, "owned.json"), JSON.stringify({ paths: [shared], units: [] }));
  const { endLeftovers, leftoverSource } = await import("../src/job-leftovers.ts");
  const source = { ...leftoverSource, strays: async () => [], stopServices: async () => [], inside: async () => [], stopContainers: async () => [], stopUnits: async () => [] };
  let longest = 0;
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 5);
  try {
    const left = await endLeftovers(source, [job]);
    assert.deepEqual(left.owned, []);
    assert.equal(left.kept?.length, 1);
    assert.match(left.kept![0]!, new RegExp(`^${shared}: the record of [0-9a-f-]{36} names ${join(shared, "x")}$`));
  } finally {
    clearInterval(timer);
  }
  assert.ok(longest < 150, `the longest loop turn took ${Math.round(longest)} ms`);
});
