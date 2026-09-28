import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatNotes } from "../src/chat-notes.ts";

test("a thread memo saves, reads back, and an empty memo removes the entry", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "chat-notes-")), "notes.json");
  const notes = new ChatNotes(path);
  assert.deepEqual(await notes.get("t1"), { text: "", updatedAt: 0 });
  const saved = await notes.set("t1", "call Jin about the watchlist");
  assert.equal((await notes.get("t1")).text, "call Jin about the watchlist");
  assert.equal((await new ChatNotes(path).get("t1")).updatedAt, saved.updatedAt, "another reader sees the file");
  await notes.set("t1", "  ");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).threads, {});
});
