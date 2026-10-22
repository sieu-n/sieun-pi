// Guards mac-management 10-21 and 10-22: the job cleanup ended its jobs "metal agent queue" (20:50Z, 01:47Z) and "5180 into the real app"
// (21:50Z, 01:57Z) as quiet waiting jobs. Each time the job was owed a turn that left no wake file: its wake had gone through the chat, which
// Prime had parked on its quota, or pi-pool held its tree. Each delete cut the job's subagents, and the chat's relays met "No child matches".
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { PARK_IDLE_MS } from "../src/chat-checkin.ts";
import { Chats } from "../src/chats.ts";
import type { CheckInSource } from "../src/chat-sources.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes } from "../src/job-resume.ts";
import type { BoardOp, ChatBoard, ChildAgent, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

const CHAT = "01a15427-145f-751d-ba15-d27b6c30f65f";
const JOB = "01a1610d-e43f-722c-b8e9-0eef812a3bc5";
const BUILDER = "01a16111-964a-712b-a6b6-cb41cb362b17";

interface Owed {
  /** Relay times by session, as `relayed.json` holds them. */
  relays?: Record<string, number>;
  /** Sessions in pool-held.json. */
  pool?: string[];
  /** Sessions the resume pass gives back. */
  turns?: string[];
  /** When Prime resumes the job's quota park, written into its session file. */
  parkUntil?: number;
}

async function sweep(owed: (endedAt: number) => Owed) {
  const dir = await mkdtemp(join(tmpdir(), "job-cleanup-owed-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  let now = Date.parse("2026-10-22T00:52:00Z");
  const endedAt = now;
  const want = owed(endedAt);
  const chatFile = join(dir, "sessions", `${CHAT}.jsonl`);
  const jobFile = join(dir, "session-artifacts", CHAT, "sub-8aea6b3f", `${JOB}.jsonl`);
  await mkdir(join(dir, "session-artifacts", CHAT, "sub-8aea6b3f"), { recursive: true });
  await writeFile(join(dir, "session-artifacts", CHAT, "sub-8aea6b3f", "rlm-subagent.json"), JSON.stringify({ prompt: "Port the 5180 design into apps/search.", createdAt: now - 3_600_000 }));
  await writeFile(jobFile, want.parkUntil === undefined ? "" :
    JSON.stringify({ type: "custom", customType: "provider_quota_park", data: { resumeAt: new Date(want.parkUntil).toISOString() } }) + "\n");
  const poolHeldFile = join(dir, "pool-held.json");
  await writeFile(poolHeldFile, JSON.stringify(want.pool ?? []));
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [
    { id: "p34", text: "5180 design live in the real app on 5174", status: "todo", job: "5180 into the real app", children: [] }] };
  const extra: Partial<CheckInSource> = {
    relayed: { add: async () => {}, at: async session => want.relays?.[session] },
    held: async () => ({ sessions: new Map((want.turns ?? []).map(session => [session, "the chat service's continue after its cut turn (error)"])) }),
    poolHeldFile,
  };
  const chats = new Chats(index, threads, async id => ({ lifecycle: "live", sessionFile: id === JOB ? jobFile : chatFile }), "b1",
    loadRecord(join(dir, "extension-loads.json")), {
      ...source(dir, {}, () => now), ...extra, board: async () => board, waking: async () => false, wakes: async () => [],
      resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: async (_id: string, _ops: readonly BoardOp[]) => {} },
    }, line => lines.push(line));
  await chats.adopt();
  const job: ChildAgent = { id: "sub-8aea6b3f", label: "5180 into the real app", sessionName: "5180 into the real app", sessionId: JOB, status: "done",
    repliedSinceTask: true, lastActivityAt: endedAt };
  const builder: ChildAgent = { id: "sub-c72063ca", label: "email builder", sessionName: "email builder", sessionId: BUILDER, status: "done",
    repliedSinceTask: true, lastActivityAt: endedAt - 60_000 };
  threads.transcripts.set(CHAT, [{ role: "custom", customType: "agent_message", display: true, timestamp: endedAt,
    content: "[agent-message from child:5180 into the real app]\nThe email builder added emx_name_new_template_first in en, ko and ja." } as ThreadMessage]);
  await chats.roster(new Map([[CHAT, [job]], [JOB, [builder]]]));
  threads.fire().live(CHAT, [job]);
  await chats.settled();
  now += PARK_IDLE_MS + 5 * 60_000;
  await chats.tick();
  await chats.settled();
  chats.close();
  return { deleted: calls.includes(`delete ${CHAT} sub-8aea6b3f`), kept: lines.filter(line => line.includes("kept job 5180 into the real app")) };
}

test("job cleanup: a quiet job whose wake went through its parked parent is kept until it runs", async () => {
  const { deleted, kept } = await sweep(ended => ({ relays: { [JOB]: ended + 24 * 60_000 } }));
  assert.equal(deleted, false, "01:16:36Z: the wake went to mac-management, parked until 02:00Z, so the job never got it");
  assert.match(kept.join("\n"), /a message for it went through its parent at 01:16:00Z, and that session has not run since/);
});

test("job cleanup: a quiet job is kept while a wake for one of its subagents waits on it as the parent", async () => {
  const { deleted, kept } = await sweep(ended => ({ relays: { [BUILDER]: ended + 10 * 60_000 } }));
  assert.equal(deleted, false, "the delete would cut the builder before its wake reaches it");
  assert.match(kept.join("\n"), /a message for a subagent under it went through its parent/);
});

test("job cleanup: a quiet job whose tree pi-pool holds is kept", async () => {
  const { deleted, kept } = await sweep(() => ({ pool: [JOB] }));
  assert.equal(deleted, false, "01:57Z: pi-pool held the tree until 02:01:30Z");
  assert.match(kept.join("\n"), /pi-pool holds its tree until its pool time/);
});

test("job cleanup: a quiet job whose cut turn the resume pass gives back is kept", async () => {
  const { deleted, kept } = await sweep(() => ({ turns: [JOB] }));
  assert.equal(deleted, false, "a failed job is resumed, not deleted");
  assert.match(kept.join("\n"), /the resume pass gives back its cut turn/);
});

test("job cleanup: a quiet job Prime parked on its provider quota is kept", async () => {
  const { deleted, kept } = await sweep(ended => ({ parkUntil: ended + PARK_IDLE_MS + 30 * 60_000 }));
  assert.equal(deleted, false);
  assert.match(kept.join("\n"), /Prime parks its turn on its provider quota until 02:22Z/);
});

test("job cleanup: a quiet job owed nothing, with an older relay it already took, is still ended", async () => {
  const { deleted } = await sweep(ended => ({ relays: { [JOB]: ended - 60_000 } }));
  assert.equal(deleted, true);
});
