// Guards the 10-18 07:38Z to 08:01Z incident: the owner's "did you miss?" to frontend bro on the Mac never left the box, because a send waited for the attach and its 9.9 MB snapshot timed out at 30 s over the relay, 17 times.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";

const ID = "01a11ba8-0000-7000-8000-000000000001";

test("a send to a live session goes by its active id at once, while the attach is still waiting on the daemon", async t => {
  const dir = await mkdtemp(join(tmpdir(), "send-ahead-"));
  const file = join(dir, ID + ".jsonl");
  await writeFile(file, JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-18T07:00:00.000Z", cwd: dir }) + "\n");
  // A daemon socket that takes the attach's connection and never says hello, like a relay busy with a whole-context snapshot.
  const socket = join(dir, "slow.sock");
  const server = createServer(() => {});
  await new Promise<void>(resolve => server.listen(socket, resolve));
  t.after(() => server.close());
  const sent: Record<string, unknown>[] = [];
  const client = { request: async (command: Record<string, unknown>) => { sent.push(command); return { success: true, data: undefined }; } };
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: "worker-1", workerState: "ready", sessionFile: file, cwd: dir, lifecycle: "live", messageCount: 0 }),
    hostOf: () => null, connect: async () => {}, client } as unknown as Catalog;
  const hub = new ThreadHub(socket, catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => hub.close());

  const started = performance.now();
  await hub.prompt(ID, { message: "i just sent you message feedback, did you miss?", images: [], mode: "steer" });
  const ms = performance.now() - started;

  assert.deepEqual(sent.map(command => [command.type, command.activeSessionId, command.message]), [["prompt", "worker-1", "i just sent you message feedback, did you miss?"]]);
  assert.ok(ms < 1000, `the send waited ${Math.round(ms)} ms, so it waited for the attach`);
  await hub.open(ID).catch(() => {});
});
