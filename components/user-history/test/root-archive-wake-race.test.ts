// Guards us-metal02 10-18 16:35:25Z: on the first tick after the chat service restart, the idle-root sweep (queued on the chat's key) archived
// "repo prod secrets move" (01a14ed4) while the job wake (queued on the job's key) was attaching to it, so the open failed with "Daemon session
// closed during attach" (service.log: "open 01a14ed4 saved 288 messages: ... failed: Daemon session closed during attach", then "archived idle
// root repo prod secrets move" eight lines later).
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { jobResumes } from "../src/job-resume.ts";
import type { ChatAgent, ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

test("the idle-root archive of a job waits for that job's wake check to finish its open, so the archive never closes a session mid-attach", async () => {
  const dir = await mkdtemp(join(tmpdir(), "root-archive-wake-"));
  const now = Date.parse("2026-10-18T16:35:25Z");
  const sessionFile = join(dir, "01a14ed4.jsonl");
  await writeFile(sessionFile, JSON.stringify({ type: "message", message: { role: "user", content: "Move the repo prod secrets." } }) + "\n");
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const root: ChatAgent = { key: "thread:r1", sessionId: "r1", name: "repo prod secrets move", job: "session:r1", sender: "repo prod secrets move",
    link: "root", state: "idle", lastActivityAt: new Date(now - 60_000).toISOString() } as ChatAgent;
  const rows = [row("c1", new Date(now - 60_000).toISOString(), { agents: [root] })];
  const events: string[] = [];
  const threads = fakeThreads([]);
  threads.transcripts.set("c1", [{ role: "custom", customType: "agent_message", display: true, timestamp: now - 60_000,
    content: "[agent-message from child:repo prod secrets move]\nDone: the secrets moved." } as ThreadMessage]);
  let opened!: () => void;
  const attach = new Promise<void>(resolve => { opened = resolve; });
  threads.view = async (id: string) => { events.push(`view ${id} start`); await attach; events.push(`view ${id} end`); return null; };
  threads.archive = async (id: string) => { events.push(`archive ${id}`); };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile }), "b1", loadRecord(join(dir, "extension-loads.json")), {
    ...source(dir, {}, () => now, () => rows), waking: async () => false,
    resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: async () => {} },
  }, () => {});
  await chats.tick();
  for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve));
  opened();
  await chats.settled();
  chats.close();
  assert.deepEqual(events, ["view r1 start", "view r1 end", "archive r1"]);
});
