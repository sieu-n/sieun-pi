// 10-20 03:00Z: 12 of 17 chats ran an extension build hours older than the live one, because a chat with input queued counted as busy and
// waited for an idle event that never came, so each tell_owner fix reached the busiest chats late or never (c117). A reload keeps the queue.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

test("a chat on an older build with input queued reloads on the next tick once no turn runs, and a running turn still holds it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reload-queued-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("vp");
  const loads = loadRecord(join(dir, "extension-loads.json"));
  await loads.set("vp", "old");
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  threads.busyIds.add("vp");
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" as const }), "new", loads, source(dir));
  await chats.adopt();
  threads.fire().live("vp", []);
  await chats.settled();
  assert.ok(!calls.includes("reload vp"), "a running turn holds the reload");
  await chats.tick();
  await chats.settled();
  assert.ok(!calls.includes("reload vp"), "the tick does not reload a chat mid-turn");
  threads.busyIds.delete("vp");
  threads.queuedIds.add("vp");
  await chats.tick();
  await chats.settled();
  assert.ok(calls.includes("reload vp"), "queued input with no turn running does not hold it");
  assert.equal(await loads.get("vp"), "new");
  chats.close();
});
