// Guards the 10-18 restart windows of the chat service: after the 21:33:56Z restart service.log held 384 thread opens in the first minute, most of them the failed-turn check opening each job of the last 24 h again, and the main thread stayed 74 to 97% busy for 4 minutes while the sidebar's projection p90 was 1.1 to 1.6 s.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { quietJobRecord } from "../src/chat-sources.ts";
import { Chats, QUIET_WRITE_MS } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatAgent, SessionRow } from "../src/shared/types.ts";
import { source, fakeThreads, row } from "./chats-helpers.ts";

test("a service start does not open again the jobs the last run found fine", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quiet-jobs-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = 1_000_000_000;
  const agent = (n: number): ChatAgent => ({ key: `child:j${n}`, sessionId: `j${n}`, name: `job ${n}`, job: `job ${n}`, sender: `job ${n}`, link: "subagent", state: "done",
    lastActivityAt: new Date(now - 60_000 - n).toISOString(), steps: [] });
  const agents = Array.from({ length: 300 }, (_, n) => agent(n));
  const rows = (): SessionRow[] => [row("c1", new Date(now).toISOString(), { chat: true, agents })];
  const start = async () => {
    const threads = fakeThreads([]);
    const views: string[] = [];
    threads.view = async (id: string) => { views.push(id); return null; };
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
      { ...source(dir, {}, () => now, rows), quietJobs: quietJobRecord(join(dir, "quiet-jobs.json")) }, () => {});
    await chats.adopt();
    return { chats, views };
  };

  const first = await start();
  await first.chats.tick();
  await first.chats.settled();
  assert.equal(first.views.length, 300, "the first run looks at each job once");
  first.chats.close();
  const record = quietJobRecord(join(dir, "quiet-jobs.json"));
  for (let waited = 0; (await record.read()).size < 300 && waited < QUIET_WRITE_MS; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));

  now += 30_000;
  const second = await start();
  await second.chats.tick();
  await second.chats.settled();
  assert.ok(second.views.length <= 3, `a restart opened ${second.views.length} jobs`);
  second.chats.close();
});
