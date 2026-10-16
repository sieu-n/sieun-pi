import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, ChildAgent, SessionRow } from "../src/shared/types.ts";
import { dutySink, fakeThreads, source } from "./chats-helpers.ts";

/**
 * slack green guy 10-16 07:5xZ: scripts/job-steer.ts got 404 "The chat has no job by that name" for "blog reader demo", by name and by its
 * session id 01a14114-330a-7272-b567-96952cd80b2d. The daemon's "list" timed out, so the catalog had no rows and the hub's child for the job
 * carried no session id, while the board step p146 held that job's name and session id.
 */
const NOW = Date.parse("2026-10-16T07:55:00Z");
const SESSION = "01a14114-330a-7272-b567-96952cd80b2d";
const board = (): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-16T07:00:00.000Z", todos: [], plan: [
  { id: "p145", text: "Visitors become paying users", status: "doing", children: [
    { id: "p146", text: "Build: on-topic blog readers get a reason to try Slack Green", status: "done", job: "blog reader demo", sessionId: SESSION, children: [] },
  ] },
] });

async function chatWith(children: ChildAgent[], rows: () => SessionRow[] = () => []) {
  const dir = await mkdtemp(join(tmpdir(), "job-steer-step-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  await writeFile(join(dir, "check-in-settings.json"), JSON.stringify({ c1: { everyMs: 3_600_000 } }));
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: board() }, () => NOW, rows), duty: dutySink().duty });
  await chats.adopt();
  threads.fire().live("c1", children);
  await chats.settled();
  calls.length = 0;
  return { chats, calls, threads };
}

test("a job the hub lists with no session id is steered in the session its board step holds, by name or by that id", async () => {
  const child = { id: "k9", label: "blog", sessionName: "blog reader demo", status: "done", lastActivityAt: NOW - 3_600_000, repliedSinceTask: true } as unknown as ChildAgent;
  const { chats, calls } = await chatWith([child]);
  assert.deepEqual(await chats.steerJob("c1", "blog reader demo", "p166 reads 0.53%"), { session: SESSION, act: "steer" });
  assert.deepEqual(await chats.steerJob("c1", SESSION, "p166 reads 0.53%"), { session: SESSION, act: "steer" });
  assert.equal(calls.filter(call => call === `steer ${SESSION} [check-in] p166 reads 0.53%`).length, 2, calls.join("\n"));
});

test("a job only the board names, while the catalog has no rows and the hub lists nothing, is steered in its step's session", async () => {
  const { chats, calls } = await chatWith([]);
  assert.deepEqual(await chats.steerJob("c1", "Blog Reader Demo", "hi"), { session: SESSION, act: "steer" });
  assert.deepEqual(await chats.steerJob("c1", SESSION, "hi"), { session: SESSION, act: "steer" });
  assert.deepEqual(await chats.steerJob("c1", "no such job", "hi"), { jobs: [] });
  assert.equal(calls.length, 2, calls.join("\n"));
});

test("a job is steered in its step's session while the daemon's list times out", async () => {
  let listing = true;
  const { chats, calls } = await chatWith([], () => { if (listing) return []; throw new Error("Timed out after 30000ms waiting for the Prime Agent daemon response to \"list\""); });
  listing = false;
  assert.deepEqual(await chats.steerJob("c1", "blog reader demo", "hi"), { session: SESSION, act: "steer" });
  assert.deepEqual(await chats.steerJob("c1", "no such job", "hi"), { jobs: [] });
  assert.equal(calls.length, 1, calls.join("\n"));
});

test("blog reader demo 10-16 08:2xZ: a job whose session the server cannot reach gets the message through its chat", async () => {
  const { chats, calls, threads } = await chatWith([]);
  const prompt = threads.prompt.bind(threads);
  threads.prompt = async (id, input) => {
    if (id === SESSION) throw Object.assign(new Error("This thread is not in the Prime Agent catalog."), { status: 404 });
    return prompt(id, input);
  };
  assert.deepEqual(await chats.steerJob("c1", "blog reader demo", "p164 reads 1.3 of 2%"), { session: "c1", act: "relay" });
  assert.deepEqual(calls, ["steer c1 [check-in] The server cannot reach your job \"blog reader demo\", so send it this with " +
    "agent_message.send(text, receiver_role=\"child\", receiver_name=\"blog reader demo\"): p164 reads 1.3 of 2%"]);
});
