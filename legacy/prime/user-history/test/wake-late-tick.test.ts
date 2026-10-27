// Guards the late wake ticker the 10-22 messaging audit found: on 10-19 from 15:32Z to 18:07Z 143 wakes were queued 100 s or more after their
// tick began, and on 10-20 at 13:08Z two run wakes 4,995 s, because every wake waited for every run read of its tick and a tick still running
// skipped the next ones. A time wake now goes at once, and a hung run read holds only the wakes on that run.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type RunState, Wakes } from "../src/wakes.ts";

const NOW = Date.parse("2026-10-19T17:05:31Z");
const HUNG_RUN = 39382235504;
const TIME_JOB = "01a14d5d-0000-7000-8000-000000000001";
const RUN_JOB = "01a154b7-8737-7184-b183-a4cd4a813777";
const LATER_JOB = "01a14dbe-0000-7000-8000-000000000002";

test("a time wake goes in its tick while a run read hangs, and the next tick shares that read and sends its own time wake", async t => {
  const dir = await mkdtemp(join(tmpdir(), "wake-late-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wake = (session: string, on: unknown) => writeFile(join(dir, `${session}-1.json`), JSON.stringify({ session, on, note: "", since: NOW - 600_000 }));
  await wake(TIME_JOB, { kind: "time", at: NOW - 1_000 });
  await wake(RUN_JOB, { kind: "run", run: HUNG_RUN });
  let release: (state: RunState) => void = () => {};
  let reads = 0;
  const sent: string[] = [];
  const wakes = new Wakes({ dir, now: () => NOW, log: () => {},
    runState: () => { reads++; return new Promise<RunState>(resolve => { release = resolve; }); },
    deliver: async session => { sent.push(session); } });
  const first = wakes.tick();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(sent, [TIME_JOB], "the time wake is queued while the run read still hangs");
  await wake(LATER_JOB, { kind: "time", at: NOW - 500 });
  assert.equal(await wakes.tick(), 1, "the next tick runs beside the hung one and sends the new time wake");
  assert.deepEqual(sent, [TIME_JOB, LATER_JOB]);
  assert.equal(reads, 1, "the hung run is read once, not once per tick");
  release({ done: true, conclusion: "success", url: "", label: "" });
  assert.equal(await first, 2);
  assert.deepEqual(sent, [TIME_JOB, LATER_JOB, RUN_JOB]);
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith(".json")), []);
});
