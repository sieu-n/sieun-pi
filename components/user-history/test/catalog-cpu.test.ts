// 10-18 owner report on us-metal02: "this box isn't busy (~50% cpu util) but the web server sieu-pi keep crashing, super buggy". A scratch copy
// of the box chat spent 82% of its main thread busy; chat-jobs.json was parsed 48 times a second and each page's sessions frame re-sorted 2,556 rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedJsonFile, type JsonFile, transactJsonFile } from "../src/locked-json.ts";
import { applySessionsDelta, SessionsDiff } from "../src/shared/sessions-delta.ts";
import type { SessionRow, SessionsDelta, SessionsEvent } from "../src/shared/types.ts";

test("a hot JSON file is parsed again only after it changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cached-json-"));
  try {
    let parses = 0;
    const file: JsonFile<{ jobs: Record<string, number> }> = { path: join(dir, "chat-jobs.json"), label: "test", initial: () => ({ jobs: {} }),
      parse: value => { parses++; return value as { jobs: Record<string, number> }; } };
    writeFileSync(file.path, JSON.stringify({ jobs: { a: 1 } }));
    for (let read = 0; read < 50; read++) assert.deepEqual(await cachedJsonFile(file), { jobs: { a: 1 } });
    assert.equal(parses, 1);
    await transactJsonFile(file, state => { state.jobs.b = 2; });
    const afterWrite = parses;
    assert.deepEqual(await cachedJsonFile(file), { jobs: { a: 1, b: 2 } });
    assert.equal(parses, afterWrite + 1, "a write through transactJsonFile is seen at the next read");
    writeFileSync(file.path, JSON.stringify({ jobs: { c: 3 } }));
    assert.deepEqual(await cachedJsonFile(file), { jobs: { c: 3 } }, "a write in place by another process is seen too");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a frame that changes rows in place sends no order and the page keeps the server's order", () => {
  const base = Date.parse("2026-10-18T05:00:00Z");
  const rows = Array.from({ length: 2556 }, (_, n) => ({ id: `id-${n}`, name: `thread ${n}`, cwd: "/", lastActivityAt: new Date(base - n * 1000).toISOString() }) as SessionRow);
  const event = (sessions: SessionRow[]): SessionsEvent => ({ type: "sessions", sessions, tags: [], daemon: "up" });
  const diff = new SessionsDiff();
  diff.frame(event(rows));
  const changed = rows.map((row, n) => n === 7 ? { ...row, name: "renamed", lastActivityAt: new Date(base - 6500).toISOString() } : row);
  const frame = diff.frame(event(changed)) as SessionsDelta;
  assert.equal(frame.type, "sessions-delta");
  assert.equal(frame.order, undefined);
  assert.deepEqual(applySessionsDelta(rows, frame).map(row => row.id), changed.map(row => row.id));

  const moved = [changed[9]!, ...changed.slice(0, 9), ...changed.slice(10)].map((row, n) => n === 0 ? { ...row, lastActivityAt: new Date(base + 1000).toISOString() } : row);
  const reorder = diff.frame(event(moved)) as SessionsDelta;
  assert.deepEqual(applySessionsDelta(changed, reorder).map(row => row.id), moved.map(row => row.id), "a row that moved to the top still lands there");
});
