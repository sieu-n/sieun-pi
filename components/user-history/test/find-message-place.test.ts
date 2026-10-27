// Guards 18:00:30Z on 10-27: a part read of a message far back in the Mac chat's 110 MB copy walked back from the leaf and took 4.2 s at 1.7
// runnable a core. A page now names each message's place, and the part read seeks there.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findMessage, readBranchPage, type FilePlace } from "../src/session-tail.ts";

const ID = "01a17e5b-0000-7000-8000-000000000000";
const START = Date.parse("2026-10-27T05:00:00.000Z");
const FILLER = 3000;

test("a part read seeks to the place its page named, and a place the file no longer holds falls back to the walk from the leaf", async t => {
  const dir = await mkdtemp(join(tmpdir(), "find-message-place-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, ID + ".jsonl");
  const lines = [JSON.stringify({ type: "session", version: 3, id: ID, timestamp: new Date(START).toISOString(), cwd: dir })];
  let parent: string | null = null;
  const add = (id: string, stamp: number, content: string) => {
    lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date(stamp).toISOString(), message: { role: "user", content, timestamp: stamp } }));
    parent = id;
  };
  add("first", START, "the first of two at one stamp");
  add("second", START, "the second of two at one stamp");
  const pad = "x".repeat(10_000);
  for (let index = 0; index < FILLER; index++) add(`f${index}`, START + 3_600_000 + index * 1000, pad);
  await writeFile(file, lines.join("\n") + "\n");

  const page = await readBranchPage(file, null, { messages: 1_000_000, bytes: 1 << 30 });
  const place = page?.places.get(START);
  assert.equal(place?.id, "second", "the newest message at the stamp names the place");

  const seek = { bytes: 0 };
  assert.equal((await findMessage(file, START, 1, place, seek))?.entry.id, "second");
  assert.equal((await findMessage(file, START, 0, place))?.entry.id, "first");
  assert.ok(seek.bytes > 0 && seek.bytes <= 2 << 20, `the seek read ${seek.bytes} bytes`);

  const walk = { bytes: 0 };
  assert.equal((await findMessage(file, START, 1, null, walk))?.entry.id, "second");
  assert.ok(walk.bytes > 25 << 20, `the walk from the leaf read ${walk.bytes} bytes`);

  const stale: FilePlace = { end: place!.end + 20 * 10_100, id: "gone" };
  assert.equal((await findMessage(file, START, 0, stale))?.entry.id, "first", "a place whose entry is gone");
  assert.equal(await findMessage(file, START + 500, 0, place), null, "a stamp no message has");
});
