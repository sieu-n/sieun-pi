// Guards the read of a duty red only on windowed counts once their events leave the window. Crawler VP's d6 read
// health_snapshot_down_minutes_24h 16 and api_down_minutes_24h 1 at 21:17Z on 10-25, with the newest down minutes at 18:16Z and 10:49Z, and
// p995 held a live fix job. A red duty with a live fix gets no push run, so nothing read d6 again before its 21:20Z slot on 10-26, and d9
// counted it red from 18:16Z, when both counts had emptied, to that slot. ops guy's d3 waited the same way from 12:06Z on 10-27 to 23:46Z.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { agedOut, countWindowMs } from "../src/duty-push.ts";
import { dailySlot, type Duty, type DutyRunRecord, type MetricResult } from "../src/shared/chat-duties.ts";
import type { ChatBoard, CheckInView } from "../src/shared/types.ts";

const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const MIN = 60_000;
const at = (time: string) => Date.parse(`2026-10-${time}Z`);
const COUNTED = new Set(["prod_routes_and_mcp_tools_failing", "api_down_minutes_24h", "health_snapshot_down_minutes_24h"]);
const count = (value: number, lastEventAt?: number): MetricResult => ({ value, target: 0, op: "<=", met: value <= 0, ...lastEventAt ? { lastEventAt } : {} });
const metrics = { prod_routes_and_mcp_tools_failing: count(0), api_down_minutes_24h: count(1, at("25T10:49:00")),
  health_snapshot_down_minutes_24h: count(16, at("25T18:16:00")) };
const JOB = { id: "01a174ed-4953-73ab-b688-8e81cb02c640", name: "crawler api and mcp Crawler VP 06:17" };
const red: DutyRunRecord = { duty: "d6", at: at("25T21:17:00"), slot: at("25T21:17:00"), trigger: "push", ms: 25_360, verdict: "missed", metrics,
  summary: "api_down_minutes_24h 1 min (target at most 0 min), health_snapshot_down_minutes_24h 16 min (target at most 0 min)", job: JOB,
  after: { at: at("25T21:40:00"), verdict: "missed", metrics, summary: "" } };

test("a window comes from the key's _<n>m, _<n>h or _<n>d part", () => {
  assert.equal(countWindowMs("health_snapshot_down_minutes_24h"), 24 * 60 * MIN);
  assert.equal(countWindowMs("probe_uptime_24h_pct"), 24 * 60 * MIN);
  assert.equal(countWindowMs("repeat_corrections_7d"), 7 * 24 * 60 * MIN);
  assert.equal(countWindowMs("crawler_risks_firing"), undefined);
});

test("d6 of 10-25 reads aged out once its newest down minute is 24 h old, and only until a run reads it again", () => {
  assert.equal(agedOut([red], COUNTED, at("26T18:15:59")), undefined, "the 18:16Z down minute still counts");
  assert.equal(agedOut([red], COUNTED, at("26T18:16:00")), at("26T18:16:00"));
  const reread: DutyRunRecord = { duty: "d6", at: at("26T18:16:30"), trigger: "push", ms: 25_000, verdict: "met", summary: "", metrics: {} };
  assert.equal(agedOut([reread, red], COUNTED, at("26T18:20:00")), undefined);
});

test("a miss that is no windowed count, or a count with no newest event, keeps the duty off the aged read", () => {
  const failing = { ...metrics, prod_routes_and_mcp_tools_failing: count(2) };
  assert.equal(agedOut([{ ...red, after: { ...red.after!, metrics: failing } }], COUNTED, at("27T00:00:00")), undefined);
  const unread = { ...metrics, health_snapshot_down_minutes_24h: count(16) };
  assert.equal(agedOut([{ ...red, after: { ...red.after!, metrics: unread } }], COUNTED, at("27T00:00:00")), undefined);
});

test("the runner reads d6 again at 18:16Z despite p995's live fix job, and the met run starts no job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-push-aged-"));
  try {
    const precheck = join(dir, "precheck.mjs");
    await writeFile(precheck, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: ` +
      `{ prod_routes_and_mcp_tools_failing: 0, api_down_minutes_24h: 0, health_snapshot_down_minutes_24h: 0 } }));`);
    const store = new DutyStore(dir);
    let now = at("26T18:00:00");
    const duty: Duty = {
      id: "d6", name: "Crawler API and MCP", ownerWords: "the API and MCP stay up", goal: "no down minute",
      metrics: [{ key: "prod_routes_and_mcp_tools_failing", label: "Failing routes", op: "<=", target: 0, headline: true },
        { key: "api_down_minutes_24h", label: "API down minutes", op: "<=", target: 0 },
        { key: "health_snapshot_down_minutes_24h", label: "Health down minutes", op: "<=", target: 0 }],
      schedule: { kind: "daily", at: "06:20" }, precheck: { command: ["node", precheck], cwd: dir, timeoutMs: 30_000 }, onMiss: "fix it",
      status: "active", createdAt: at("20T00:00:00"), updatedAt: at("20T00:00:00"), runCount: 31, lastSlotAt: dailySlot("06:20", now), lastRunAt: red.at,
    };
    await store.update(CHAT, duties => { duties.push(duty); });
    await store.appendRun(CHAT, red);
    const board = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p995", text: "Stop the health snapshot down minutes", status: "doing",
      duty: "d6/health_snapshot_down_minutes_24h", job: "health snapshot root cause", children: [] }] } as unknown as ChatBoard;
    const started: string[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "Crawler VP", cwd: dir, board: id }),
        working: async () => false, retire: async () => {},
        start: async (_chat, name) => { started.push(name); return { id: `job-${started.length}`, name }; },
      },
      checkIn: { view: async () => ({ everyMs: 60 * MIN }) as CheckInView, set: async () => null, run: async () => {} },
      board: async () => board, fixLive: async () => true,
    });

    await duties.tick();
    await duties.settled();
    assert.equal((await store.runs(CHAT)).length, 1, "at 18:00Z p995's live fix keeps the push off");

    now = at("26T18:16:30");
    await duties.tick();
    await duties.settled();
    const newest = (await store.runs(CHAT))[0]!;
    assert.equal(newest.trigger, "push");
    assert.equal(newest.verdict, "met");
    assert.deepEqual(started, [], "the met run has nothing due");

    now += 10 * MIN;
    await duties.tick();
    await duties.settled();
    assert.equal((await store.runs(CHAT)).length, 2, "one read per age-out");
    duties.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
