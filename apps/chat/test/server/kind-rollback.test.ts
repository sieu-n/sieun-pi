/**
 * A rollback by kind: a boot whose APPS_CHAT_DB_KINDS leaves out a kind a server moved into chat.sqlite puts that kind back on its JSON files
 * (json-move.ts `returnDropped`), written from the rows also after a file went to json-archive/, so the server and every reader that follows
 * `db_kinds` read the files; a later boot that names the kind again imports what changed in them and starts a new week of exports.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/kind-rollback.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { movedKinds } from "../../server/chat-records.ts";
import { FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { Store } from "../../server/store.ts";
import { start, type Running } from "./helpers.ts";

const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-kind-rollback-"));
after(() => rmSync(dataDir, { recursive: true, force: true }));

const kinds = () => {
  const db = new DatabaseSync(join(dataDir, "chat.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT kind, imported_at, export_until FROM db_kinds WHERE kind IN ('agents', 'rooms', 'state') ORDER BY kind").all() as
      { kind: string; imported_at: string | null; export_until: string | null }[];
  } finally {
    db.close();
  }
};
const sidebarRow = (conversation: string) => {
  const db = new DatabaseSync(join(dataDir, "chat.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT body FROM state_sidebar WHERE conversation = ?").get(conversation) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  } finally {
    db.close();
  }
};

test("a boot without a moved kind puts it back on its files, and a boot that names it again imports what changed there", async () => {
  const [first, second] = [ids.cutoverChannel, ids.generalChannel];
  // Restored at the end, since specs run with --test-isolation=none share the process's env.
  const before = process.env.APPS_CHAT_DB_KINDS;
  process.env.APPS_CHAT_DB_KINDS = "agents,rooms,state";
  let s: Running = await start({ dataDir });
  const host = s.host;
  try {
    assert.equal((await s.send("PUT", `/api/c/${first}/prefs`, { starred: true })).status, 200);
    await s.app.records.saved();
    await s.close();
    assert.deepEqual(movedKinds(dataDir).filter(kind => ["agents", "rooms", "state"].includes(kind)), ["agents", "rooms", "state"]);
    // The week of exports ended and state.json went to json-archive/, so only the rows hold the star.
    mkdirSync(join(dataDir, "json-archive", "state"), { recursive: true });
    renameSync(join(dataDir, "state.json"), join(dataDir, "json-archive", "state", "state.json"));

    process.env.APPS_CHAT_DB_KINDS = "agents,rooms";
    const lines: string[] = [];
    s = await start({ dataDir, host: host as never, log: line => lines.push(line) });
    assert.equal(lines.filter(line => line.startsWith("chat db: state is back on its JSON files")).length, 1, lines.join("\n"));
    assert.ok(existsSync(join(dataDir, "state.json")), "state.json is written from the rows");
    assert.deepEqual(kinds().map(row => [row.kind, row.imported_at === null, row.export_until === null]), [["agents", false, false], ["rooms", false, false], ["state", true, true]]);
    delete process.env.APPS_CHAT_DB_KINDS;
    const reader = new Store(dataDir);
    assert.equal(reader.records.inDb("state"), false, "a reader with no env follows db_kinds back to state.json");
    assert.equal(reader.state.sidebar?.[first]?.starred, true);
    assert.equal(s.app.store.state.sidebar?.[first]?.starred, true, "the server reads the star from state.json");
    assert.equal((await s.send("PUT", `/api/c/${second}/prefs`, { starred: true })).status, 200);
    await s.close();
    assert.equal(sidebarRow(second), undefined, "the JSON path's write is not in the rows");

    process.env.APPS_CHAT_DB_KINDS = "agents,rooms,state";
    lines.length = 0;
    s = await start({ dataDir, host: host as never, log: line => lines.push(line) });
    assert.equal(lines.filter(line => /^chat db: state imported \d+ records from 1 JSON files/.test(line)).length, 1, lines.join("\n"));
    assert.deepEqual(sidebarRow(second), { starred: true }, "the rows hold the change made on the JSON path");
    assert.equal(sidebarRow(first)?.starred, true);
    assert.equal(s.app.store.state.sidebar?.[second]?.starred, true);
    assert.ok(kinds().every(row => row.imported_at !== null && row.export_until !== null), "the kind is moved again with a new week of exports");
    assert.deepEqual(s.app.moves.get("state")!.check().items, []);
  } finally {
    await s.close();
    if (before === undefined) delete process.env.APPS_CHAT_DB_KINDS;
    else process.env.APPS_CHAT_DB_KINDS = before;
  }
});
