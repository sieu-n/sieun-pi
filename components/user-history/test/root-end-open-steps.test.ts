// SEO guy on 10-24: its root "next article 10-25" (01a16b90) checked /blog/macro-influencers live at 15:30Z and ended its turn at 15:49Z
// with p95 still open, while the owner had paused that chat's check-in. The open-steps notice only covered subagents, so nothing told the
// chat, and p95 sat open with no mover until d9's 16:53Z push closed it (d9 stuck_steps_all 2).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatAgent, ChatBoard, PlanItem, SessionRow } from "../src/shared/types.ts";
import { dutySink, fakeThreads, row, source } from "./chats-helpers.ts";

const at = "2026-10-24T15:49:13Z";
const session = "01a16b90-e36b-71db-8063-bba94859d224";
const p95 = (fields: Partial<PlanItem> = {}): PlanItem => ({ id: "p95", text: "Publish the next blog article dated 10-25 so days since a new article stays at most 1",
  status: "doing", job: "next article 10-25", sessionId: session, children: [], ...fields });
const root = (state: ChatAgent["state"]): ChatAgent => ({ key: `thread:${session}`, sessionId: session, name: "next article 10-25", job: `session:${session}`,
  sender: "next article 10-25", link: "root", state, steps: ["p95"], lastActivityAt: at });

async function run(states: readonly ChatAgent["state"][], step: PlanItem, waking = false): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "root-end-steps-"));
  try {
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add("seo");
    await writeFile(join(dir, "check-in-settings.json"), JSON.stringify({ seo: { everyMs: 7_200_000, pausedUntil: "forever", pausedBy: "owner" } }));
    const board: ChatBoard = { v: 2, rev: 1, updatedAt: at, todos: [], plan: [step] };
    let state = states[0]!;
    const rows = (): SessionRow[] => [row("seo", at, { chat: true, agents: [root(state)] })];
    const calls: string[] = [];
    const chats = new Chats(index, fakeThreads(calls), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
      { ...source(dir, { seo: board }, () => Date.parse(at) + 120_000, rows), waking: async () => waking }, () => {});
    await chats.adopt();
    for (const next of states) {
      state = next;
      await chats.tick();
      await chats.settled();
      await new Promise(resolve => setTimeout(resolve, 5));
      await chats.settled();
    }
    chats.close();
    return calls.filter(call => call.startsWith("steer seo "));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("a root that ends its turn with its step open is told to its owner-paused chat once", async () => {
  const told = await run(["working", "idle", "idle"], p95());
  assert.equal(told.length, 1, told.join("\n"));
  assert.match(told[0]!, /next article 10-25 ended its turn, and this open step names it: p95 "Publish the next blog article dated 10-25.*" is doing\. Read its last report now, then close each step whose work is done/);
});

test("a root whose chat already closed its step, or that sleeps on a board.wake, is not told", async () => {
  assert.deepEqual(await run(["working", "idle"], p95({ status: "done" })), []);
  assert.deepEqual(await run(["working", "idle"], p95(), true), []);
  assert.deepEqual(await run(["working", "working"], p95()), [], "a board.wake sleep reads working, so its turn has not ended");
  assert.deepEqual(await run(["idle", "idle"], p95()), [], "a root first seen idle ended before this service looked, and the check-in or d9 reads it");
});
