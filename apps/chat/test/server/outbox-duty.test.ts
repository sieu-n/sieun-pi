/**
 * The duty precheck `scripts/duties/outbox.ts` on a chat.sqlite of its own: a row or kept send older than 15 min counts as stuck and a newer
 * one does not, a failed row is flagged as failed, a refused log line counts, a retry line is info only, and more than 600 finished ids flag
 * that compaction stopped.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { outboxCheck, STUCK_MS } from "../../scripts/duties/outbox.ts";

const dir = mkdtempSync(join(tmpdir(), "apps-chat-outbox-duty-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 10, 26, 0, 0);

function db(): DatabaseSync {
  const d = new DatabaseSync(join(dir, `${Math.random()}.sqlite`));
  d.exec("CREATE TABLE outbox_rows (request_id TEXT PRIMARY KEY, ord INTEGER NOT NULL, body TEXT NOT NULL); " +
    "CREATE TABLE outbox_kept (request_id TEXT PRIMARY KEY, ord INTEGER NOT NULL, body TEXT NOT NULL); " +
    "CREATE TABLE outbox_done (request_id TEXT PRIMARY KEY, ord INTEGER NOT NULL, at INTEGER NOT NULL)");
  return d;
}
const row = (id: string, at: number, state: string) => JSON.stringify({ requestId: id, conversation: "t1:1", text: "hi", at, state, attempts: 4, error: state === "failed" ? "archived" : undefined });

test("an empty outbox reads clean", () => {
  const result = outboxCheck(db(), NOW, []);
  assert.deepEqual(result.flagged, []);
  assert.equal(result.metrics.outbox_stuck, 0);
  assert.equal(result.metrics.outbox_done_rows, 0);
});

test("old rows and kept sends count as stuck, new ones do not", () => {
  const d = db();
  const add = d.prepare("INSERT INTO outbox_rows VALUES (?, ?, ?)");
  add.run("old", 1, row("old", NOW - STUCK_MS - 1, "sending"));
  add.run("bad", 2, row("bad", NOW - 2 * STUCK_MS, "failed"));
  add.run("new", 3, row("new", NOW - 1000, "sending"));
  d.prepare("INSERT INTO outbox_kept VALUES (?, ?, ?)").run("k", 4, JSON.stringify({ thread: "t2", at: NOW - STUCK_MS - 1, input: { requestId: "k", text: "@x" } }));
  const result = outboxCheck(d, NOW, [
    "2026-11-26T00:00:00Z outbox: a to t1:1 refused: no thread t1",
    "2026-11-26T00:00:00Z outbox: b to t1:1 attempt 1 failed, retry in 500 ms: ECONNREFUSED",
  ]);
  assert.equal(result.metrics.outbox_stuck, 3);
  assert.equal(result.metrics.outbox_refused_24h, 1);
  assert.equal(result.metrics.retries_24h, 1);
  assert.deepEqual(result.flagged.map(f => f.kind).sort(), ["kept_stuck", "refused", "row_failed", "row_sending_stuck"]);
});

test("more than 600 finished ids flag that compaction stopped", () => {
  const d = db();
  const add = d.prepare("INSERT INTO outbox_done VALUES (?, ?, ?)");
  for (let i = 0; i < 601; i++) add.run(`d${i}`, i, NOW - 30 * 3600_000);
  const result = outboxCheck(d, NOW, []);
  assert.equal(result.metrics.outbox_done_rows, 601);
  assert.equal(result.metrics.done_oldest_h, 30);
  assert.deepEqual(result.flagged.map(f => f.kind), ["done_not_compacted"]);
});
