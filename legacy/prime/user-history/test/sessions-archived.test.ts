// Guards the 10-18 cold loads from Korea: every page load and reconnect pulled the full sessions list, 2,754 rows and 1.5 MB of JSON (281 KB on the wire), of which 2,531 archived rows were 1.0 MB, and app.js (190 KB) took 11 to 22 s beside it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applySessionsDelta, SessionsDiff, withoutArchived } from "../src/shared/sessions-delta.ts";
import type { SessionRow, SessionsDelta, SessionsEvent } from "../src/shared/types.ts";

const BASE = Date.parse("2026-10-18T05:00:00Z");
const row = (n: number, archived: boolean): SessionRow =>
  ({ id: `id-${n}`, name: `thread ${n}`, cwd: "/home/sieun", archived, lastActivityAt: new Date(BASE - n * 1000).toISOString() }) as SessionRow;
const event = (rows: SessionRow[]): SessionsEvent => ({ type: "sessions", sessions: rows, tags: [], daemon: "up" });
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test("a page that did not ask for archived rows gets the others and a count of the rest", () => {
  const rows = Array.from({ length: 2754 }, (_, n) => row(n, n >= 223));
  const full = event(rows);
  const view = withoutArchived(full);
  assert.equal(view.sessions.length, 223);
  assert.equal(view.archived, 2531);
  assert.ok(view.sessions.every(item => !item.archived));
  assert.equal(withoutArchived(full), view, "one view per catalog event, shared by every socket");
  const first = new SessionsDiff().frame(view);
  assert.ok(JSON.stringify(first).length * 10 < JSON.stringify(new SessionsDiff().frame(full)).length);
});

test("archiving a row takes it out of the list and counts it, and unarchiving puts it back", () => {
  const diff = new SessionsDiff();
  let rows = Array.from({ length: 30 }, (_, n) => row(n, n >= 20));
  let held: SessionRow[] = [];
  const take = (frame: SessionsEvent | SessionsDelta | null) => {
    if (!frame) return null;
    const read = wire(frame);
    held = read.type === "sessions" ? read.sessions : applySessionsDelta(held, read);
    return read.archived;
  };
  assert.equal(take(diff.frame(withoutArchived(event(rows)))), 10);
  rows = rows.map(item => item.id === "id-3" ? { ...item, archived: true } : item);
  assert.equal(take(diff.frame(withoutArchived(event(rows)))), 11);
  assert.ok(!held.some(item => item.id === "id-3"));
  rows = rows.map(item => item.id === "id-3" || item.id === "id-25" ? { ...item, archived: false } : item);
  assert.equal(take(diff.frame(withoutArchived(event(rows)))), 9);
  assert.deepEqual(held.map(item => item.id), rows.filter(item => !item.archived).map(item => item.id));
});

test("a page that asks for archived rows gets the whole list", () => {
  const rows = Array.from({ length: 10 }, (_, n) => row(n, n % 2 === 0));
  const frame = new SessionsDiff().frame(event(rows));
  assert.equal(frame?.type === "sessions" && frame.sessions.length, 10);
});
