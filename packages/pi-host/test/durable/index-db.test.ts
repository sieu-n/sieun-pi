/** An index from before the cost split gains the four cost columns and drops its derived rows, so the threads backfill them again. */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ThreadIndex } from "../../src/durable/index.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-index-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("an index without the cost split is rebuilt, and a current one is not", () => {
  const path = join(dir, "index.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL, thinking TEXT NOT NULL, cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, wake_active INTEGER NOT NULL DEFAULT 0, wake_at INTEGER, failed INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, preview TEXT NOT NULL DEFAULT '', children INTEGER NOT NULL DEFAULT 0, indexed_entry INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE usage (thread TEXT NOT NULL, conversation INTEGER NOT NULL, entry_id INTEGER NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost REAL NOT NULL, PRIMARY KEY (thread, entry_id));
    INSERT INTO threads (id, name, provider, model_id, thinking, cwd, created_at, updated_at, indexed_entry) VALUES ('t1', 'old', 'anthropic', 'claude-opus-5-5', 'high', '/', 1, 1, 40);
    INSERT INTO usage VALUES ('t1', 1, 12, 'anthropic/claude-opus-5-5', 1, 10, 10, 0, 0, 0.5);`);
  old.close();

  const migrated = new ThreadIndex(path);
  assert.equal(migrated.rebuilt, true);
  assert.equal(migrated.indexedEntry("t1"), 0);
  assert.deepEqual(migrated.usage({}), []);
  migrated.close();

  const again = new ThreadIndex(path);
  assert.equal(again.rebuilt, false);
  again.close();
});
