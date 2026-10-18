import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { heldByTodo, stepName } from "../src/checkin-end-state.ts";
import { ownerChats } from "../src/owner-chats.ts";
import type { OwnerTodo } from "../src/shared/types.ts";

test("the owner's chats leave out archived chats and clean-room test chats (Duties review 01a14c94, 10-18 01:43Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "owner-chats-"));
  const harness = "01a1164b-4a2d-742d-b27a-82f086ed0200", duties = "01a14c94-c31e-74f2-9784-0b3e01bdce88", skills = "01a14c54-a925-76a9-9600-bc1f0a92e9f5";
  await writeFile(join(dir, "chats.json"), JSON.stringify({ ids: [duties, skills, harness] }));
  await writeFile(join(dir, "clean-room-chats.json"), JSON.stringify({ ids: [duties, skills] }));
  await writeFile(join(dir, "archived-chats.json"), JSON.stringify({ ids: [skills] }));
  assert.deepEqual(await ownerChats(dir), [harness]);
  assert.deepEqual(await ownerChats(await mkdtemp(join(tmpdir(), "owner-chats-empty-"))), []);
});

test("one todo that quotes several steps' names holds each of them (Duties review t3 on p4 and p14)", () => {
  const t3: Pick<OwnerTodo, "id" | "text" | "step" | "done" | "from"> = { id: "t3", step: "p4", done: false, from: "agent",
    text: "Two daily checks count limits with no stated reason in auto-sns-agent: Crawler VP's Arbitrary limits says 1,118 and ops guy's Limits rest on evidence says 96. Which do we keep?" };
  const p4 = { id: "p4", text: "Arbitrary limits (Crawler VP): works, but duplicates ops guy's limits duty" };
  const p14 = { id: "p14", text: "Limits rest on evidence (ops guy): stuck, and duplicates Crawler VP's limits duty" };
  assert.deepEqual([stepName(p4.text), stepName(p14.text)], ["Arbitrary limits", "Limits rest on evidence"]);
  assert.equal(heldByTodo(p4, [t3]), true);
  assert.equal(heldByTodo(p14, [t3]), true);
  assert.equal(heldByTodo({ id: "p20", text: "Build: the limits page" }, [t3]), false, "a one-word name is too common to stand for a step");
  assert.equal(heldByTodo({ id: "p21", text: "Arbitrary limitsx: other" }, [t3]), false, "only a whole-word quote counts");
  assert.equal(heldByTodo(p14, [{ ...t3, done: true }]), false);
});
