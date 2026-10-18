import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ownerChats } from "../src/owner-chats.ts";

test("the owner's chats leave out archived chats and clean-room test chats (Duties review 01a14c94, 10-18 01:43Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "owner-chats-"));
  const harness = "01a1164b-4a2d-742d-b27a-82f086ed0200", duties = "01a14c94-c31e-74f2-9784-0b3e01bdce88", skills = "01a14c54-a925-76a9-9600-bc1f0a92e9f5";
  await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: [duties, skills, harness] }));
  await writeFile(join(dir, "clean-room-chats.json"), JSON.stringify({ ids: [duties, skills] }));
  await writeFile(join(dir, "archived-chats.json"), JSON.stringify({ ids: [skills] }));
  assert.deepEqual(await ownerChats(dir), [harness]);
  assert.deepEqual(await ownerChats(await mkdtemp(join(tmpdir(), "owner-chats-empty-"))), []);
});
