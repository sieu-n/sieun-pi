// From 10-23 08:00Z to 10-24 08:00Z standing duties started 57 jobs on runs that read met, 27 of them Whole system (d7), whose onMiss ends
// "All on target: end with no message". Each took a place in pi-pool's turn line, where the median wait was 40 min at 09:05Z to 09:35Z on
// 10-24, ahead of the red duties' fix jobs.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties, NOTHING_DUE } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { Duty } from "../src/shared/chat-duties.ts";
import type { CheckInView } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;

test("a standing duty's met run with only informational findings starts no job; an item to act on or a miss still starts one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-met-idle-"));
  try {
    const out = join(dir, "out.json");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { copyFileSync } from "node:fs"; copyFileSync(${JSON.stringify(out)}, process.env.OUTPUT_FILE);`);
    const store = new DutyStore(dir);
    let now = Date.parse("2026-10-24T09:00:00Z");
    const duty: Duty = {
      id: "d7", name: "Whole system", ownerWords: "the box stays usable", goal: "quiet agents under 5 GB",
      metrics: [{ key: "quiet_agent_gb", label: "Quiet agent GB", op: "<=", target: 5, headline: true }],
      schedule: { kind: "every", minutes: 30 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 },
      onMiss: "Each missed metric gets one fix job. All on target: end with no message.",
      status: "active", createdAt: now - 24 * 60 * MIN, updatedAt: now - 24 * 60 * MIN, runCount: 0,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const started: string[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "AI harness", cwd: dir, board: id }),
        working: async () => false,
        retire: async () => {},
        start: async (_chat, name) => { started.push(name); return { id: `job-${started.length}`, name }; },
        ended: async (last, older = []) => [...last, ...older],
        stop: async () => {},
      },
      checkIn: { view: async () => ({ everyMs: 120 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
    });
    const run = async (value: number, flagged: object[]) => {
      await writeFile(out, JSON.stringify({ metrics: { quiet_agent_gb: value }, flagged }));
      await duties.runNow(CHAT, "d7");
      await duties.settled();
      now += 31 * MIN;
      return (await store.runs(CHAT))[0]!;
    };
    const quiet = await run(1.05, [{ kind: "smoothness", excerpt: "every minute clean" }, { kind: "agents_now", excerpt: "12 agents" }]);
    assert.deepEqual(started, []);
    assert.equal(quiet.verdict, "met");
    assert.ok(quiet.summary.endsWith(NOTHING_DUE), quiet.summary);
    await run(1.1, [{ kind: "hung_call_stopped", item: "01a16942", excerpt: "a hung call was stopped" }]);
    assert.equal(started.length, 1, "a met run that names an item still starts its job");
    await run(7.2, []);
    assert.equal(started.length, 2, "a missed run starts its job");
    duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
