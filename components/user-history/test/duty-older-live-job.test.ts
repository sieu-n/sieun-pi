// Guards the two Wiki dream jobs of 10-26 that worked the same 12 pages. The 10:18 KST push job was cut at 01:48:47Z, its rerun started the
// 10:56 job at 01:57:56Z and retired it, and the job sweep's continue to its subagent, relayed through it at 01:58Z, woke it again. The 10:56
// job ended at 02:04Z, so the 02:56Z push read only that newest job, found it ended and started the 11:58 job beside the live 10:18 one. A
// duty with a live older job now hands that job the run's items, and the next run after it ends starts a job as before.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { dailySlot, type Duty, type DutyRunRecord, type FlaggedSlice, type MetricResult } from "../src/shared/chat-duties.ts";
import type { CheckInView } from "../src/shared/types.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const MIN = 60_000;
const OLD = { id: "01a175ca-d9c0-761d-962a-419b6dcd1a23", name: "wiki dream AI harness developer environment 10:18" };
const RERUN = { id: "01a175ed-9fab-7618-8862-f6385c243757", name: "wiki dream AI harness developer environment 10:56" };

const result = (value: number): MetricResult => ({ value, target: 0, op: "<=", met: value <= 0 });
const metrics = { wiki_problems: result(0) };
const page = (path: string): FlaggedSlice => ({ kind: "stale_vs_code", item: path, excerpt: `${path} behind`, handOff: true });

test("a push run hands its pages to the duty's older job that a message woke again, and starts a job once that job ends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-older-live-job-"));
  try {
    const pages = Array.from({ length: 12 }, (_, index) => `wiki/page-${index}.html`);
    const output = join(dir, "output.json");
    await writeFile(output, JSON.stringify({ metrics: { wiki_problems: 0, wiki_problems_following: pages.length }, flagged: pages.map(page) }));
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { copyFileSync } from "node:fs"; copyFileSync(${JSON.stringify(output)}, process.env.OUTPUT_FILE);`);
    const rerunDetail = join(dir, "d4-261026-1056.json");
    await writeFile(rerunDetail, JSON.stringify({ metrics: { wiki_problems: 0, wiki_problems_following: 0 }, flagged: pages.map(page) }));
    let now = Date.parse("2026-10-26T02:56:38.812Z");
    const store = new DutyStore(dir);
    const duty: Duty = {
      id: "d4", name: "Wiki dream", ownerWords: "the main wiki all articles ... should always be up to date", goal: "the wiki matches the code",
      metrics: [{ key: "wiki_problems", label: "Wiki problems", op: "<=", target: 0, headline: true }], schedule: { kind: "daily", at: "01:30" },
      precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix it", status: "active", boardGoal: "p200",
      createdAt: now - 10 * 24 * 60 * MIN, updatedAt: now - 10 * 24 * 60 * MIN, runCount: 163, lastSlotAt: dailySlot("01:30", now), lastRunAt: now - 10 * 60 * MIN,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    const pushAt = Date.parse("2026-10-26T01:18:07.475Z");
    const rerunAt = Date.parse("2026-10-26T01:56:08.740Z");
    const summary = "wiki_problems 0 (on target); all 4 on target";
    const push: DutyRunRecord = { duty: "d4", at: pushAt, slot: pushAt, trigger: "push", ms: 102_137, verdict: "met", metrics, summary,
      parts: { wiki_problems_following: result(19) }, job: OLD, cut: { error: "Request timed out.", at: Date.parse("2026-10-26T01:48:47.426Z"), provider: "anthropic" },
      after: { at: rerunAt, verdict: "met", metrics, summary, parts: { wiki_problems_following: result(0) } } };
    const rerun: DutyRunRecord = { duty: "d4", at: rerunAt, slot: rerunAt, trigger: "rerun", ms: 99_645, verdict: "met", metrics, summary, detail: rerunDetail,
      parts: { wiki_problems_following: result(0) }, rerunOf: pushAt, job: RERUN,
      after: { at: Date.parse("2026-10-26T02:02:38.752Z"), verdict: "met", metrics, summary, parts: { wiki_problems_following: result(11) } } };
    await store.appendRun(CHAT, push);
    await store.appendRun(CHAT, rerun);
    const live = new Set([OLD.id]);
    const steers: { job: string; text: string }[] = [];
    const started: string[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "AI harness developer environment", cwd: dir, board: id }),
        working: async job => live.has(job.id), retire: async () => {},
        start: async (_chat, name) => { started.push(name); return { id: `job-${started.length}`, name }; },
        kept: async () => null, reported: async () => false, steer: async (job, text) => { steers.push({ job: job.id, text }); },
      },
      checkIn: { view: async () => ({ everyMs: 60 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
      board: async () => ({ v: 2, rev: 1, updatedAt: "", todos: [], plan: [] }),
      fixLive: async () => false,
    });
    await duties.tick();
    await duties.settled();
    assert.deepEqual(started, [], "the live 10:18 job keeps the duty, so the push starts no 11:58 job");
    assert.equal(steers.length, 1);
    assert.equal(steers[0]!.job, OLD.id, "the push run's pages go to the live 10:18 job");
    assert.match(steers[0]!.text, /12 flagged items/);
    const newest = (await store.runs(CHAT))[0]!;
    assert.equal(newest.trigger, "push");
    assert.match(newest.summary, /previous run still working \(job wiki dream AI harness developer environment 10:18, an older job of this duty\); handed it 12 new flagged items$/);

    live.delete(OLD.id);
    now += 61 * MIN;
    await duties.tick();
    await duties.settled();
    assert.equal(started.length, 1, "once the 10:18 job ends, the next push starts a job for what it left");
    duties.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
