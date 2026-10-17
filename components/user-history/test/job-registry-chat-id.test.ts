import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jobRegistry } from "../src/chat-sources.ts";

// slack green guy 10-18: scripts/checkin-precheck.ts --roster drops the idle chat's row, so the precheck asked rootsOf([id]) with no name, and the
// chat's own roots, filed under "slack green guy", read as held elsewhere.
const CHAT = "01a11b0b-7c15-73da-9481-8de15903eab4";

test("job registry: a root filed with the chat's id is found by the id alone; an entry filed by name only is still found by the name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-jobs-id-"));
  const file = join(dir, "chat-jobs.json");
  await writeFile(file, JSON.stringify({ jobs: { "connect push": { chat: "slack green guy", at: Date.now() } } }));
  const registry = jobRegistry(file);
  await registry.add(["fix visitors become paying users slack green guy 05:37"], "slack green guy", CHAT);
  assert.deepEqual(await registry.rootsOf([CHAT]), ["fix visitors become paying users slack green guy 05:37"], "the id alone finds the root filed with it");
  assert.deepEqual((await registry.rootsOf([CHAT, "slack green guy"])).sort(), ["connect push", "fix visitors become paying users slack green guy 05:37"]);
  assert.equal(await registry.chatIdOf("fix visitors become paying users slack green guy 05:37"), CHAT);
  assert.equal(await registry.chatIdOf("connect push"), undefined);
  assert.equal(await registry.chatOf("fix visitors become paying users slack green guy 05:37"), "slack green guy");
  const stored = JSON.parse(await readFile(file, "utf8")) as { jobs: Record<string, { chatId?: string }> };
  assert.equal(stored.jobs["fix visitors become paying users slack green guy 05:37"]!.chatId, CHAT);
});
