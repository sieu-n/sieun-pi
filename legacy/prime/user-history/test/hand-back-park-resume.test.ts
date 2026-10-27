// mac-management 10-22: the chat service handed p24 back to the chat at 01:16Z and 02:17Z as "job metal agent queue reported", while the
// job's last turn had parked on the Claude limit with no output.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { JOB_CLEANUP_EVERY_MS } from "../src/chat-checkin.ts";
import { Chats } from "../src/chats.ts";
import type { CheckInSource } from "../src/chat-sources.ts";
import { lastTurnError } from "../src/held-turns.ts";
import { fileSlotPark } from "../src/slot-park.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes } from "../src/job-resume.ts";
import type { BoardOp, ChatAgent, ChatBoard, ChildAgent, PlanItem, SessionRow, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const CHAT = "01a15427-145f-751d-ba15-d27b6c30f65f";
const JOB = "01a16159-1c35-76dd-abc6-77a8686fe2ff";
const START = Date.parse("2026-10-22T02:04:00Z");

const ok = (at: number) => JSON.stringify({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", stopReason: "stop", content: [] } });
const failed = (at: number) => JSON.stringify({ type: "message", timestamp: new Date(at).toISOString(),
  message: { role: "assistant", stopReason: "error", content: [], errorMessage: "Provider rate limit exceeded (rate_limit_error, 429)" } });
const park = (until: number) => JSON.stringify({ type: "custom", customType: "provider_quota_park", data: { resumeAt: new Date(until).toISOString() } });

/** What keeps a job's steps from the hand back: a slot or quota wait (`fileSlotPark`, read by jobBusy) or a last turn that failed (`lastTurnError`). */
const endsParked = (lines: readonly string[]): boolean => fileSlotPark(lines).park !== undefined || lastTurnError(lines.join("\n")) !== undefined;

test("a turn that failed or parked with no reply after it keeps its steps; a reply after the park does not", () => {
  assert.equal(endsParked([ok(START), failed(START + 1000), park(START + 60_000)]), true);
  assert.equal(endsParked([ok(START), failed(START + 1000)]), true);
  assert.equal(endsParked([ok(START), JSON.stringify({ type: "custom", customType: "pi-pool-queue", data: {} })]), true);
  assert.equal(endsParked([failed(START), park(START + 60_000), JSON.stringify({ type: "custom", customType: "provider_quota_resume" }), ok(START + 70_000)]), false);
  assert.equal(endsParked([ok(START), JSON.stringify({ type: "message", message: { role: "toolResult", content: [] } })]), false);
  assert.equal(endsParked([]), false);
});

interface Rig {
  jobLines: string[];
  plan: PlanItem[];
  agents?: ChatAgent[];
  files?: Record<string, string[]>;
  relays?: Record<string, number>;
  /** How long after the job's last activity the sweep runs. */
  after: number;
}

async function rig(want: Rig) {
  const dir = await mkdtemp(join(tmpdir(), "hand-back-park-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const ops: BoardOp[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  let now = START;
  const files = new Map<string, string>();
  const folder = join(dir, "session-artifacts", CHAT, "sub-a7cae8cf");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "rlm-subagent.json"), JSON.stringify({ prompt: "Tune the metal queue by hand.", createdAt: START - 60_000 }));
  for (const [session, body] of Object.entries({ [JOB]: want.jobLines, ...want.files })) {
    const file = join(dir, `${session}.jsonl`);
    await writeFile(file, body.join("\n") + "\n");
    files.set(session, file);
  }
  files.set(CHAT, join(dir, "sessions", `${CHAT}.jsonl`));
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: want.plan };
  const rows = (): SessionRow[] => [row(CHAT, new Date(START).toISOString(), { chat: true, agents: want.agents ?? [] })];
  const extra: Partial<CheckInSource> = { relayed: { add: async () => {}, at: async session => want.relays?.[session] } };
  const chats = new Chats(index, threads, async id => ({ lifecycle: "live", ...files.has(id) ? { sessionFile: files.get(id)! } : {} }), "b1",
    loadRecord(join(dir, "extension-loads.json")), {
      ...source(dir, {}, () => now, rows), ...extra, board: async () => board, waking: async () => false, wakes: async () => [],
      resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: async (_id: string, batch: readonly BoardOp[]) => { ops.push(...batch); } },
    }, line => lines.push(line));
  await chats.adopt();
  const job: ChildAgent = { id: "sub-a7cae8cf", label: "metal agent queue", sessionName: "metal agent queue", sessionId: JOB, status: "done",
    repliedSinceTask: true, lastActivityAt: START };
  threads.transcripts.set(CHAT, [{ role: "custom", customType: "agent_message", display: true, timestamp: START - 30 * 60_000,
    content: "[agent-message from child:metal agent queue]\nCaught up 19:45Z to 00:45Z: every half hour at 18 slots was out of band." } as ThreadMessage]);
  await chats.roster(new Map([[CHAT, [job]]]));
  threads.fire().live(CHAT, [job]);
  await chats.settled();
  now += want.after;
  await chats.tick();
  await chats.settled();
  return { chats, calls, lines, ops };
}

const p24 = (fields: Partial<PlanItem> = {}): PlanItem => ({ id: "p24", text: "Tune the 60-slot metal queue by hand to 70 to 80% CPU", status: "doing",
  job: "metal agent queue", sessionId: JOB, children: [], ...fields });

test("hand back: a job whose last turn parked on the Claude limit with no output keeps its step", async () => {
  // The park's resume time has passed, so no live park holds the job; only its transcript says the turn never ended.
  const { chats, ops, calls } = await rig({ jobLines: [ok(START - 60_000), failed(START), park(START + 60_000)], plan: [p24()], after: JOB_CLEANUP_EVERY_MS + 60_000 });
  chats.close();
  assert.deepEqual(ops, [], "no relink to the chat");
  assert.equal(calls.some(call => call.includes("its open step is yours now")), false, "no hand-back turn");
});

test("hand back: a job whose last turn ended with a reply still hands its open step back", async () => {
  const { chats, ops } = await rig({ jobLines: [ok(START)], plan: [p24()], after: JOB_CLEANUP_EVERY_MS + 60_000 });
  chats.close();
  assert.equal(ops.length, 1);
  assert.equal((ops[0] as { job?: string }).job, CHAT);
});
