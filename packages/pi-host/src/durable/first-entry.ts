/**
 * Each conversation's first own entry, read straight from a thread file with one indexed lookup per conversation.
 *
 * A thread open (`backfill`, a task's first input) and a cold `tree` (a node's title and time) read a conversation's first entries through
 * pi-durable's page read, which fetches `limit + 1` rows, so it always loads the second entry too. That entry is the conversation's
 * `pi.system` prompt, about 88 KB in every job: on 11-23 a cold open plus tree of 72ba1ed2's 445 conversations parsed 55 MB of JSON and held
 * pi-host's loop 369 ms and then 424 ms (~/work/pi-host-stalls/e-cold-tree/report.md). The first entry alone is 2.3 MB for all of them.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export class FirstEntries {
  private db: DatabaseSync | undefined;
  private statement: StatementSync | undefined;

  constructor(private readonly file: string) {}

  /**
   * The first entry of a conversation's own entries, or undefined when it has none or the file does not read. It sees committed entries
   * only, so a caller falls back to pi-durable's read when this gives nothing it can use.
   */
  get(conversation: number): EntryRecord | undefined {
    try {
      this.db ??= new DatabaseSync(this.file, { readOnly: true });
      this.statement ??= this.db.prepare("SELECT record FROM entries WHERE conversation_id = ? ORDER BY id ASC LIMIT 1");
      const row = this.statement.get(conversation) as { record?: string } | undefined;
      return row?.record ? (JSON.parse(row.record) as EntryRecord) : undefined;
    } catch {
      return undefined;
    }
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
    this.statement = undefined;
  }
}
