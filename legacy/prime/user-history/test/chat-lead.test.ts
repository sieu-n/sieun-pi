import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

test("chats: the turn queue gets the whole chat list on load, on a create and on an archive, so the chat heads' runs start first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-lead-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("old");
  const written: string[][] = [];
  const archived = new IdIndex(join(dir, "archived-chats.json"), "Archived chat index");
  const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir), archived, lead: async ids => { written.push([...ids].sort()); } });
  await chats.ids();
  await chats.settled();
  assert.deepEqual(written, [["old"]], "the load writes the list");
  const { id } = await chats.create({ cwd: "/repo" });
  await chats.settled();
  assert.deepEqual(written.at(-1), [id, "old"].sort(), "a create adds the new chat");
  await chats.archive("old", "owner");
  await chats.settled();
  assert.deepEqual(written.at(-1), [id], "an archived chat leaves the list");
  chats.close();
});
