// Replays chat-057a (01a14210) on 10-19: the owner archived it at 05:31:26Z, it kept working on the messages it got, and at 13:52Z it set a
// time wake for its pool slot at 14:27Z. The wake came due at 14:27:36Z and the outbox dropped it as "the owner archived the target chat, and it
// is a wake", so the chat sent pi-pool no request until a message woke it at 14:55:38Z, while accounts served other trees from 14:3xZ.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentOutbox, stopRecords } from "../src/agent-outbox.ts";
import { IdIndex } from "../src/id-index.ts";

const CHAT = "01a14210-4e7d-72c3-aa67-e3d476f4e728";
const ARCHIVED_AT = Date.parse("2026-10-19T05:31:26.246Z");
const wake = "[wake] It is 2026-10-19T14:27:36.062Z, the time you set with board.wake (2026-10-19T14:27:00.000Z). Your note: pool slot";

async function box(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "archived-own-wake-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await new IdIndex(join(dir, "archived-chats.json"), "Archived chat index").add(CHAT, ARCHIVED_AT);
  const sent: string[] = [];
  const lines: string[] = [];
  const outbox = new AgentOutbox(join(dir, "agent-outbox"), {
    log: line => { lines.push(line); }, now: () => Date.parse("2026-10-19T14:27:36.062Z"), sleep: () => new Promise(resolve => setImmediate(resolve)),
    send: async (_session, text) => { sent.push(text); return "sent"; },
    target: async () => ({ queued: [], busy: false, unfinished: 0 }),
    fileOf: async () => null, stopped: stopRecords(dir),
  });
  t.after(() => outbox.close());
  return { dir, sent, lines, outbox };
}

test("the archive records when the owner archived the chat, and an unarchive forgets it", async t => {
  const { dir } = await box(t);
  const file = join(dir, "archived-chats.json");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { ids: [CHAT], at: { [CHAT]: ARCHIVED_AT } });
  await new IdIndex(file, "Archived chat index").forget(CHAT);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { ids: [], at: {} });
});

test("a wake an archived chat set for itself after its archive is delivered, and the chat stays archived (chat-057a 10-19 14:27Z)", async t => {
  const { dir, sent, outbox } = await box(t);
  await outbox.deliver(CHAT, wake, undefined, "wake", Date.parse("2026-10-19T13:52:00.000Z"));
  await outbox.outbox.idle();
  assert.deepEqual(sent, [wake]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "archived-chats.json"), "utf8")).ids, [CHAT]);
});

test("a wake set before the owner archived the chat is still dropped as obsolete", async t => {
  const { sent, lines, outbox } = await box(t);
  await outbox.deliver(CHAT, wake, undefined, "wake", Date.parse("2026-10-19T05:00:00.000Z"));
  await outbox.outbox.idle();
  assert.deepEqual(sent, []);
  assert.ok(lines.some(line => line.includes("obsolete, not sent: the owner archived the target chat, and it is a wake")), lines.join("\n"));
});
