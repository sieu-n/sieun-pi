// sep launch!! (01a15427, on the Mac) on 11-04: from about 05:47 KST every request was "Request not sent: context length exceeded. The next
// request to anthropic/claude-opus-5-5 is about 503909 tokens, over its 500000-token context window." with 39 inputs queued. An automatic
// compaction that failed on a connection drop had blocked the next ones. The service's revive steered "Your last turn failed... continue"
// each 5 to 20 min (service.log, 02:58Z, 03:00Z), which met the same refusal, until a hand compact through the daemon's `compact` ended at
// about 03:11:27Z; the revive at 03:11:30Z still steered the 05:47 failure into the chat that already ran again.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { failureCause, jobWake, turnStall } from "../src/chat-recovery.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ModelInfo, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, ownerAsks, reply, row, source } from "./chats-helpers.ts";

const CHAT = "01a15427-0000-7000-8000-000000000000";
const FULL = "Request not sent: context length exceeded. The next request to anthropic/claude-opus-5-5 is about 503909 tokens, over its 500000-token context window.";
const at = (iso: string): number => Date.parse(iso);
const FAILED = at("2026-11-03T20:47:00Z");
const COMPACTED = at("2026-11-04T03:11:27Z");
const compaction: ThreadMessage = { role: "compactionSummary", summary: "sep launch so far", tokensBefore: 503320, timestamp: COMPACTED };
const failedTurn: ThreadMessage[] = [ownerAsks("is the vent page live?", FAILED - 60_000), reply("error", FAILED, FULL)];
const queued = Array.from({ length: 39 }, (_, index) => `report ${index}`);

async function chatWith(messages: ThreadMessage[], waiting: readonly string[]) {
  const home = await mkdtemp(join(tmpdir(), "context-full-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  threads.transcripts.set(CHAT, messages);
  threads.extras.set(CHAT, { info: { model: { provider: "anthropic", id: "claude-opus-5-5" } as ModelInfo, retryAttempt: 0, queuedActions: 0 },
    queue: { steering: waiting, followUp: [] }, retry: null } as never);
  const index = new IdIndex(join(home, "chats.json"), "Chat index");
  await index.add(CHAT);
  let now = 0;
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(home, "extension-loads.json")),
    { ...source(home, {}, () => now, () => [row(CHAT, new Date(now).toISOString(), { chat: true })]), home });
  const wake = async (iso: string): Promise<string[]> => {
    now = at(iso);
    calls.length = 0;
    await chats.tick();
    await chats.settled();
    await new Promise(resolve => setTimeout(resolve, 20));
    return calls.filter(call => /^(compact|resume|restart|abort|steer) /.test(call));
  };
  return { chats, wake };
}

test("a context Prime will not send is its own cause, and a job held on it is woken", () => {
  assert.equal(failureCause(FULL), "context");
  assert.equal(failureCause("Request not sent: context length exceeded. The next request to anthropic/claude-opus-5-5 is about 450000 tokens, over its 400000-token compaction threshold, so Prime compacts first."), "context");
  const stall = turnStall({ messages: failedTurn, running: false, retrying: false, queued: 0, retryError: null }, FAILED + 60_000);
  assert.equal(jobWake({ stall, last: undefined, woke: false, now: FAILED + 60_000 }), "wake");
});

test("replay: the chat held on a full context with 39 inputs queued is compacted and its queue resumed at once, with no steer", async () => {
  const { chats, wake } = await chatWith(failedTurn, queued);
  assert.deepEqual(await wake("2026-11-03T20:47:30Z"), [`compact ${CHAT}`, `resume ${CHAT}`]);
  chats.close();
});

test("a chat held on a full context with nothing queued is compacted, then gets the failed-turn turn", async () => {
  const { chats, wake } = await chatWith(failedTurn, []);
  const calls = await wake("2026-11-03T20:47:30Z");
  assert.equal(calls[0], `compact ${CHAT}`);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!, /^restart 01a15427\S* \[check-in\] Your last turn failed at .*context length exceeded.*"is the vent page live\?"\. Answer it first\.$/);
  chats.close();
});

test("replay: after the 03:11:27Z compaction the 05:47 failure is stale, in file order and in an attach snapshot's context order", async () => {
  for (const messages of [[...failedTurn, compaction], [compaction, ...failedTurn]]) {
    const { chats, wake } = await chatWith(messages, []);
    assert.deepEqual(await wake("2026-11-04T03:11:30Z"), [], "no \"Your last turn failed at 05:47\" note");
    chats.close();
    assert.equal(turnStall({ messages, running: false, retrying: false, queued: 0, retryError: null }, COMPACTED + 3000), null);
  }
  const later = reply("error", COMPACTED + 60_000, FULL);
  assert.equal(turnStall({ messages: [compaction, ...failedTurn, later], running: false, retrying: false, queued: 0, retryError: null }, COMPACTED + 90_000)?.at,
    COMPACTED + 60_000, "a failure after the compaction is a stall again");
  assert.equal(turnStall({ messages: [failedTurn[0]!, reply("stop", FAILED - 30_000), failedTurn[1]!], running: false, retrying: false, queued: 0, retryError: null }, FAILED + 60_000)?.at,
    FAILED, "a good reply before the failure leaves it current");
});
