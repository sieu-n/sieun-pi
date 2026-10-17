import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DutyChat, type DutyJobHost, dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { jobRegistry } from "../src/chat-sources.ts";
import { type DutyJobRef, parseDutyInput } from "../src/shared/chat-duties.ts";
import type { SessionRow } from "../src/shared/types.ts";

// A duty job whose turn ended kept its worker and Python kernel until the next run of its duty retired it. 10-13 00:10 KST: 6 ended duty jobs
// held 1.9 GB on a 32 GB Mac with 30.4 of 30.7 GB swap used, and while the daemon gate paused check-ins the 22:15 to 22:33 check-in jobs
// stayed up 88 to 102 min. The runner now queues the archive of each duty's last job once its turn ends.

const at = (day: number, hours: number, minutes = 0): number => new Date(2026, 9, day, hours, minutes).getTime();
const writeOutput = `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { orphans: 0 }, flagged: [] }))`;

function fakeJobs() {
  const calls: string[] = [];
  const ended = new Set<string>();
  let next = 0;
  const host: DutyJobHost = {
    async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "dev VP", cwd: "/repo", board: `/boards/${chatId}.json` }; },
    async working(job) { return !ended.has(job.id); },
    async start(chat, name): Promise<DutyJobRef> { const id = `s${++next}`; calls.push(`start ${id}`); return { id, name }; },
    async retire(job) { calls.push(`retire ${job.id}`); },
    async ended(last, older = []) {
      if (last.length || older.length) calls.push(`ended? ${last.map(job => job.id).join(",")}${older.length ? ` older ${older.map(job => job.id).join(",")}` : ""}`);
      return [...last, ...older].filter(job => ended.has(job.id));
    },
    async stop(job) { calls.push(`stop ${job.id}`); },
  };
  return { host, calls, ended };
}

test("Duties: a duty job whose turn ended is archived on the next tick, once, not at the next run of its duty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-stop-"));
  const store = new DutyStore(dir);
  const jobs = fakeJobs();
  const now = { at: at(8, 23, 7) };
  await store.update("chat1", duties => {
    duties.push({ ...parseDutyInput({ name: "Local dev servers", ownerWords: "keep them up", goal: "Dev servers answer.", onMiss: "Fix the server that is down.", metrics: [{ key: "orphans", label: "Down", op: "<=", target: 0 }],
      schedule: { kind: "every", minutes: 10 }, precheck: { command: ["node", "-e", writeOutput], cwd: tmpdir() } }, "d1", now.at - 10 * 60_000) });
  });
  const lines: string[] = [];
  const duties = new Duties(store, { isChat: async id => id === "chat1", jobs: jobs.host, now: () => now.at, tickMs: 0, log: line => lines.push(line) });
  await duties.tick();
  await duties.settled();
  assert.deepEqual(jobs.calls, ["start s1"], "a run going is left to that run");
  now.at += 60_000;
  await duties.tick();
  assert.deepEqual(jobs.calls.slice(1), ["ended? s1"], "a job still at work is not stopped");
  jobs.ended.add("s1");
  now.at += 60_000;
  await duties.tick();
  assert.deepEqual(jobs.calls.slice(2), ["ended? s1", "stop s1"], "the job whose turn ended is archived before its duty runs again");
  assert.ok(lines.includes("duty job local dev servers dev VP 23:07: its turn ended; queued its archive"), lines.join("\n"));
  now.at += 60_000;
  await duties.tick();
  assert.deepEqual(jobs.calls.slice(4), [], "each job is queued once");
  now.at = at(8, 23, 17);
  await duties.tick();
  await duties.settled();
  assert.deepEqual(jobs.calls.slice(4), ["retire s1", "start s2"], "the next run still unregisters the last job and starts its own");
  now.at += 60_000;
  await duties.tick();
  assert.deepEqual(jobs.calls.slice(6), ["ended? s2"], "a stopped older job is not looked at again");
});

test("Duties: an older duty job a later run retired but that is still up is archived too (local dev servers 22:24 of 10-10, still loaded 10-13)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-stop-older-"));
  const store = new DutyStore(dir);
  const jobs = fakeJobs();
  const record = (job: string, minute: number) => ({ duty: "d1", at: at(10, 22, minute), slot: at(10, 22, minute), trigger: "schedule" as const, ms: 0,
    verdict: "met" as const, metrics: {}, summary: "all on target", job: { id: job, name: `local dev servers dev VP 22:${minute}` } });
  await store.appendRun("chat1", record("old-1", 24));
  await store.appendRun("chat1", record("old-2", 34));
  const { job: _none, ...skipped } = record("old-2", 44);
  await store.appendRun("chat1", { ...skipped, verdict: "skipped" });
  await store.appendRun("chat1", record("new", 54));
  await store.update("chat1", duties => { duties.push({ ...parseDutyInput({ name: "Local dev servers", ownerWords: "keep them up", goal: "Dev servers answer.",
    onMiss: "Fix it.", metrics: [{ key: "orphans", label: "Down", op: "<=", target: 0 }], schedule: { kind: "every", minutes: 10 },
    precheck: { command: ["node", "-e", "0"], cwd: tmpdir() } }, "d1", at(10, 22)), lastRunAt: at(13, 0, 30) }); });
  const lines: string[] = [];
  const duties = new Duties(store, { isChat: async id => id === "chat1", jobs: jobs.host, now: () => at(13, 0, 31), tickMs: 0, log: line => lines.push(line) });
  jobs.ended.add("old-1");
  await duties.tick();
  assert.deepEqual(jobs.calls, ["ended? new older old-2,old-1", "stop old-1"], "the newest job is judged as the last one, the older ones as leftovers");
  assert.ok(lines.includes("duty job local dev servers dev VP 22:24: an older job still up; queued its archive"), lines.join("\n"));
  await duties.tick();
  assert.deepEqual(jobs.calls.slice(2), ["ended? new older old-2"]);
});

test("duty job host: ended lists the jobs past their brief whose turn stopped, with one catalog read; working, archived, gone, unbriefed and failed jobs stay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-stop-host-"));
  const row = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name: id, cwd: "/repo", kind: "live", status: "idle", archived: false,
    messageCount: 4, working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...extra });
  const rows = [row("done"), row("busy", { working: true }), row("archived", { archived: true }), row("briefed", { messageCount: 1 }),
    row("failed", { failure: "Request was aborted" })];
  let reads = 0;
  const queued: string[] = [];
  const host = dutyJobHost({ rows: async () => { reads++; return rows; }, registry: jobRegistry(join(dir, "chat-jobs.json")), board: id => `/b/${id}.json`,
    archives: { async add(job) { queued.push(job.id); } }, threads: { async create() { return { id: "x" }; }, async prompt() {} } });
  const ref = (id: string): DutyJobRef => ({ id, name: id });
  const ended = await host.ended!(["done", "busy", "archived", "briefed", "failed", "gone"].map(ref));
  assert.deepEqual(ended.map(job => job.id), ["done"]);
  assert.equal(reads, 1);
  assert.deepEqual(await host.ended!([]), []);
  assert.equal(reads, 1, "no jobs, no catalog read");
  await host.stop!(ref("done"));
  assert.deepEqual(queued, ["done"], "a stop goes through the archive queue");
  const older = await host.ended!([], ["done", "busy", "archived", "briefed", "failed", "gone"].map(ref));
  assert.deepEqual(older.map(job => job.id), ["done", "briefed", "failed"], "an older job that is up and not working is archived whatever its messages or failure");
});

test("duty job host: a create refused for a taken name does not adopt an older session of that name; it creates the dated name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-stop-adopt-"));
  const old: SessionRow = { id: "01a125fc", name: "local dev servers dev VP 22:24", cwd: "/repo", kind: "live", status: "idle", archived: false, created: new Date(at(10, 22, 24)).toISOString(),
    messageCount: 13, working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none" };
  const creates: string[] = [];
  const host = dutyJobHost({ rows: async () => [old], registry: jobRegistry(join(dir, "chat-jobs.json")), board: id => `/b/${id}.json`, lookupWaitsMs: [0],
    now: () => at(12, 22, 24), archives: { async add() {} }, sleep: async () => {}, threads: {
      async create(input) {
        creates.push(input.name);
        if (input.name === old.name) throw new Error(`Agent name "${old.name}" is unavailable: an agent of that name already exists at depth 0 under this parent`);
        return { id: "fresh" };
      },
      async prompt() {},
    } });
  const job = await host.start({ id: "chat1", name: "dev VP", cwd: "/repo", board: "/b/chat1.json" }, old.name, "brief");
  assert.deepEqual(job, { id: "fresh", name: "local dev servers dev VP 10-12 22:24" });
  assert.deepEqual(creates, [old.name, "local dev servers dev VP 10-12 22:24"], "the 10-10 job is left alone");
});

test("duty job host: a session of the job's name made since the run started is adopted after a restart, not refused as taken (slack green guy 10-17 22:11Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "duty-stop-restart-"));
  const runAt = Date.parse("2026-10-17T22:11:50.915Z");
  const made: SessionRow = { id: "01a14bf0", name: "check-in slack green guy 07:11", cwd: "/repo", kind: "live", status: "idle", archived: false,
    created: "2026-10-17T22:16:50.000Z", messageCount: 0, working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none" };
  const creates: string[] = [];
  const prompts: string[] = [];
  const host = dutyJobHost({ rows: async () => [made], registry: jobRegistry(join(dir, "chat-jobs.json")), board: id => `/b/${id}.json`, lookupWaitsMs: [0],
    now: () => Date.parse("2026-10-17T22:21:16.659Z"), archives: { async add() {} }, sleep: async () => {}, threads: {
      async create(input) {
        creates.push(input.name);
        throw new Error(`Agent name "${input.name}" is unavailable: an agent of that name already exists at depth 0 under this parent`);
      },
      async prompt(id) { prompts.push(id); },
    } });
  const job = await host.start({ id: "chat1", name: "slack green guy", cwd: "/repo", board: "/b/chat1.json" }, made.name, "brief", false, runAt);
  assert.deepEqual(job, { id: "01a14bf0", name: made.name }, "the session the timed-out create made before the restart is the run's own");
  assert.deepEqual([creates, prompts], [[made.name], ["01a14bf0"]]);
});
