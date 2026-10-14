import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { DutyChat, DutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { chatPoolPriority, poolPriorities } from "../src/chat-pool-priority.ts";
import { dutyAdmitter } from "../src/chat-turn-queue.ts";
import { AGENT_EVERY_MIN_MINUTES, agentScheduleProblem, type Duty, type DutyJobRef, MORNING_BANDS, morningTime, parseDutyInput, upsertDuty } from "../src/shared/chat-duties.ts";
import type { ChatAgent, PoolPriority, Priority, SessionRow } from "../src/shared/types.ts";

// c66 (owner, 2026-10-14 02:20Z): "when creating duty it should kind of default to daily at some random morning time ... we're gonna keep these
// ops stuff a daily duty", then "also remember the priority system?". A duty with no schedule gets a free morning minute in its chat's band,
// an agent may not run a duty more often than daily, and the card shows each duty's priority.

const component = join(import.meta.dirname, "..");
const clock = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const minuteOf = (at: string): number => Number(at.slice(0, 2)) * 60 + Number(at.slice(3));
const definition = (extra: Record<string, unknown> = {}) => ({ name: "CI system", ownerWords: "keep CI green", goal: "CI stays green.", onMiss: "Fix the red check.",
  metrics: [{ key: "red_runs", label: "Red runs", op: "<=", target: 0 }], precheck: { command: ["node", "-e", "0"], cwd: "." }, ...extra });

test("morning bands: high 06:00-07:39, normal 07:40-09:19, low 09:20-10:59, and the agent limit is one day", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(MORNING_BANDS).map(([priority, [start, end]]) => [priority, `${clock(start)}-${clock(end)}`])),
    { high: "06:00-07:39", normal: "07:40-09:19", low: "09:20-10:59" });
  assert.equal(AGENT_EVERY_MIN_MINUTES, 1440);
});

test("morningTime: a uniformly random free minute in the priority's band, never a taken one", () => {
  for (const priority of ["high", "normal", "low"] as const) {
    const [start, end] = MORNING_BANDS[priority];
    assert.equal(morningTime(new Set(), priority, () => 0), clock(start));
    assert.equal(morningTime(new Set(), priority, () => 0.999_999), clock(end));
    const taken = new Set(Array.from({ length: end - start + 1 }, (_, index) => clock(start + index)).filter((_, index) => index % 3 !== 0));
    for (let draw = 0; draw < 200; draw++) {
      const at = morningTime(taken, priority, Math.random);
      assert.ok(minuteOf(at) >= start && minuteOf(at) <= end, `${priority} ${at}`);
      assert.ok(!taken.has(at), `${priority} ${at} is taken`);
    }
  }
});

test("morningTime: a full band spills to the first free minute after it inside the window", () => {
  const fill = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => clock(from + index));
  assert.equal(morningTime(new Set(fill(360, 459)), "high", Math.random), "07:40");
  assert.equal(morningTime(new Set([...fill(360, 459), "07:40", "07:41"]), "high", Math.random), "07:42");
  assert.equal(morningTime(new Set(fill(460, 559)), "normal", Math.random), "09:20");
  const at = morningTime(new Set(fill(360, 659)), "low", () => 0.5);
  assert.ok(minuteOf(at) >= 560 && minuteOf(at) <= 659, `a full window shares a low band minute, got ${at}`);
});

test("upsertDuty: a duty with no schedule is daily at the morning time; an update with no schedule keeps the old schedule", () => {
  const duties: Duty[] = [];
  assert.equal(upsertDuty(duties, definition(), 1, "06:37"), "added d1");
  assert.deepEqual(duties[0]!.schedule, { kind: "daily", at: "06:37" });
  duties[0]!.schedule = { kind: "daily", at: "08:15" };
  assert.equal(upsertDuty(duties, definition({ goal: "CI stays green all day." }), 2, "09:59"), "updated d1");
  assert.deepEqual(duties[0]!.schedule, { kind: "daily", at: "08:15" }, "the duty keeps its time");
  assert.equal(upsertDuty(duties, definition({ goal: "CI stays green all day." }), 3, "10:01"), "unchanged d1");
  assert.throws(() => upsertDuty([], definition(), 1), /schedule/, "no schedule and no morning time");
  assert.throws(() => parseDutyInput(definition(), "d1", 0), /schedule/);
});

test("agentScheduleProblem: every N minutes under a day is refused with c66 in plain words; weekly and daily pass", () => {
  for (const minutes of [10, 60, 120, 1439]) assert.match(agentScheduleProblem({ kind: "every", minutes }) ?? "", /^c66: the owner keeps duties daily \("we're gonna keep these ops stuff a daily duty"\)/);
  assert.match(agentScheduleProblem({ kind: "every", minutes: 10 })!, /leave out schedule for a random morning time, or give \{ kind: daily, at: HH:MM \}/);
  for (const schedule of [{ kind: "every", minutes: 1440 }, { kind: "every", minutes: 10080 }, { kind: "daily", at: "06:00" }] as const) assert.equal(agentScheduleProblem(schedule), null);
});

async function dataDir(labels: Record<string, Priority>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "duty-daily-"));
  await writeFile(join(dir, "labels.json"), JSON.stringify({ tags: [], threads: Object.fromEntries(Object.entries(labels).map(([id, priority]) => [id, { tags: [], priority, progress: "none" }])) }));
  return dir;
}
async function add(dir: string, chatId: string, value: unknown): Promise<{ code: number; out: string }> {
  const file = join(dir, `${chatId}-${Math.random().toString(36).slice(2)}.duty.json`);
  await writeFile(file, JSON.stringify(value));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/duties/add.ts", chatId, file, "--data-dir", dir], { cwd: component });
    return { code: 0, out: stdout };
  } catch (error) {
    const failed = error as { code?: number; stderr?: string };
    return { code: failed.code ?? 1, out: failed.stderr ?? "" };
  }
}

test("add.ts: no schedule gets a free morning minute in the chat's band and prints it with the priority; every under a day is refused, weekly is fine", async () => {
  const dir = await dataDir({ lowchat: 1, highchat: 3, normalchat: 2 });
  const store = new DutyStore(dir);
  const taken: string[] = [];
  for (let minute = 560; minute <= 659; minute++) if (minute !== 600) taken.push(clock(minute));
  await mkdir(join(dir, "duties"), { recursive: true });
  await store.update("otherchat", duties => { taken.forEach((at, index) => duties.push({ ...parseDutyInput(definition({ schedule: { kind: "daily", at } }), `d${index + 1}`, 0), name: `Other ${index}` })); });

  const low = await add(dir, "lowchat", definition());
  assert.equal(low.code, 0, low.out);
  assert.equal(low.out.trim(), `added d1 "CI system" in lowchat daily 10:00, priority low`, "the only free low minute");
  const high = await add(dir, "highchat", definition());
  assert.match(high.out.trim(), /^added d1 "CI system" in highchat daily (06:\d\d|07:[0-3]\d), priority high$/);
  const plain = await add(dir, "plainchat", definition());
  assert.match(plain.out.trim(), /^added d1 "CI system" in plainchat daily (06:\d\d|07:[0-3]\d), priority high$/, "an unlabelled chat ranks high");
  const normal = await add(dir, "normalchat", definition());
  assert.match(normal.out.trim(), /^added d1 "CI system" in normalchat daily (07:[4-5]\d|08:\d\d|09:[01]\d), priority normal$/);
  const again = await add(dir, "normalchat", definition());
  assert.equal(again.out.trim(), normal.out.trim().replace("added", "unchanged"), "a second add keeps the time");

  for (const minutes of [10, 60, 120]) {
    const refused = await add(dir, "normalchat", definition({ name: "Crawler system", schedule: { kind: "every", minutes } }));
    assert.equal(refused.code, 1, `every ${minutes}`);
    assert.match(refused.out, /c66: the owner keeps duties daily/);
  }
  assert.equal((await store.list("normalchat")).length, 1, "a refused duty is not stored");
  const weekly = await add(dir, "normalchat", definition({ name: "Crawler system", schedule: { kind: "every", minutes: 10080 } }));
  assert.equal(weekly.out.trim(), `added d2 "Crawler system" in normalchat every 10080 min, priority normal`);
});

const fakeJobs = (): DutyJobHost => ({
  async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "dev VP", cwd: "/repo", board: `/boards/${chatId}.json` }; },
  async working() { return false; },
  async start(_chat, name): Promise<DutyJobRef> { return { id: "s1", name }; },
  async retire() {},
});

test("Duties.view: each duty carries its chat's priority; without a source it is high, as for an unlabelled chat", async () => {
  const store = new DutyStore(await mkdtemp(join(tmpdir(), "duty-daily-view-")));
  await store.update("chat1", duties => { duties.push(parseDutyInput(definition({ schedule: { kind: "daily", at: "09:30" } }), "d1", 0)); });
  const labelled = new Duties(store, { isChat: async () => true, jobs: fakeJobs(), tickMs: 0, priority: async id => id === "chat1" ? "low" : "high" });
  assert.deepEqual((await labelled.view("chat1")).map(view => [view.duty.id, view.priority]), [["d1", "low"]]);
  const plain = new Duties(store, { isChat: async () => true, jobs: fakeJobs(), tickMs: 0 });
  assert.deepEqual((await plain.view("chat1")).map(view => view.priority), ["high"]);
});

test("chatPoolPriority: Low, Medium and High labels map to low, normal and high; no label is high", () => {
  assert.deepEqual(([0, 1, 2, 3] as const).map(chatPoolPriority), ["high", "low", "normal", "high"]);
});

const row = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name: id, cwd: "/w", kind: "live", status: "idle", archived: false, messageCount: 1, working: false,
  subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", origin: "agent", ...extra });
const root = (sessionId: string): ChatAgent => ({ key: "thread:" + sessionId, sessionId, name: sessionId, job: sessionId, sender: sessionId, link: "root", state: "idle", steps: [] });

test("a duty job stays low when its chat is labelled High and links it as root, and the duty admitter asks for the low class", async () => {
  const rows = [row("vp", { chat: true, origin: "user", priority: 3, agents: [root("duty"), root("job")] }), row("duty"), row("job")];
  assert.deepEqual(Object.fromEntries(poolPriorities(rows, new Set(["duty"]))), { vp: "high", duty: "low", job: "high" });
  const asked: string[] = [];
  const admitter = dutyAdmitter({ log: () => {}, pool: { admit: async (session: string, _tree: string, priority: PoolPriority) => { asked.push(`${session} ${priority}`); return "admitted"; },
    release: async () => {}, read: async () => ({ working: [], queued: [] }) as never } });
  await admitter.admit("vp", "d1");
  await admitter.admit("vp", "checkin");
  assert.deepEqual(asked, ["duty:vp:d1 low", "duty:vp:checkin low"]);
});
