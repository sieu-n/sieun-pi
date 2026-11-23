/**
 * Later, wakes, duties and queued board writes kept in chat.sqlite (APPS_CHAT_DB_KINDS): a boot imports their JSON files once, a second boot
 * imports nothing, the records survive a restart, and a file an older release changed after a rollback wins at the next boot, records it
 * took away included.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/later-wakes-duties-db.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { LaterItem } from "../../web/src/lib/api/types.ts";
import type { DutyFile } from "../../server/boards.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { seedFixture } from "../../server/fixture/seed.ts";
import { start, type Running } from "./helpers.ts";

const KINDS = "later,wakes,duties,board-writes";
let kept: string | undefined;
let dataDir: string;
let host: FixtureHost;

before(() => {
  kept = process.env.APPS_CHAT_DB_KINDS;
  process.env.APPS_CHAT_DB_KINDS = KINDS;
  dataDir = mkdtempSync(join(tmpdir(), "apps-chat-move5-"));
  host = new FixtureHost();
  host.wordMs = 0;
  seedFixture(host, dataDir);
});
after(() => {
  if (kept === undefined) delete process.env.APPS_CHAT_DB_KINDS;
  else process.env.APPS_CHAT_DB_KINDS = kept;
  rmSync(dataDir, { recursive: true, force: true });
});

const item = (post: string, savedAt: number): LaterItem => ({ id: `dm_vent:${post}`, by: "owner", room: "dm_vent", post, savedAt, state: "open" });
const laterFile = (items: LaterItem[]) => `${JSON.stringify({ v: 1, items }, null, 1)}\n`;
const boot = async (lines: string[]): Promise<Running> => start({ dataDir, host, log: line => lines.push(line) });
const imports = (lines: string[]) => lines.filter(line => / imported \d+ records/.test(line) && /^chat db: (later|wakes|duties|board-writes) /.test(line));

test("a boot imports the JSON files once, the records survive a restart, and an older release's changes win at the next boot", async () => {
  mkdirSync(join(dataDir, "later"), { recursive: true });
  writeFileSync(join(dataDir, "later", "owner.json"), laterFile([item("p2", 2000), item("p1", 1000)]));

  const first: string[] = [];
  let s = await boot(first);
  assert.deepEqual(imports(first).map(line => line.split(" ")[2]).sort(), ["duties", "later"], first.join("\n"));
  assert.deepEqual(s.app.later.items("owner").map(i => i.id), ["dm_vent:p2", "dm_vent:p1"]);
  const thread = ids.vent;
  for (const note of ["a", "b"]) {
    const armed = await s.send("POST", `/api/threads/${thread}/wakes`, { id: `${thread}-1-${note}`, conversation: 1, on: { kind: "time", at: Date.now() + 3_600_000 }, note, since: Date.now() });
    assert.equal(armed.status, 200, JSON.stringify(armed.body));
  }
  const duties = { ...s.app.boards.dutyFile(agents.vent), hidden: 1234 } as DutyFile;
  await s.app.boards.saveDuties(agents.vent, duties);
  for (const kind of ["later", "wakes", "duties", "board-writes"]) {
    const check = await s.get<{ json: number; db: number; items: unknown[] }>(`/api/db/${kind}/check`);
    assert.equal(check.json, check.db, `${kind}: ${JSON.stringify(check)}`);
  }
  await s.close();

  const second: string[] = [];
  s = await boot(second);
  assert.deepEqual(imports(second), [], "a second boot imports nothing");
  assert.deepEqual(s.app.boards.db.wakes.list().map(({ id }) => id).filter(id => id.startsWith(thread)), [`${thread}-1-a`, `${thread}-1-b`]);
  assert.equal(s.app.boards.dutyFile(agents.vent).hidden, 1234);
  await s.close();

  // An older release after a rollback: it unsaved p1, and its ticker sent wake a and removed its file.
  writeFileSync(join(dataDir, "later", "owner.json"), laterFile([item("p2", 2000)]));
  rmSync(join(dataDir, "wakes", `${thread}-1-a.json`));
  const third: string[] = [];
  s = await boot(third);
  assert.deepEqual(s.app.later.items("owner").map(i => i.id), ["dm_vent:p2"], "the item the older release unsaved is gone");
  assert.deepEqual(s.app.boards.db.wakes.list().map(({ id }) => id).filter(id => id.startsWith(thread)), [`${thread}-1-b`], "the wake it sent never goes out again");
  assert.ok(third.some(line => line.includes("wakes dropped 1")), third.join("\n"));
  await s.close();
  assert.equal(existsSync(join(dataDir, "wakes", `${thread}-1-b.json`)), true);
  assert.equal(JSON.parse(readFileSync(join(dataDir, "later", "owner.json"), "utf8")).items.length, 1);
});
