// Guards 10-18 12:30:36Z on us-metal02: the reload sweep after a release reloaded check-in AI harness developer environment 21:27 while its
// archive, queued 15 s before, stopped its worker, and the daemon refused the reload with "Daemon worker client closed".
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

const root = (sessionId: string, name: string): ChatAgent => ({ key: "thread:" + sessionId, sessionId, name, job: "session:" + sessionId, link: "root", state: "idle" }) as ChatAgent;

test("a release reloads a chat's job onto the new build but never its duty job, whose run ends in an archive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-reload-"));
  const now = Date.parse("2026-10-18T12:30:36Z");
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("harness");
  const loads = loadRecord(join(dir, "extension-loads.json"));
  await loads.set("check-in", "f0f2c4d7789a426d");
  await loads.set("fix", "f0f2c4d7789a426d");
  const rows = [row("harness", new Date(now - 60_000).toISOString(), { agents: [root("check-in", "check-in AI harness developer environment 21:27"), root("fix", "p619 outbox")] })];
  const threads = fakeThreads([]);
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "101b49b4a1eb5663", loads,
    { ...source(dir, {}, () => now, () => rows), dutyJobs: async id => id === "harness" ? ["check-in"] : [] });
  await chats.tick();
  await chats.settled();
  chats.close();
  assert.deepEqual(threads.reloaded, ["fix"]);
});
