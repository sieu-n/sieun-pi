import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyJobHost } from "../src/chat-duty-job.ts";
import { type CheckInRun, Duties, STILL_WORKING } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { jobRegistry } from "../src/chat-sources.ts";
import { dutyDue, parseDutyInput } from "../src/shared/chat-duties.ts";
import type { SessionRow } from "../src/shared/types.ts";

// 10-12 16:07 to 16:27Z: after two service restarts the daemon's full list timed out at 30 s, the catalog had no rows, and 14 duty runs of 7
// chats in chats.json skipped with "the catalog does not list the chat", each losing its slot's job.
const at = (day: number, hours: number, minutes = 0): number => new Date(2026, 9, day, hours, minutes).getTime();
const LIST_TIMEOUT = 'Timed out after 30000ms waiting for the Prime Agent daemon response to "list".';
const row = (id: string, name: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name, cwd: "/repo/sieun-pi", kind: "live", status: "idle", archived: false,
  messageCount: 2, working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", ...extra });

/** A catalog that starts empty, as after a restart, and whose full list times out until `answers` is set; the real duty job host reads it. */
async function slowCatalog() {
  const dir = await mkdtemp(join(tmpdir(), "duty-catalog-wait-"));
  const state = { rows: [] as SessionRow[], daemon: [row("chat1", "dev VP")] as SessionRow[], answers: false, refreshes: 0, calls: [] as string[],
    gate: undefined as Promise<void> | undefined };
  let next = 0;
  const jobs = dutyJobHost({ rows: async () => state.rows, registry: jobRegistry(join(dir, "chat-jobs.json")), board: id => `/data/boards/${id}.json`,
    archives: { async add(job) { state.calls.push(`archive ${job.id}`); } },
    refresh: async () => {
      state.refreshes++;
      await state.gate;
      if (!state.answers) throw new Error(LIST_TIMEOUT);
      state.rows = state.daemon;
    },
    threads: { async create(input) { const id = `job-${++next}`; state.calls.push(`create ${input.name} ${id}`); return { id }; }, async prompt() {} } });
  return { dir, state, jobs };
}

const output = `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { orphans: 0 }, flagged: [] }))`;
const standing = (createdAt: number) => parseDutyInput({ name: "Chat system", ownerWords: "keep it healthy", goal: "Chats never sit stopped.", onMiss: "Start a job that reads the details.",
  metrics: [{ key: "orphans", label: "Orphan steps", op: "<=", target: 0 }], schedule: { kind: "daily", at: "23:07" },
  precheck: { command: ["node", "-e", output], cwd: tmpdir() } }, "d1", createdAt);

test("duty job host: a chat with no row lists the daemon's sessions once and looks again; a list that fails rejects, and a chat the list does not show is null", async () => {
  const { state, jobs } = await slowCatalog();
  await assert.rejects(jobs.chat("chat1"), /the catalog cannot list the chat: Timed out after 30000ms/);
  state.answers = true;
  assert.deepEqual(await jobs.chat("chat1"), { id: "chat1", name: "dev VP", cwd: "/repo/sieun-pi", board: "/data/boards/chat1.json" });
  assert.equal(state.refreshes, 2);
  await jobs.chat("chat1");
  assert.equal(state.refreshes, 2, "a listed chat needs no list");
  assert.equal(await jobs.chat("gone"), null, "a chat the daemon's list does not show is gone");
});

test("Duties: a scheduled run waits while the catalog cannot list its chat, records nothing and keeps its slot due; the next tick after the list answers starts the slot's job", async () => {
  const now = { at: at(12, 23, 7) };
  const { dir, state, jobs } = await slowCatalog();
  const store = new DutyStore(dir);
  await store.update("chat1", duties => { duties.push(standing(at(11, 12))); });
  await store.update("gone", duties => { duties.push(standing(at(11, 12))); });
  state.daemon = [row("chat1", "dev VP")];
  const lines: string[] = [];
  const duties = new Duties(store, { isChat: async () => true, jobs, now: () => now.at, tickMs: 0, log: line => lines.push(line) });
  let release = () => {};
  state.gate = new Promise<void>(resolve => { release = resolve; });
  await duties.tick();
  now.at = at(12, 23, 7) + 30_000;
  await duties.tick();
  release();
  await duties.settled();
  state.gate = undefined;
  assert.deepEqual(await store.runs("chat1"), [], "no measure and no skip while the list times out, and no 'still going' skip from the tick during the wait");
  assert.equal((await store.list("chat1"))[0]!.lastSlotAt, undefined);
  assert.equal(dutyDue((await store.list("chat1"))[0]!, now.at).kind, "run", "the slot stays due");
  assert.ok(lines.some(line => line.includes("chat1/d1: waits for the catalog: the catalog cannot list the chat")), lines.join("\n"));
  state.answers = true;
  now.at = at(12, 23, 8);
  await duties.tick();
  await duties.settled();
  const [run] = await store.runs("chat1");
  assert.deepEqual([run?.verdict, run?.slot, run?.job?.name], ["met", at(12, 23, 7), "chat system dev VP 23:08"], JSON.stringify(run));
  const [gone] = await store.runs("gone");
  assert.match(gone?.summary ?? "", /; skipped: the catalog does not list the chat$/, "a chat the daemon's list does not show still skips");
  duties.close();
});

test("check-in: a run while the catalog cannot list the chat fails so the chat retries it, and once listed a job that still works is kept, not retired", async () => {
  const { dir, state, jobs } = await slowCatalog();
  const store = new DutyStore(dir);
  const now = at(12, 18);
  const run = (minutes: number): CheckInRun => ({ at: now + minutes * 60_000, trigger: "schedule", everyMs: 15 * 60_000, output: { metrics: {}, flagged: [] }, classes: {}, findings: "" });
  state.answers = true;
  state.rows = state.daemon;
  const first = new Duties(store, { isChat: async () => true, jobs, tickMs: 0, now: () => now });
  assert.equal(await first.checkIn("chat1", run(0)), "done");
  assert.deepEqual(state.calls, ["create check-in dev VP 18:00 job-1"]);
  first.close();
  // The service restarts: an empty catalog, a daemon whose full list times out, and the check-in job still at work.
  state.rows = [];
  state.answers = false;
  state.daemon = [row("chat1", "dev VP"), row("job-1", "check-in dev VP 18:00", { working: true })];
  const duties = new Duties(store, { isChat: async () => true, jobs, tickMs: 0, now: () => now });
  assert.equal(await duties.checkIn("chat1", run(15)), "failed", "a failed start, which Chats retries in CHECK_IN_RETRY_MS");
  state.answers = true;
  assert.equal(await duties.checkIn("chat1", run(20)), "done");
  assert.deepEqual(state.calls, ["create check-in dev VP 18:00 job-1"], "the working job is neither retired nor replaced");
  const latest = (await store.runs("chat1"))[0];
  assert.deepEqual([latest?.verdict, latest?.summary], ["skipped", `${STILL_WORKING} (job check-in dev VP 18:00)`]);
  duties.close();
});
