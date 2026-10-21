// Replays us-metal02 10-21 11:19:39Z to 11:19:40Z. Update 723509-1792581529564 (ctl-711766-1792581529) restored the daemon's sessions from
// 11:18:49Z to 11:23:00Z. Four create_session roots that were mid-turn when it began (shouldResume true in the planned sidecar) read idle
// before their restore, and the idle-root sweep archived them: promote 16 readback 10-21 (01a159e2), staging tagged starved (01a14fcb),
// watchlist status read (01a1553e) and F1 concurrency holds to zero (01a15535). The daemon refused each saved archive ("holds the session in
// a worker it does not list as this thread's"), the record listed all 4 under stoppedBeforeRestore with reason unknown, and none was resumed.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes } from "../src/job-resume.ts";
import type { PrimeUpdate } from "../src/prime-update.ts";
import type { ChatAgent, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const MIN = 60_000;

test("the idle-root sweep archives no root while a Prime update restores the daemon's sessions, and archives it once the update ends (10-21 11:19Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "root-archive-update-"));
  let now = Date.parse("2026-10-21T11:19:39.224Z");
  const sessionFile = join(dir, "01a159e2.jsonl");
  await writeFile(sessionFile, JSON.stringify({ type: "message", message: { role: "user", content: "Check prod after promote 17." } }) + "\n");
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const lastActivityAt = "2026-10-21T11:18:49.769Z";
  const root = { key: "thread:r1", sessionId: "r1", name: "promote 16 readback 10-21", job: "session:r1", sender: "promote 16 readback 10-21",
    link: "root", state: "idle", lastActivityAt } as ChatAgent;
  const rows = [row("c1", lastActivityAt, { agents: [root] })];
  const threads = fakeThreads([]);
  threads.transcripts.set("c1", [{ role: "custom", customType: "agent_message", display: true, timestamp: now - 80 * MIN,
    content: "[agent-message from child:promote 16 readback 10-21]\np444 is done: promote 17 is on prod and reads back clean." } as ThreadMessage]);
  const archived: string[] = [];
  threads.archive = async (id: string) => { archived.push(id); };
  let update: PrimeUpdate | null = { requestId: "723509-1792581529564", phase: "restoring", startedAt: "2026-10-21T11:18:49.564Z",
    file: join(dir, "ctl-711766-1792581529.json") };
  const log: string[] = [];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile }), "b1", loadRecord(join(dir, "extension-loads.json")), {
    ...source(dir, {}, () => now, () => rows), waking: async () => false, updating: async () => update,
    resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: async () => {} },
  }, line => log.push(line));
  await chats.tick();
  await chats.settled();
  assert.deepEqual(archived, [], "no root is archived while the update restores");
  assert.ok(log.includes("chats: Prime update 723509-1792581529564 is restoring; no idle root is archived until it ends"), log.join("\n"));
  now += MIN;
  await chats.tick();
  await chats.settled();
  assert.deepEqual(archived, [], "a later sweep in the same update archives nothing either");
  update = null;
  now += MIN;
  await chats.tick();
  await chats.settled();
  chats.close();
  assert.deepEqual(archived, ["r1"], "once the update ended, the same idle root is archived");
});
