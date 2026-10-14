import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatAgent, SessionRow, ThreadMessage } from "../src/shared/types.ts";
import { source, fakeThreads, row, ownerAsks } from "./chats-helpers.ts";

/**
 * launch main bro 10-14 15:38 and 15:53 KST: each check-in ended its turn with stopReason stop 12.6 s and 4.5 s after its last tool result,
 * yet the chat was told it "stopped in the middle of a tool call", because the job end note judged the transcript the wake check had viewed
 * mid-turn instead of the one the thread held when the note ran.
 */
test("job end note: a job viewed between its last tool result and its final reply is not told as stopped mid-tool once that reply lands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-end-fresh-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = 1_000_000_000;
  const endAt = now;
  const agents: ChatAgent[] = [{ key: "thread:r3", sessionId: "r3", name: "check-in", job: "check-in", sender: "check-in", link: "root", state: "done",
    lastActivityAt: new Date(endAt).toISOString(), steps: [] }];
  const rows = (): SessionRow[] => [row("c1", new Date(now).toISOString(), { chat: true, agents })];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    source(dir, {}, () => now, rows), () => {});
  await chats.adopt();
  threads.transcripts.set("c1", [ownerAsks("go", endAt - 60_000)]);
  const task = ownerAsks("[task from parent] check in", endAt - 40_000);
  const call: ThreadMessage = { role: "assistant", content: [], provider: "p", model: "m", stopReason: "toolUse", timestamp: endAt - 1_000 };
  const result = { role: "toolResult", toolCallId: "t1", toolName: "ipython", content: [{ type: "text", text: "ok" }], isError: false, timestamp: endAt } as unknown as ThreadMessage;
  const final: ThreadMessage = { role: "assistant", content: [], provider: "p", model: "m", stopReason: "stop", timestamp: endAt + 8_000 };
  threads.views.set("r3", { messages: [task, call, result] });
  threads.busyIds.add("r3");
  threads.view = async (id: string) => {
    const seen = threads.views.get(id) ?? null;
    if (id === "r3") { threads.views.set("r3", { messages: [task, call, result, final] }); threads.busyIds.delete("r3"); }
    return seen;
  };
  now += 10_000;
  await chats.tick();
  await chats.settled();
  assert.deepEqual(calls.filter(entry => entry.startsWith("steer")), [], "the turn ended with a reply, so no [job] line");
  chats.close();
});
