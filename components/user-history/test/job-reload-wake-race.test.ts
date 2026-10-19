// Guards us-metal02 10-19 11:14:12Z: the reload sweep (queued on "#reload") reloaded job 01a152c0 while its wake check (queued on the job's key)
// opened it, so the open waited on "worker closing" and failed with "Active session 01a152c0-... is closing" (service.log: "daemon reload
// 01a152c0: answered in 2.1 s", then "open 01a152c0 saved 179 messages: ... failed: Active session ... is closing").
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatAgent } from "../src/shared/types.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

test("a job's reload and its wake check never overlap, so the wake never opens a session the reload is closing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-reload-wake-"));
  const now = Date.parse("2026-10-19T11:14:10Z");
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("harness");
  const loads = loadRecord(join(dir, "extension-loads.json"));
  await loads.set("j1", "old-build");
  const job: ChatAgent = { key: "thread:j1", sessionId: "j1", name: "owner messages precision", job: "session:j1", link: "root", state: "idle",
    lastActivityAt: new Date(now - 60_000).toISOString() } as ChatAgent;
  const rows = [row("harness", new Date(now - 60_000).toISOString(), { agents: [job] })];
  const events: string[] = [];
  const threads = fakeThreads([]);
  let finish!: () => void;
  const reloading = new Promise<void>(resolve => { finish = resolve; });
  threads.reloadIdle = async (id: string) => { events.push(`reload ${id} start`); await reloading; events.push(`reload ${id} end`); return "reloaded" as const; };
  let opened!: () => void;
  const opening = new Promise<void>(resolve => { opened = resolve; });
  threads.view = async (id: string) => { events.push(`view ${id} start`); await opening; events.push(`view ${id} end`); return null; };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "new-build", loads, source(dir, {}, () => now, () => rows));
  await chats.tick();
  for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve));
  finish();
  opened();
  await chats.settled();
  chats.close();
  const serial = [["reload j1 start", "reload j1 end", "view j1 start", "view j1 end"], ["view j1 start", "view j1 end", "reload j1 start", "reload j1 end"]];
  assert.ok(serial.some(order => order.join() === events.join()), events.join(", "));
});
