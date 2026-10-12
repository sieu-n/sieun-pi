import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DutyChat, type DutyJobHost, dutyJobHost } from "../src/chat-duty-job.ts";
import { Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { jobRegistry } from "../src/chats.ts";
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
    async ended(jobs) { if (jobs.length) calls.push(`ended? ${jobs.map(job => job.id).join(",")}`); return jobs.filter(job => ended.has(job.id)); },
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
});
