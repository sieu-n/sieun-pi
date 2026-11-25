/**
 * Duty precheck: the outbox tables in chat.sqlite (owner's words, DM with duty check 1125201916d2 3, 11-26 05:19 KST, msg mwwkh7ua: "can
 * you look at how the outbox tables in chat.sqlite are doing? i want you monitoring them going forward").
 *
 * The outbox (server/outbox.ts) keeps three tables in chat.sqlite (server/outbox-db.ts):
 *   outbox_rows: the owner's sends that pi-host has not shown as an input yet. A row is `sending` until pi-host takes it, `sent` until the
 *     sweep (every 3 s) finds its input or 6 h pass, and `failed` when pi-host refused it for good, until the owner retries or discards it.
 *   outbox_kept: the other sends (an @mention, a `[board]` line, an edit or delete notice), retried at most 30 s apart until pi-host takes them.
 *   outbox_done: the request ids that finished, kept a day so a repeated send does not show twice. The server drops the ones older than a
 *     day at start, and when the outbox empties while it holds more than 500, so between restarts it may keep them longer.
 * A row or kept send leaves within seconds when pi-host works, so one older than STUCK_MS means pi-host does not take it, its input never
 * matched, or the owner has a failed send waiting on his page.
 *
 * Metrics:
 *   outbox_stuck, the headline: rows and kept sends older than STUCK_MS (target 0).
 *   outbox_done_rows: finished ids the table holds (target 600, the server's 500 compaction line plus room); more means compaction stopped.
 *   outbox_refused_24h: sends pi-host refused for good in the last 24 h, from the server's `outbox: <id> ... refused` log lines (target 0).
 * Info only: rows, kept, done_oldest_h and retries_24h, the `attempt N failed` lines, which a pi-host restart makes for a few seconds.
 *
 * Usage: OUTPUT_FILE=<file> node --import tsx scripts/duties/outbox.ts [--db <chat.sqlite>] [--unit sieun-pi-apps-chat] [--no-journal]
 * The DB defaults to APPS_CHAT_DATA_DIR/chat.sqlite, else ~/.pi/agent/chat/chat.sqlite. Without OUTPUT_FILE the result prints to stdout.
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

/** A healthy send leaves the outbox within seconds; 15 min covers a long pi-host restart. */
export const STUCK_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

interface Flag { kind: string; at: number; sig: string; excerpt: string }
export interface OutboxCheck { metrics: Record<string, number>; flagged: Flag[] }

/** Reads the outbox tables and the server's outbox log lines of the last day, as of `now`. */
export function outboxCheck(db: DatabaseSync, now: number, logLines: readonly string[]): OutboxCheck {
  const rows = (db.prepare("SELECT request_id, body FROM outbox_rows ORDER BY ord").all() as { request_id: string; body: string }[])
    .map(r => ({ id: r.request_id, row: JSON.parse(r.body) as { conversation?: string; text?: string; at: number; state?: string; attempts?: number; error?: string } }));
  const kept = (db.prepare("SELECT request_id, body FROM outbox_kept ORDER BY ord").all() as { request_id: string; body: string }[])
    .map(r => ({ id: r.request_id, send: JSON.parse(r.body) as { thread?: string; at: number; input?: { text?: string } } }));
  const done = db.prepare("SELECT count(*) AS n, min(at) AS oldest FROM outbox_done").get() as { n: number; oldest: number | null };
  const flagged: Flag[] = [];
  for (const { id, row } of rows) {
    if (now - row.at <= STUCK_MS) continue;
    flagged.push({
      kind: row.state === "failed" ? "row_failed" : `row_${row.state ?? "unknown"}_stuck`, at: row.at, sig: id,
      excerpt: `${row.conversation} ${row.state} after ${row.attempts ?? 0} tries${row.error ? `, ${row.error}` : ""}: ${(row.text ?? "").slice(0, 120)}`,
    });
  }
  for (const { id, send } of kept) {
    if (now - send.at <= STUCK_MS) continue;
    flagged.push({ kind: "kept_stuck", at: send.at, sig: id, excerpt: `to ${send.thread}: ${(send.input?.text ?? "").slice(0, 120)}` });
  }
  const outbox = logLines.filter(line => /\boutbox: /.test(line));
  const refused = outbox.filter(line => / refused: /.test(line));
  for (const line of refused) flagged.push({ kind: "refused", at: now, sig: line.slice(0, 80), excerpt: line.slice(0, 240) });
  const doneRows = Number(done.n);
  if (doneRows > 600) flagged.push({ kind: "done_not_compacted", at: Number(done.oldest ?? now), sig: "outbox_done", excerpt: `${doneRows} finished ids held, oldest ${((now - Number(done.oldest ?? now)) / 3600_000).toFixed(1)} h` });
  return {
    metrics: {
      outbox_stuck: flagged.filter(f => f.kind.startsWith("row_") || f.kind === "kept_stuck").length,
      outbox_done_rows: doneRows,
      outbox_refused_24h: refused.length,
      rows: rows.length,
      kept: kept.length,
      done_oldest_h: done.oldest === null ? 0 : Math.round(((now - Number(done.oldest)) / 3600_000) * 10) / 10,
      retries_24h: outbox.filter(line => / failed, retry in /.test(line)).length,
    },
    flagged,
  };
}

/** The unit's log lines of the last day that name the outbox; none when journalctl is missing. */
function journalLines(unit: string): string[] {
  try {
    return execFileSync("journalctl", ["--user", "-u", unit, "--since", "-24h", "--no-pager", "-o", "cat", "--grep", "outbox: "], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean);
  } catch {
    // journalctl exits 1 when --grep matches nothing.
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { db: { type: "string" }, unit: { type: "string" }, "no-journal": { type: "boolean" } } });
  const path = resolve(values.db ?? join(process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat"), "chat.sqlite"));
  if (!existsSync(path)) throw new Error(`no chat.sqlite at ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  const result = outboxCheck(db, Date.now(), values["no-journal"] ? [] : journalLines(values.unit ?? "sieun-pi-apps-chat"));
  db.close();
  const json = JSON.stringify({ ...result, windowMs: { outbox_refused_24h: DAY_MS } }, null, 1);
  if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
  else process.stdout.write(`${json}\n`);
}
