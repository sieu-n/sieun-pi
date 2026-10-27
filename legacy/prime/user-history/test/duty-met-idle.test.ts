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

// On 10-25 the Wiki dream read wiki_problems_following 0 at 12:30Z and nothing read it again until 16:30Z, so a met duty with parts now gets
// a push run each check-in interval (`pushMisses`). Its precheck flags every page retouched in 7 days on every run (76 at 08:27Z on 10-25),
// so such a push run starts a job only when a part is off target.
test("a push run of a met duty with parts starts no job while every part is on target, and starts one once a part is off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-push-remeasure-"));
  try {
    const out = join(dir, "out.json");
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { copyFileSync } from "node:fs"; copyFileSync(${JSON.stringify(out)}, process.env.OUTPUT_FILE);`);
    const store = new DutyStore(dir);
    let now = Date.parse("2026-10-25T12:52:00Z");
    const duty: Duty = {
      id: "d4", name: "Wiki dream", ownerWords: "the main wiki all articles and whcih articles exist itself should always be up to date", goal: "no page behind code",
      metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }],
      schedule: { kind: "every", minutes: 24 * 60 }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 },
      onMiss: "Rewrite each page behind code.", status: "active", createdAt: now - 48 * 60 * MIN, updatedAt: now - 48 * 60 * MIN, runCount: 0, lastRunAt: now - 60 * MIN,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const result = (value: number) => ({ value, target: 0, op: "<=" as const, met: value <= 0 });
    await store.appendRun(CHAT, { duty: "d4", at: now - 61 * MIN, trigger: "verify", ms: 1000, verdict: "met", summary: "", metrics: { wiki_problems: result(0) },
      parts: { wiki_problems_following: result(0) } });
    const started: string[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "AI harness", cwd: dir, board: id }),
        working: async () => false,
        retire: async () => {},
        start: async (_chat, name) => { started.push(name); return { id: `job-${started.length}`, name }; },
      },
      checkIn: { view: async () => ({ everyMs: 60 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
    });
    const retouched = { kind: "retouched", item: "auto-sns-agent:.claude/rules/app-crawler-v3.md", excerpt: "changed by 81 commits in 7 days" };
    const push = async (following: number) => {
      await writeFile(out, JSON.stringify({ metrics: { wiki_problems: 0, wiki_problems_following: following }, flagged: [retouched] }));
      await duties.tick();
      await duties.settled();
      return (await store.runs(CHAT))[0]!;
    };
    const quiet = await push(0);
    assert.equal(quiet.trigger, "push");
    assert.ok(quiet.summary.endsWith(NOTHING_DUE), quiet.summary);
    assert.deepEqual(started, []);
    now += 30 * MIN;
    assert.equal((await push(3)).at, quiet.at, "no push before the check-in interval");
    now += 31 * MIN;
    const behind = await push(3);
    assert.equal(behind.trigger, "push");
    assert.equal(started.length, 1, "a push run that reads a part off target starts its job");
    duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
