// Replays us-metal02 11-08 13:16:38Z. Idle unload and the idle-root sweep both stopped the root push verdict legs 11-04: idle unload's kill
// ended ok at 13:16:40.536Z, and the sweep's archive sent a second kill that failed at 13:16:41.890Z with "Daemon worker client closed" when
// the first one's worker exited. d7 counted the failed daemon call, and 13:16Z read dirty. The second test replays us-metal02 11-09 21:46:32Z,
// where the sweep's get_state of onboarding renders prod 60s went out 0.35 s after idle unload's kill of it and met "Session worker is stopping".
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

const MIN = 60_000;

test("the idle-root sweep archives a root only after idle unload's stop of it ends, so the root gets one kill (11-08 13:16Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "root-archive-unloading-"));
  const now = Date.parse("2026-11-08T13:16:38.075Z");
  const sessionFile = join(dir, "01a1a3bd.jsonl");
  await writeFile(sessionFile, JSON.stringify({ type: "message", message: { role: "user", content: "Push the verdict legs." } }) + "\n");
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const lastActivityAt = "2026-11-08T12:10:00.000Z";
  const root = { key: "thread:r1", sessionId: "r1", name: "push verdict legs 11-04", job: "session:r1", sender: "push verdict legs 11-04",
    link: "root", state: "idle", lastActivityAt } as ChatAgent;
  const rows = [row("c1", lastActivityAt, { agents: [root] })];
  const threads = fakeThreads([]);
  threads.transcripts.set("c1", [{ role: "custom", customType: "agent_message", display: true, timestamp: now - 60 * MIN,
    content: "[agent-message from child:push verdict legs 11-04]\np1400 is done: the legs are pushed." } as ThreadMessage]);
  const order: string[] = [];
  threads.archive = async (id: string) => { order.push(`archive ${id}`); };
  let endStop = (_stopped: boolean): void => {};
  const stop = new Promise<boolean>(resolve => { endStop = resolve; });
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile }), "b1", loadRecord(join(dir, "extension-loads.json")), {
    ...source(dir, {}, () => now, () => rows), waking: async () => false,
    unloading: session => session === "r1" ? stop : undefined,
    resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: async () => {} },
  }, () => {});
  const tick = chats.tick();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual([...order], [], "the archive went out while idle unload's kill of the same root was still under way");
  order.push("unloaded r1");
  endStop(true);
  await tick;
  await chats.settled();
  chats.close();
  assert.deepEqual(order, ["unloaded r1", "archive r1"]);
});

test("the idle-root sweep asks the daemon whether a root works only after idle unload's stop of it ends (11-09 21:46Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "root-probe-unloading-"));
  const now = Date.parse("2026-11-09T21:46:32.083Z");
  const sessionFile = join(dir, "01a1c236.jsonl");
  await writeFile(sessionFile, JSON.stringify({ type: "message", message: { role: "user", content: "Render onboarding on prod in 60 s." } }) + "\n");
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const lastActivityAt = "2026-11-09T20:40:00.000Z";
  const root = { key: "thread:r1", sessionId: "r1", name: "onboarding renders prod 60s", job: "session:r1", sender: "onboarding renders prod 60s",
    link: "root", state: "idle", lastActivityAt } as ChatAgent;
  const rows = [row("c1", lastActivityAt, { agents: [root] })];
  const threads = fakeThreads([]);
  threads.transcripts.set("c1", [{ role: "custom", customType: "agent_message", display: true, timestamp: now - 60 * MIN,
    content: "[agent-message from child:onboarding renders prod 60s]\np1226 is done: onboarding renders on prod in 41 s." } as ThreadMessage]);
  const order: string[] = [], lines: string[] = [];
  let killing = true;
  threads.sessionActive = async (id: string) => {
    order.push(`get_state ${id}`);
    if (killing) throw new Error("Session worker is stopping");
    return false;
  };
  threads.archive = async (id: string) => { order.push(`archive ${id}`); };
  let endStop = (_stopped: boolean): void => {};
  const stop = new Promise<boolean>(resolve => { endStop = resolve; });
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile }), "b1", loadRecord(join(dir, "extension-loads.json")), {
    ...source(dir, {}, () => now, () => rows), waking: async () => false,
    unloading: session => session === "r1" && killing ? stop : undefined,
    resumes: { store: jobResumes(join(dir, "job-resumes")), applyBoard: async () => {} },
  }, line => lines.push(line));
  const tick = chats.tick();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual([...order], [], "the sweep asked the daemon about the root while idle unload's kill of it was still under way");
  order.push("unloaded r1");
  killing = false;
  endStop(true);
  await tick;
  await chats.settled();
  chats.close();
  assert.deepEqual(order, ["unloaded r1", "archive r1"]);
  assert.doesNotMatch(lines.join("\n"), /worker is stopping/);
});
