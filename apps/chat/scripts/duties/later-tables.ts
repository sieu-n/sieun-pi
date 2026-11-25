/**
 * Duty precheck: the tables behind the Later list (owner's words, dm_duty-check-1125201916d2-1 p1, 11-25, msg mwwkh7ri: "review the tables
 * behind the Later list in apps/chat (the later_* ones in chat.sqlite) and keep watching them").
 * Reads chat.sqlite read-only: later_principals names each principal with a list, later_items holds one row per saved item with the item as
 * server/later.ts keeps it in `body` (server/later-db.ts). It writes nothing.
 *
 * Metrics:
 *   later_drift: principals whose rows and copy elsewhere differ. While the week of JSON exports lasts (db_kinds export_until), each
 *     later/<by>.json must equal what `LATER.dump` renders from the rows; the owner's list the server serves (GET /api/later?test=1) must hold
 *     the same items as his rows, or the server's memory and the DB went apart, as a write that failed and was left out would leave them.
 *   later_bad_rows: rows a reader would trip on: a body that does not parse, an id or by that differs from the row's, a field LaterItem needs
 *     that is missing or wrong, a row of a principal later_principals does not name, and a second row of one principal with the same ord.
 *   later_stale_items: rows nobody reads: items of a principal whose agent is gone from agents_agents, of a test agent that is archived or
 *     whose save is over a day old, owner items in a test room that is archived or over a day old, and items whose room is gone. A walk
 *     runs minutes (saved-walk-7 ran 2 min 8 s on 11-24), and a boot unsaves an archived walk's items (later.ts `dropWalkLeftovers`).
 *
 * Usage: OUTPUT_FILE=<file> node --import tsx scripts/duties/later-tables.ts [--data-dir <dir>] [--server http://127.0.0.1:5184]
 * Defaults: APPS_CHAT_DATA_DIR else ~/.pi/agent/chat, APPS_CHAT_URL else http://127.0.0.1:5184. Without OUTPUT_FILE the result prints.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import type { FlaggedSlice } from "../../web/src/lib/api/shared/chat-duties.ts";
import { LATER, PRINCIPAL } from "../../server/later-db.ts";

const DAY_MS = 86_400_000;
/** How long the server's list read may take; it answered in under 50 ms on 11-25. */
const SERVER_WAIT_MS = 5000;
const STATES = new Set(["open", "done", "archived"]);
/** The fields the precheck compares between the served list and the rows; a served row adds what it shows, such as its room's name. */
const ITEM_KEYS = ["id", "by", "room", "post", "note", "savedAt", "state", "doneAt", "archivedAt", "remindAt", "notifiedAt", "unread", "memo"] as const;

type Row = { by: string; id: string; ord: number; body: string };
/** One problem row or principal; `cause` groups the findings, such as "owner items in archived test rooms". */
type Flag = { kind: "drift" | "bad_row" | "stale"; item: string; cause: string; text: string };
type Thing = { test?: boolean; archived?: boolean; room?: string };

const { values } = parseArgs({ options: { "data-dir": { type: "string" }, server: { type: "string" } } });
const dataDir = values["data-dir"] ?? process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat");
const server = values.server ?? process.env.APPS_CHAT_URL ?? "http://127.0.0.1:5184";
const now = Date.now();
const flags: Flag[] = [];
const notes: string[] = [];

const db = new DatabaseSync(join(dataDir, "chat.sqlite"), { readOnly: true });
const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(r => r.name));
const kind = db.prepare("SELECT imported_at, export_until FROM db_kinds WHERE kind = 'later'").get() as { imported_at: string | null; export_until: string | null } | undefined;
const moved = !!kind?.imported_at && tables.has("later_items");
const principals = moved ? (db.prepare("SELECT by FROM later_principals ORDER BY by").all() as { by: string }[]).map(r => r.by) : [];
const rows = moved ? (db.prepare("SELECT by, id, ord, body FROM later_items ORDER BY by, ord").all() as Row[]).map(r => ({ ...r, ord: Number(r.ord) })) : [];
const bodies = new Map<string, Record<string, unknown>>();

function bodyOf(row: Row): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(row.body) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** What is wrong with a row's item, or undefined when later.ts can read it. */
function rowProblem(row: Row, item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return "its body is no JSON object";
  if (item.id !== row.id) return `its body's id is ${JSON.stringify(item.id)}`;
  if (item.by !== row.by) return `its body's by is ${JSON.stringify(item.by)}`;
  if (typeof item.state !== "string" || !STATES.has(item.state)) return `its state is ${JSON.stringify(item.state)}`;
  if (typeof item.savedAt !== "number" || item.savedAt <= 0) return "it has no savedAt time";
  if (typeof item.note === "string") return row.id.startsWith("note:") ? undefined : "a note's id does not start with note:";
  if (typeof item.room !== "string" || typeof item.post !== "string") return "it names no room and post and holds no note";
  if (row.id !== `${item.room}:${item.post}`) return `its id is not ${item.room}:${item.post}`;
  return undefined;
}

// Bad rows.
const named = new Set(principals);
const ords = new Map<string, Map<number, string>>();
for (const row of rows) {
  const item = bodyOf(row);
  const problem = rowProblem(row, item);
  if (item && !problem) bodies.set(`${row.by} ${row.id}`, item);
  const ref = `${row.by}/${row.id}`;
  if (problem) flags.push({ kind: "bad_row", item: ref, cause: "unreadable rows", text: `The row ${ref} is unreadable: ${problem}.` });
  if (!named.has(row.by)) flags.push({ kind: "bad_row", item: ref, cause: "rows of a principal later_principals does not name", text: `The row ${ref} belongs to ${row.by}, which later_principals does not name.` });
  if (!PRINCIPAL.test(row.by)) flags.push({ kind: "bad_row", item: ref, cause: "rows of a principal that is neither owner nor an agent id", text: `The row ${ref} belongs to ${row.by}, which is neither owner nor an agent id.` });
  const seen = ords.get(row.by) ?? new Map<number, string>();
  ords.set(row.by, seen);
  const twin = seen.get(row.ord);
  if (twin !== undefined) flags.push({ kind: "bad_row", item: ref, cause: "rows that share an ord with another row of their principal", text: `The rows ${row.by}/${twin} and ${ref} share ord ${row.ord}, so the list's order between them is undefined.` });
  else seen.set(row.ord, row.id);
}

// Drift between the rows and the JSON exports, while the week of exports lasts.
const drifted = new Set<string>();
const exportsOn = moved && (kind?.export_until == null || now < Date.parse(kind.export_until));
const files = LATER.files(dataDir);
if (!moved) notes.push("The Later lists are in later/<by>.json, not in chat.sqlite: APPS_CHAT_DB_KINDS on this box leaves out later, so the tables hold nothing to check.");
else if (exportsOn) {
  for (const file of [...new Set([...files, ...principals.map(by => `later/${by}.json`)])].sort()) {
    const path = join(dataDir, file);
    const text = existsSync(path) ? readFileSync(path, "utf8") : null;
    const dump = LATER.dump(db, file);
    if (text === dump) continue;
    const by = file.slice("later/".length, -".json".length);
    drifted.add(by);
    const why = text === null ? "the file is missing" : dump === null ? "later_principals does not name it" : "the file and the rows hold different items";
    flags.push({ kind: "drift", item: by, cause: `later/*.json files that differ from their rows because ${why}`, text: `${file} differs from its rows: ${why}. A server restart imports a file an older release wrote; else \`curl -X POST ${server}/api/db/later/apply\` writes the export.` });
  }
} else if (files.length) {
  notes.push(`The week of JSON exports ended at ${kind?.export_until}; ${files.length} later/*.json files wait for the next boot, which moves them to json-archive/later/. They are no drift.`);
}

// The owner's list as the server holds it against his rows.
try {
  const res = await fetch(`${server}/api/later?test=1`, { signal: AbortSignal.timeout(SERVER_WAIT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const served = ((await res.json()) as { items: Record<string, unknown>[] }).items;
  const pick = (item: Record<string, unknown>) => JSON.stringify(ITEM_KEYS.map(key => item[key] ?? null));
  const mine = rows.filter(r => r.by === "owner").map(r => bodies.get(`owner ${r.id}`) ?? { id: r.id });
  const servedById = new Map(served.map(item => [item.id as string, pick(item)]));
  const apart = mine.filter(item => servedById.get(item.id as string) !== pick(item)).map(item => item.id as string);
  const extra = served.filter(item => !mine.some(m => m.id === item.id)).map(item => item.id as string);
  if (moved && (apart.length || extra.length)) {
    drifted.add("owner");
    flags.push({ kind: "drift", item: "owner", cause: "the owner's served list apart from his rows", text: `The server's owner list and his rows differ: ${apart.length} rows the server holds otherwise or not at all (${apart.slice(0, 5).join(", ")}), ${extra.length} items with no row (${extra.slice(0, 5).join(", ")}). A restart reads the rows again; read the server log for "write later owner failed".` });
  }
} catch (error) {
  notes.push(`The server at ${server} did not answer GET /api/later (${error instanceof Error ? error.message : String(error)}), so the owner's served list was not compared with his rows.`);
}

// Stale rows: agents and rooms as the server keeps them in chat.sqlite.
const stale = new Set<string>();
if (tables.has("agents_agents") && tables.has("rooms_rooms")) {
  const parse = (body: string): Thing => { try { return JSON.parse(body) as Thing; } catch { return {}; } };
  const agents = new Map((db.prepare("SELECT id, body FROM agents_agents").all() as { id: string; body: string }[]).map(r => [r.id, parse(r.body)]));
  const rooms = new Map((db.prepare("SELECT id, body FROM rooms_rooms").all() as { id: string; body: string }[]).map(r => [r.id, parse(r.body)]));
  for (const row of rows) {
    const item = bodies.get(`${row.by} ${row.id}`);
    if (!item) continue;
    const ref = `${row.by}/${row.id}`;
    const old = now - (item.savedAt as number) > DAY_MS;
    const room = typeof item.room === "string" ? rooms.get(item.room) : undefined;
    let why: [cause: string, text: string] | undefined;
    if (row.by !== "owner") {
      const agent = agents.get(row.by);
      if (!agent) why = ["items of agents that are gone", `its agent ${row.by} is gone`];
      else if (agent.test && agent.archived) why = ["items of archived test agents, which the next boot unsaves", `its agent ${row.by} is an archived walk's test agent`];
      else if (agent.test && old) why = ["items of test agents not archived, saved over a day ago", `its agent ${row.by} is a walk's test agent that saved it over a day ago`];
    }
    if (!why && typeof item.room === "string" && !room) why = ["items whose room is gone", `its room ${item.room} is gone`];
    else if (!why && row.by === "owner" && room?.test && room.archived) why = ["owner items in archived test rooms, which the next boot unsaves", `it is in the archived test room ${item.room}`];
    else if (!why && row.by === "owner" && room?.test && old) why = ["owner items in test rooms not archived, saved over a day ago", `it is in the test room ${item.room}, saved over a day ago`];
    if (!why) continue;
    stale.add(ref);
    flags.push({ kind: "stale", item: ref, cause: why[0], text: `The row ${ref} is stale: ${why[1]}.` });
  }
} else if (moved) {
  notes.push("chat.sqlite holds no agents_agents or rooms_rooms table, so stale rows were not counted.");
}

const counts = new Map<string, number>();
for (const row of rows) counts.set(row.by, (counts.get(row.by) ?? 0) + 1);
const empty = principals.filter(by => !counts.has(by));
const badRows = new Set(flags.filter(f => f.kind === "bad_row").map(f => f.item)).size;
const findings = [
  `chat.sqlite holds ${principals.length} Later principals and ${rows.length} rows: ${[...counts].map(([by, n]) => `${by} ${n}`).join(", ") || "none"}.` +
    (empty.length ? ` ${empty.length} principals have an empty list (${empty.join(", ")}); the row stays so the export writes their empty file.` : ""),
  exportsOn ? `The week of JSON exports runs until ${kind?.export_until}; ${files.length} later/*.json files were compared with their rows and ${flags.filter(f => f.cause.startsWith("later/")).length} differ.` : "",
  `${drifted.size} principals drift, ${badRows} rows are bad and ${stale.size} rows are stale.`,
  ...notes,
  ...[...new Set(flags.map(f => f.cause))].map(cause => {
    const ids = flags.filter(f => f.cause === cause).map(f => f.item);
    return `${ids.length} ${cause}: ${ids.slice(0, 6).join(", ")}${ids.length > 6 ? ` and ${ids.length - 6} more` : ""}.`;
  }),
].filter(Boolean);
const flagged: FlaggedSlice[] = flags.map(f => ({ kind: `later_${f.kind}`, excerpt: f.text, sig: `${f.kind} ${f.item}` }));
const output = { metrics: { later_drift: drifted.size, later_bad_rows: badRows, later_stale_items: stale.size }, findings, flagged };
db.close();

const json = `${JSON.stringify(output, null, 1)}\n`;
if (process.env.OUTPUT_FILE) writeFileSync(process.env.OUTPUT_FILE, json);
else process.stdout.write(json);
