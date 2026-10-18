import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord } from "../src/chat-checkin.ts";
import { type ChatThreads, type CheckInSource } from "../src/chat-sources.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { checkInSettings } from "../src/checkin-settings.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { JOB_NOTICE_PREFIX } from "../src/shared/chat-feed.ts";
import type { ChatBoard, ChildAgent, PlanItem } from "../src/shared/types.ts";

/**
 * Ops guy 10-15: job "limits duty drops complete" was cancelled at 09:45Z after a final report that said its work was done, and p233 stayed
 * doing for 8 h; job "check in duty green" ended at 10:42Z and left p247 waiting on the next check-in, which no job watched. The 10:50Z
 * check-in found both stuck. A job whose turn ends while open steps name it is now told to the chat at once, with each step.
 */
const CHAT = "01a11af8-962e-773d-a19a-ee4104011987";
const NOW = Date.parse("2026-10-15T10:42:00.000Z");
const step = (id: string, text: string, job: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "doing", job, children: [], ...extra });

async function setup(board: ChatBoard, waking: ReadonlySet<string> = new Set(), busy = () => false) {
  const dir = await mkdtemp(join(tmpdir(), "open-steps-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const prompts: string[] = [];
  const threads = {
    state: () => undefined, async view() { return null; }, busy, running: () => false, setWait() {}, isLive: () => false,
    async restart() {}, async prompt(_id: string, input: { message: string }) { prompts.push(input.message); }, async notice() {}, async deleteSubagent() {},
    pin: () => true, unpin() {}, async setSteeringMode() {}, async heartbeat() { return undefined; }, async clearHeartbeat() {}, async reload() {},
    observe() { return () => {}; },
  } as unknown as ChatThreads;
  const source: CheckInSource = {
    board: async () => board, rows: async () => [], memory: checkInRecord(join(dir, "check-ins.json")), settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now: () => NOW, noReportGraceMs: 0, waking: async session => waking.has(session),
  };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source);
  const roster = chats as unknown as { roster(children: ReadonlyMap<string, readonly ChildAgent[]>): Promise<void> };
  const run = async (...states: ChildAgent[][]) => {
    for (const children of states) await roster.roster(new Map([[CHAT, children]]));
    await new Promise(resolve => setTimeout(resolve, 20));
    await chats.settled();
    chats.close();
    return prompts.filter(prompt => prompt.includes("open step"));
  };
  return { run };
}
const job = (name: string, status: ChildAgent["status"], extra: Partial<ChildAgent> = {}): ChildAgent =>
  ({ id: `child-${name}`, label: name, sessionName: name, sessionId: `s-${name}`, status, repliedSinceTask: true, lastActivityAt: NOW - 60_000, ...extra });

test("a job cancelled after its report, and a job that ended on a wait no job watches, are each told to the chat with their open step (ops guy 10-15, p233 and p247)", async () => {
  const board: ChatBoard = { plan: [
    step("p233", "Each limits duty drop updates every caller and test and passes", "limits duty drops complete"),
    step("p247", "Check-in stops missing on steps whose wait already ended", "check in duty green",
      { waitFor: "the next check-in, which runs on release-379933e (5b3f217 and 241121b live since 18:52 KST), reads met" }),
  ], todos: [] } as unknown as ChatBoard;
  const { run } = await setup(board);
  const told = await run(
    [job("limits duty drops complete", "running"), job("check in duty green", "running")],
    [job("limits duty drops complete", "cancelled"), job("check in duty green", "done")],
  );
  assert.equal(told.length, 2, told.join("\n"));
  const [limits, green] = [told.find(line => line.includes("limits duty drops complete"))!, told.find(line => line.includes("check in duty green"))!];
  assert.ok(limits.startsWith(JOB_NOTICE_PREFIX) && limits.includes("was cancelled") && limits.includes("p233") && limits.includes("is doing"), limits);
  assert.ok(green.includes("ended its turn") && green.includes("p247") && green.includes("waits for \"the next check-in"), green);
  assert.ok(green.includes("close each step whose work is done, steer the job, or start a fresh job"), green);
});

test("no notice for a job asleep on a board.wake, a job whose step is closed, or a step another working job owns", async () => {
  const board: ChatBoard = { plan: [
    step("p1", "Land the fix", "waker", { waitFor: "run 38710385686 green" }),
    step("p2", "Closed on the report", "closer", { status: "done" }),
    step("p3", "Owned by a live job, its note names the ended one", "live one", { note: "after closer's land" }),
  ], todos: [] } as unknown as ChatBoard;
  const { run } = await setup(board, new Set(["s-waker"]));
  const told = await run(
    [job("waker", "running"), job("closer", "running"), job("live one", "running")],
    [job("waker", "done"), job("closer", "done"), job("live one", "running")],
    [job("waker", "done"), job("closer", "done"), job("live one", "running", { lastActivityAt: NOW })],
  );
  assert.deepEqual(told, []);
});
