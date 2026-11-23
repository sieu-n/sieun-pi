/**
 * The fixture server with agents, rooms, state, For lists and the old channel files kept in chat.sqlite (APPS_CHAT_DB_KINDS): each route
 * write lands in the rows, the rows render the file the JSON path writes for the same records, a restart reads the same records and
 * imports nothing, and the week's JSON export is that file byte for byte.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/rooms-agents-db.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { docKind, docText, type DocSpec } from "../../server/chat-records.ts";
import { drained } from "../../server/disk.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { AGENTS, FOR_ME, ROOMS, STATE } from "../../server/record-kinds.ts";
import type { ForMeList } from "../../web/src/lib/api/types.ts";
import { start, type Running } from "./helpers.ts";

const KINDS = "agents,rooms,state,for_me,channels";
const before = process.env.APPS_CHAT_DB_KINDS;
process.env.APPS_CHAT_DB_KINDS = KINDS;
const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-rooms-db-"));
after(() => {
  if (before === undefined) delete process.env.APPS_CHAT_DB_KINDS;
  else process.env.APPS_CHAT_DB_KINDS = before;
  rmSync(dataDir, { recursive: true, force: true });
});

const spec = (s: DocSpec<object>) => s;
const SPECS = [AGENTS, ROOMS, STATE, FOR_ME].map(s => spec(s as unknown as DocSpec<object>));
/** Each document as the JSON path would write it for the records the server holds. */
function files(s: Running): Map<string, string> {
  const forMe = s.app.forMe as unknown as { file: object };
  return new Map([
    ["agents.json", docText(s.app.agentStore.agents)], ["rooms.json", docText(s.app.agentStore.rooms)],
    ["state.json", docText(s.app.store.state)], ["for-me.json", docText(forMe.file)],
  ]);
}

test("route writes land in chat.sqlite, a restart reads them back and imports nothing, and the export is the JSON path's file", async () => {
  let s = await start({ dataDir });
  try {
    assert.deepEqual([...s.app.records.kinds].sort(), KINDS.split(",").sort());
    const vent = s.app.agentStore.agentOf(agents.vent)!;
    assert.equal((await s.send("POST", `/api/c/${vent.room}/read`, {})).status, 200);
    assert.equal((await s.send("PUT", `/api/c/${ids.cutoverChannel}/prefs`, { starred: true })).status, 200);
    assert.equal((await s.send("PATCH", "/api/owner-settings", { presence: { away: true } })).status, 200);
    assert.equal((await s.send("PATCH", `/api/rooms/${ids.cutoverChannel}/members/${agents.crawler}`, { wakeOn: "none" })).status, 200);
    const item = (await s.get<ForMeList>(`/api/agents/${agents.vent}/for-me?status=all`)).items[0]!;
    assert.equal((await s.send("POST", `/api/agents/${agents.vent}/for-me`, { messageId: item.id, completed: item.status !== "completed" })).status, 200);
    await s.app.records.saved();

    const held = files(s);
    for (const each of SPECS) assert.equal(docKind(each).dump(s.app.chatDb.db, each.file), held.get(each.file), `${each.file}: the rows render the JSON path's file`);
    assert.equal(s.app.store.state.sidebar?.[ids.cutoverChannel]?.starred, true);

    for (const move of [...s.app.moves.values()].filter(m => SPECS.some(each => each.kind === m.kind.kind))) await move.flushExports();
    await drained();
    for (const [file, text] of held) assert.equal(readFileSync(join(dataDir, file), "utf8"), text, `${file}: the export is the JSON path's file`);
    for (const each of SPECS) assert.deepEqual(s.app.moves.get(each.kind)!.check().items, [], `${each.kind}: sw ${each.kind} check finds nothing to do`);

    const host = s.host;
    await s.close();
    const lines: string[] = [];
    s = await start({ dataDir, host: host as never, log: line => lines.push(line) });
    assert.deepEqual(lines.filter(line => / imported \d+ records/.test(line)), [], "a second boot imports nothing");
    const again = files(s);
    for (const [file, text] of held) assert.equal(again.get(file), text, `${file}: the restart reads the same records`);
  } finally {
    await s.close();
  }
});
