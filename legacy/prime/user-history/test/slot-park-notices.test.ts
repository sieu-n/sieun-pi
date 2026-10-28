// Replays 01a17f25 (test/fixtures/slot-park-01a17f25-1028.jsonl) through the chat service's notices, relay and check-in: a job that waits for
// its pi-pool slot gets no "[job] ... failed" or "ended" notice, no check-in nudge or restart and no relay or continue, and Prime's park-stop
// notice never reads as a cancel. Only the park Prime's wake dropped with no turn after is told, and pushed once after the resume pass's continue.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentOutbox } from "../src/agent-outbox.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { relayRecord } from "../src/chat-sources.ts";
import { Chats } from "../src/chats.ts";
import { clockTime } from "../src/checkin-settings.ts";
import { jobPushes } from "../src/checkin-jobs.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { withFailedTurns } from "../src/held-turns.ts";
import { IdIndex } from "../src/id-index.ts";
import { sessionFileOf } from "../src/send-once.ts";
import { triggerSummary } from "../src/shared/turns.ts";
import type { ChatAgent, ChildAgent, CustomMessage, SessionRow, ThreadMessage } from "../src/shared/types.ts";
import { readSlotPark } from "../src/slot-park.ts";
import { relayNote } from "../src/subagent-relay.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";
import { agentDir, at, CHAT, DROPPED, EMPTY, ID, LISTED, PARKED, QUEUED, SLOT_ERROR } from "./slot-park-replay.ts";

test("check-in: a parked or ticketed job reads working and gets no nudge or restart; a dropped park reads failed on the drop and gets one push", async () => {
  const now = at("2026-10-27T21:14:00Z");
  const fact: JobFact = { key: `thread:${ID}`, name: "page writer", state: "ended", activityAt: at("2026-10-27T20:00:00Z") };
  const view = { item: { id: "p9", text: "Write the page", status: "doing" as const, children: [] }, owner: fact, cls: "live" as const };
  const push = (facts: readonly JobFact[]) => jobPushes(facts, [{ ...view, owner: facts[0]! } as never], { [fact.key]: { mark: 0, since: at("2026-10-27T19:00:00Z") } },
    30 * 60_000, now, () => true, () => 0).pushes;
  const [parked] = await withFailedTurns([fact], await agentDir(PARKED), CHAT, () => undefined, async () => undefined, LISTED, now);
  assert.equal(parked!.state, "working");
  assert.equal(parked!.slotPark?.place, 61);
  assert.deepEqual(push([parked!]), [], "21:14Z: parked 61st of 170, so the check-in pushes nothing");
  const [queued] = await withFailedTurns([fact], await agentDir(QUEUED), CHAT, () => undefined, async () => undefined, LISTED, at("2026-10-27T21:22:13Z"));
  assert.equal(queued!.state, "working");
  assert.deepEqual(push([queued!]), [], "21:22Z: queued with a ticket the pool holds");
  const [stale] = await withFailedTurns([fact], await agentDir(QUEUED), CHAT, () => undefined, async () => undefined, EMPTY, at("2026-10-27T21:40:00Z"));
  assert.equal(stale!.slotPark, undefined, "a queue place the pool no longer lists is a real stall");
  assert.equal(push([stale!]).length, 1);
  const [dropped] = await withFailedTurns([fact], await agentDir(DROPPED), CHAT, () => undefined, async () => undefined, EMPTY, at("2026-10-27T21:18:00Z"));
  assert.equal(dropped!.state, "failed");
  assert.match(dropped!.error ?? "", /its slot park was dropped at .*it runs again only when it gets a message/);
  assert.deepEqual(push([dropped!]), [], "21:18Z: the resume pass's one continue goes first");
  const late = jobPushes([dropped!], [{ ...view, owner: dropped! } as never], { [fact.key]: { mark: 0, since: at("2026-10-27T19:00:00Z") } }, 30 * 60_000,
    at("2026-10-27T21:50:00Z"), () => true, () => 0).pushes;
  assert.equal(late.length, 1, "21:50Z: no turn a check-in interval after the drop is a real stall, pushed once");
});

test("chat feed: Prime's park-stop notice shows as a wait for a working slot, not a cancelled exit", () => {
  const notice = { role: "custom", customType: "rlm_child_terminal_notice", display: true, timestamp: 0,
    content: "[child-exited: cancelled child:pi-pool-move]\n\nStopped while its turn waited for a provider credential" } as unknown as CustomMessage;
  const summary = triggerSummary(notice);
  assert.equal(summary.label, "Subagent waits for a working slot");
  assert.doesNotMatch(`${summary.label} ${summary.detail} ${summary.body}`, /exited|cancelled child|was cancelled/i);
});

test("chats: a parked job gets no failed, ended or no-report notice, and a dropped park is told plainly as needing a message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slot-park-chats-"));
  const file = join(dir, `${ID}.jsonl`);
  await writeFile(file, PARKED.join("\n") + "\n");
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = at("2026-10-27T21:13:00Z");
  const endAt = at("2026-10-27T21:12:20.060Z");
  const agents: ChatAgent[] = [{ key: `thread:${ID}`, sessionId: ID, name: "page writer", job: "page writer", sender: "page writer", link: "root", state: "done",
    lastActivityAt: new Date(endAt).toISOString(), steps: [] }];
  const rows = (): SessionRow[] => [row("c1", new Date(now).toISOString(), { chat: true, agents }), row(ID, new Date(endAt).toISOString(), { name: "page writer", messageCount: 9 })];
  const chats = new Chats(index, threads, async id => ({ lifecycle: "live", ...id === ID ? { sessionFile: file } : {} }), "b1", loadRecord(join(dir, "extension-loads.json")),
    source(dir, {}, () => now, rows));
  await chats.adopt();
  threads.transcripts.set("c1", [{ role: "user", content: "go", timestamp: endAt - 60_000 } as ThreadMessage]);
  threads.views.set(ID, { messages: [{ role: "user", content: "[task from parent] write the page", timestamp: endAt - 60_000 } as ThreadMessage,
    { role: "assistant", content: [], provider: "p", model: "m", stopReason: "error", timestamp: endAt, errorMessage: SLOT_ERROR } as ThreadMessage] });
  const step = async () => { now += 30_000; calls.length = 0; await chats.tick(); await chats.settled(); return calls.filter(call => call.startsWith("steer ")); };
  assert.deepEqual(await step(), [], "21:13Z: it waits 104th of 185, so no '[job] page writer stopped on a provider error'");
  await writeFile(file, DROPPED.join("\n") + "\n");
  now = at("2026-10-27T21:17:30Z");
  assert.deepEqual(await step(), [`steer c1 [job] page writer was waiting for a working slot, and its slot park was dropped at ${clockTime(at("2026-10-27T21:16:40.332Z"))}, ` +
    "when Prime's wake ran no turn, so it runs again only when it gets a message"]);
  chats.close();
});

test("chats: a subagent that waits for its slot gets no no-report notice when it goes quiet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slot-park-noreport-"));
  const file = join(dir, `${ID}.jsonl`);
  await writeFile(file, PARKED.join("\n") + "\n");
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const clock = at("2026-10-27T21:13:00Z");
  const chats = new Chats(index, { ...threads, state: () => ({ messages: [] }) }, async id => ({ lifecycle: "live", ...id === ID ? { sessionFile: file } : {} }), "b1",
    loadRecord(join(dir, "extension-loads.json")), source(dir, {}, () => clock));
  await chats.adopt();
  const flush = async () => { await new Promise(resolve => setTimeout(resolve, 5)); await chats.settled(); };
  const job = (working: boolean, last: number): ChildAgent => ({ id: "sub-be17a2bc", label: "page writer", sessionName: "page writer", sessionId: ID, status: "done",
    ...(working ? { activity: { kind: "writing" as const } } : {}), repliedSinceTask: false, lastActivityAt: last });
  threads.fire().live("c1", [job(true, clock - 120_000)]);
  await flush();
  threads.fire().children("c1", [job(false, clock - 60_000)]);
  threads.fire().children("c1", [job(true, clock - 60_000)]);
  threads.fire().children("c1", [job(false, clock - 60_000)]);
  await flush();
  assert.deepEqual(calls.filter(call => call.startsWith("steer ")), [], "no '[job] page writer ended at ... with no report' while it waits 104th of 185");
  chats.close();
});

test("outbox: a message to a parked subagent gets no relay or continue while it waits, and goes through its parent once Prime dropped the park", async t => {
  const agentDir = await mkdtemp(join(tmpdir(), "slot-park-outbox-"));
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await writeFile(join(agentDir, "sessions", `${CHAT}.jsonl`), "");
  const folder = join(agentDir, "session-artifacts", CHAT, "sub-41b36e00");
  await mkdir(folder, { recursive: true });
  const file = join(folder, `${ID}.jsonl`);
  await writeFile(file, PARKED.join("\n") + "\n");
  await writeFile(join(folder, "rlm-subagent.json"), JSON.stringify({ type: "rlm_subagent", sessionName: "page writer" }));
  const sent: [string, string][] = [];
  const now = at("2026-10-27T21:14:00Z");
  const messages = new AgentOutbox(join(agentDir, "agent-outbox"), { log: () => {}, sleep: () => new Promise(done => setTimeout(done, 2)), now: () => now,
    relayed: (session, when) => relayRecord(join(agentDir, "relayed.json")).add(session, when),
    send: async (session, text) => { sent.push([session, text]); return "sent"; },
    target: async () => ({ queued: [], busy: false }), fileOf: id => sessionFileOf(id, agentDir),
    resident: session => session === ID ? false : true,
    slotPark: async session => session === ID ? readSlotPark(file, now, LISTED) : null });
  t.after(() => messages.close());
  const text = "[agent-message from parent:VP] continue";
  await messages.deliver(ID, text);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(sent, [], "21:14Z: it waits 61st of 170, so neither a send nor a '[relay] ... is stopped' to its parent");
  await writeFile(file, DROPPED.join("\n") + "\n");
  await messages.outbox.idle();
  assert.deepEqual(sent, [[CHAT, relayNote({ id: ID, name: "page writer" }, text)]], "the held message is what starts it again");
});
