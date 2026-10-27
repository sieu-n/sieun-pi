// Guards 10-22 14:04Z to 14:15Z on us-metal02: the metal box owner (01a11d24), which other chats waited on, was added to the turn queue's lead
// list by hand with `pi-pool lead` and admitted 21 s later, and the chat service's next lead write at 14:06:46Z replaced the list from the
// chat list and dropped it, so from 14:15:40Z it waited 28 min at place 15 (messaging audit FINDINGS.md).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { leadStore, leadWriter } from "../src/chat-hosts.ts";

const VP = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const OPS = "01a11af8-962e-773d-a19a-ee4104011987";
const NEW_CHAT = "01a17b00-0000-7000-8000-000000000001";
const BOX_OWNER = "01a11d24-ac9b-757d-ac51-9b2b7598782f";

test("a session added to the lead list by hand stays through the writer's later writes and a service restart, and leaves when removed by hand", async t => {
  const dir = await mkdtemp(join(tmpdir(), "lead-hand-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let pool: string[] = [];
  const logged: string[] = [];
  const writer = () => leadWriter({ hostOf: () => null, remotes: () => [], local: async ids => { pool = [...ids]; }, current: async () => pool,
    store: leadStore(join(dir, "lead-written.json")), log: line => logged.push(line) });
  const write = writer();
  await write([VP, OPS], true);
  assert.deepEqual(pool.sort(), [VP, OPS].sort());
  pool = [...pool, BOX_OWNER];
  await write([VP, OPS, NEW_CHAT], true);
  assert.deepEqual(pool.sort(), [VP, OPS, NEW_CHAT, BOX_OWNER].sort(), "the hand entry stays when the writer adds a chat");
  assert.ok(logged.some(line => line === "turn queue lead list on this box: kept 1 added by hand (01a11d24)"), logged.join("\n"));
  await writer()([VP, NEW_CHAT], true);
  assert.deepEqual(pool.sort(), [VP, NEW_CHAT, BOX_OWNER].sort(), "a restarted writer keeps it too, and an archived chat still leaves");
  pool = pool.filter(id => id !== BOX_OWNER);
  await writer()([VP, OPS], true);
  assert.deepEqual(pool.sort(), [VP, OPS].sort(), "removed by hand, it stays off");
});
