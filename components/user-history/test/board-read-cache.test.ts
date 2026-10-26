// Guards the 30 s ticks on us-metal02 on 10-26: the job cleanup, check-in and duty ticks read the 16 chats' boards (3.7 MB) through a
// fresh parse about twice a tick, 35 to 60 ms of the main thread a pass, and the chat's reads waited 200 to 385 ms at each tick.
import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BoardStore } from "../src/chat-board-store.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";

test("a board read parses the file once while it is unchanged, and again after a write replaces it", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "board-read-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const boards = new BoardStore(dir);
  assert.equal(await boards.read(CHAT), null, "no board before its first op");
  await boards.apply(CHAT, [{ op: "plan_add", text: "Cut the tick spike" }], "agent");
  const parse = t.mock.method(JSON, "parse");
  const first = await boards.read(CHAT);
  const parsed = parse.mock.callCount();
  assert.ok(parsed >= 1);
  for (let reads = 0; reads < 5; reads++) assert.equal(await boards.read(CHAT), first, "the same board while the file is unchanged");
  assert.equal(parse.mock.callCount(), parsed, "no parse for the reads of an unchanged file");
  await boards.apply(CHAT, [{ op: "plan_add", text: "Measure it" }], "agent");
  const next = await boards.read(CHAT);
  assert.notEqual(next, first);
  assert.deepEqual(next?.plan.map(item => item.text), ["Cut the tick spike", "Measure it"]);
  await unlink(join(dir, "boards", `${CHAT}.json`));
  assert.equal(await boards.read(CHAT), null, "a deleted board reads as none");
});
