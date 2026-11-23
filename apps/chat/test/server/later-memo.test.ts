/**
 * A saved item's memo (server/later.ts) through the owner's /api/later routes: a save and a reminder take one, a patch sets and clears it,
 * a save with no memo keeps it, Undo of an unsave puts it back, and a patch that changes nothing writes nothing. The memo survives a restart
 * from the JSON files (`LaterFiles`) and from chat.sqlite (`LaterRows`).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/later-memo.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { LaterItem, LaterList } from "../../web/src/lib/api/types.ts";
import { drained } from "../../server/disk.ts";
import { seedFixture } from "../../server/fixture/seed.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { start, type Running } from "./helpers.ts";

let kept: string | undefined;
before(() => {
  kept = process.env.APPS_CHAT_DB_KINDS;
});
after(() => {
  if (kept === undefined) delete process.env.APPS_CHAT_DB_KINDS;
  else process.env.APPS_CHAT_DB_KINDS = kept;
});

type Answer = { status: number; body: { item: LaterItem; error?: string } };
const save = (s: Running, body: Record<string, unknown>): Promise<Answer> => s.send("POST", "/api/later", body);
const patch = (s: Running, id: string, body: Record<string, unknown>): Promise<Answer> => s.send("PATCH", `/api/later/${encodeURIComponent(id)}`, body);

/** Runs the memo's whole round trip on a fresh data dir with `kinds` in APPS_CHAT_DB_KINDS, then restarts and reads the memos back. */
async function roundTrip(kinds: string): Promise<{ dataDir: string; lines: string[]; items: readonly LaterItem[]; post: string; note: string }> {
  process.env.APPS_CHAT_DB_KINDS = kinds;
  const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-memo-"));
  const host = new FixtureHost();
  host.wordMs = 0;
  seedFixture(host, dataDir);
  let s = await start({ dataDir, host });
  const post = s.app.agentStore.postsOf("dm_vent").at(-1)!.id;
  const id = `dm_vent:${post}`;
  let writes = 0;
  s.app.later.onChange(() => writes++);

  const first = await save(s, { room: "dm_vent", post, memo: "  ask Vent about the retry count  " });
  assert.equal(first.status, 200, first.body.error);
  assert.equal(first.body.item.memo, "ask Vent about the retry count", "a memo is kept trimmed");
  assert.equal((await save(s, { room: "dm_vent", post })).body.item.memo, "ask Vent about the retry count", "a save with no memo keeps it");
  assert.equal((await save(s, { room: "dm_vent", post, memo: "   " })).body.item.memo, "ask Vent about the retry count", "a save with a blank memo keeps it");
  assert.equal(writes, 1, "a save that changes nothing writes nothing");
  assert.equal((await save(s, { room: "dm_vent", post, memo: "ask Vent today" })).body.item.memo, "ask Vent today", "a save with a new memo sets it");

  assert.equal((await patch(s, id, { memo: null })).body.item.memo, undefined, "null clears the memo");
  assert.equal((await patch(s, id, { memo: "  " })).status, 200);
  assert.equal((await patch(s, id, { memo: "x".repeat(5000) })).body.item.memo?.length, 4000, "a long memo is cut");
  assert.equal((await patch(s, id, { memo: " " })).body.item.memo, undefined, "a blank memo clears it");
  const set = await patch(s, id, { memo: "read before the Thursday call", state: "done" });
  assert.deepEqual([set.body.item.memo, set.body.item.state], ["read before the Thursday call", "done"]);
  const before = writes;
  assert.equal((await patch(s, id, { memo: "read before the Thursday call" })).status, 200);
  assert.equal(writes, before, "a patch that changes nothing writes nothing");
  assert.equal((await patch(s, id, { memo: 7 })).status, 400);
  assert.equal((await save(s, { room: "dm_vent", post, memo: ["a"] })).status, 400);

  const row = (await s.get<LaterList>("/api/later?state=done")).items.find(r => r.id === id)!;
  assert.equal(row.memo, "read before the Thursday call", "a row carries the memo");
  const removed = (await s.send<{ item: LaterItem }>("DELETE", `/api/later/${encodeURIComponent(id)}`)).body.item;
  const back = await s.send<{ item: LaterItem; error?: string }>("PUT", `/api/later/${encodeURIComponent(id)}`, removed);
  assert.equal(back.status, 200, back.body.error);
  assert.deepEqual(back.body.item, removed, "Undo of an unsave puts the memo back");

  const note = await save(s, { note: "renew the domain", memo: "the card ends in 4242" });
  assert.equal(note.body.item.memo, "the card ends in 4242", "a reminder takes a memo");
  assert.equal((await save(s, { note: "call the bank", memo: "" })).body.item.memo, undefined, "a blank memo is no memo");

  await s.app.moves.get("later")?.flushExports();
  await drained();
  await s.close();
  const lines: string[] = [];
  s = await start({ dataDir, host, log: line => lines.push(line) });
  const items = s.app.later.items("owner");
  await s.close();
  return { dataDir, lines, items, post, note: note.body.item.id };
}

test("the memo round-trips and survives a restart from the JSON files", async () => {
  const { dataDir, items, post, note } = await roundTrip("");
  try {
    assert.equal(items.find(i => i.id === `dm_vent:${post}`)?.memo, "read before the Thursday call");
    assert.equal(items.find(i => i.id === note)?.memo, "the card ends in 4242");
    const file = JSON.parse(readFileSync(join(dataDir, "later", "owner.json"), "utf8")) as { items: LaterItem[] };
    assert.equal(file.items.find(i => i.id === note)?.memo, "the card ends in 4242");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the memo round-trips and survives a restart from chat.sqlite", async () => {
  const { dataDir, lines, items, post, note } = await roundTrip("later");
  try {
    assert.deepEqual(lines.filter(line => /^chat db: later .*imported \d+ records/.test(line)), [], "the restart reads the rows, not the file");
    assert.equal(items.find(i => i.id === `dm_vent:${post}`)?.memo, "read before the Thursday call");
    assert.equal(items.find(i => i.id === note)?.memo, "the card ends in 4242");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
