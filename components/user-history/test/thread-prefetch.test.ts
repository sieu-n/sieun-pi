// Guards the 10-18 cold tab switch from Korea: a click waited one 185 ms round trip plus about 370 ms for the 37 KB first frame at 100 KB/s
// before it painted, so the sidebar prefetches each row's first frame, and a prefetch must neither open nor attach the thread.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { FirstPages } from "../src/first-page.ts";
import type { ThreadEvent } from "../src/shared/types.ts";

const ID = "01a14ec2-0000-7000-8000-000000000000";

async function sessionFile(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "thread-prefetch-"));
  const file = join(dir, ID + ".jsonl");
  const lines = [JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-18T00:00:00.000Z", cwd: dir })];
  let parent: string | null = null;
  for (let index = 0; index < count; index++) {
    const id = index.toString(16).padStart(8, "0");
    const stamp = Date.parse("2026-10-18T00:00:00.000Z") + index * 1000;
    lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date(stamp).toISOString(), message: { role: "user", content: `message ${index}`, timestamp: stamp } }));
    parent = id;
  }
  await writeFile(file, lines.join("\n") + "\n");
  return file;
}

test("a prefetch reads the first frame from the session file once, holds no thread, and keeps serving it after the file grows", async () => {
  const file = await sessionFile(12);
  let summaries = 0;
  const catalog = { summary: async (id: string) => { summaries++; return { sessionId: id, sessionFile: file, cwd: "/", lifecycle: "saved", messageCount: 12 }; }, hostOf: () => null } as unknown as Catalog;
  const hub = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const text = await hub.prefetchFrames(ID);
  const [frame] = JSON.parse(text) as ThreadEvent[];
  assert.ok(frame?.type === "snapshot");
  assert.match(JSON.stringify(frame.snapshot.messages.at(-1)), /message 11/);
  assert.equal(hub.state(ID), undefined, "the prefetch opened the thread");
  appendFileSync(file, "\n");
  assert.equal(await hub.prefetchFrames(ID), text, "a grown file still serves the page made before, and the feed's snapshot replaces it");
  assert.equal(summaries, 1);
});

test("a first page read as stale comes back whatever its session file did since", async () => {
  const file = await sessionFile(1);
  const pages = new FirstPages(null);
  const text = pages.put("t1", [{ type: "status", connection: "connected" }], file);
  appendFileSync(file, "{}\n");
  assert.equal(await pages.get("t1"), undefined);
  assert.equal(await pages.get("t1", true), text);
  assert.equal(await pages.get("t2", true), undefined);
});
