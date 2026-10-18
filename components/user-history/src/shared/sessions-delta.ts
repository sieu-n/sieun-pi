import type { ChatAgent, SessionRow, SessionsDelta, SessionsEvent, SessionRowPatch } from "./types.ts";

/**
 * The sessions feed as changes. On 10-18 the full list held 2556 rows and 1.4 MB of JSON, and the service sent all of it about once a second,
 * about 250 KB/s per tab after compression. The Mac in Korea reads this box at about 370 KB/s over a 185 ms round trip, so the socket backed
 * up and a thread's snapshot waited 13 to 30 s behind old lists. Most frames change one agent's `lastActivityAt` in a chat's 171-agent row.
 * A page that subscribes with `delta: true` gets one full list, then new rows whole, changed fields of changed rows, changed agents of a
 * changed `agents` list, and an id order only where the rebuilt order would differ.
 */

/** The order the catalog sorts rows in (src/chat-catalog.ts `project`): latest activity first, a stable sort. */
const activity = (row: SessionRow): number => Date.parse(row.lastActivityAt ?? row.created ?? "");
export const byActivity = (left: SessionRow, right: SessionRow): number => activity(right) - activity(left);

type Fields = Record<string, unknown>;

function patchAgents(agents: readonly ChatAgent[], patch: NonNullable<SessionRowPatch["agents"]>): ChatAgent[] {
  const byKey = new Map(agents.map(agent => [agent.key, agent]));
  for (const key of patch.remove) byKey.delete(key);
  for (const agent of patch.upsert) byKey.set(agent.key, agent);
  return patch.order ? patch.order.flatMap(key => byKey.get(key) ?? []) : [...byKey.values()];
}

function patchRow(row: SessionRow, patch: SessionRowPatch): SessionRow {
  const next: Fields = { ...row, ...patch.set };
  for (const key of patch.unset ?? []) delete next[key];
  if (patch.agents) next.agents = patchAgents(row.agents ?? [], patch.agents);
  return next as unknown as SessionRow;
}

/** The page's list after a delta: patched and new rows, sorted by activity, or put in `order` when it is sent. */
export function applySessionsDelta(rows: readonly SessionRow[], delta: SessionsDelta): SessionRow[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const id of delta.remove) byId.delete(id);
  for (const patch of delta.patch) { const row = byId.get(patch.id); if (row) byId.set(patch.id, patchRow(row, patch)); }
  for (const row of delta.add) byId.set(row.id, row);
  if (delta.order) return delta.order.flatMap(id => byId.get(id) ?? []);
  return [...byId.values()].sort(byActivity);
}

const json = (value: unknown): string | undefined => JSON.stringify(value);

function diffAgents(before: readonly ChatAgent[], after: readonly ChatAgent[]): NonNullable<SessionRowPatch["agents"]> {
  const old = new Map(before.map(agent => [agent.key, json(agent)]));
  const keys = new Set(after.map(agent => agent.key));
  const patch: NonNullable<SessionRowPatch["agents"]> = { upsert: after.filter(agent => old.get(agent.key) !== json(agent)), remove: [...old.keys()].filter(key => !keys.has(key)) };
  const rebuilt = patchAgents(before, patch);
  if (rebuilt.length !== after.length || rebuilt.some((agent, index) => agent.key !== after[index]?.key)) patch.order = after.map(agent => agent.key);
  return patch;
}

/** A list that names one key twice (a job listed by its child id and by its session, seen 10-18) goes out whole instead. */
const uniqueKeys = (agents: readonly ChatAgent[] | undefined): agents is readonly ChatAgent[] => !!agents && new Set(agents.map(agent => agent.key)).size === agents.length;

function diffRow(before: SessionRow, after: SessionRow): SessionRowPatch {
  const patch: SessionRowPatch = { id: after.id };
  const old = before as unknown as Fields, now = after as unknown as Fields;
  const set: Fields = {};
  const unset: string[] = [];
  for (const key of new Set([...Object.keys(old), ...Object.keys(now)])) {
    if (json(old[key]) === json(now[key])) continue;
    if (now[key] === undefined) unset.push(key);
    else if (key === "agents" && uniqueKeys(before.agents) && uniqueKeys(after.agents)) patch.agents = diffAgents(before.agents ?? [], after.agents ?? []);
    else set[key] = now[key];
  }
  if (Object.keys(set).length) patch.set = set as Partial<SessionRow>;
  if (unset.length) patch.unset = unset;
  return patch;
}

const rowJson = new WeakMap<SessionsEvent, Map<string, string>>();
/** Each row's JSON, computed once per catalog event and shared by every socket that gets it. */
function jsonOf(event: SessionsEvent): Map<string, string> {
  let rows = rowJson.get(event);
  if (!rows) { rows = new Map(event.sessions.map(row => [row.id, JSON.stringify(row)])); rowJson.set(event, rows); }
  return rows;
}

/** One subscriber's view: the first event goes out whole, each later one as a delta against what this subscriber holds, or not at all when nothing changed. */
export class SessionsDiff {
  private sent: { rows: readonly SessionRow[]; json: Map<string, string>; rest: string } | null = null;

  frame(event: SessionsEvent): SessionsEvent | SessionsDelta | null {
    const rows = jsonOf(event);
    const rest = JSON.stringify([event.tags, event.daemon, event.error ?? null]);
    const previous = this.sent;
    this.sent = { rows: event.sessions, json: rows, rest };
    if (!previous) return event;
    const before = new Map(previous.rows.map(row => [row.id, row]));
    const add: SessionRow[] = [];
    const patch: SessionRowPatch[] = [];
    for (const row of event.sessions) {
      const old = before.get(row.id);
      if (!old) add.push(row);
      else if (previous.json.get(row.id) !== rows.get(row.id)) patch.push(diffRow(old, row));
    }
    const remove = [...previous.json.keys()].filter(id => !rows.has(id));
    const delta: SessionsDelta = { type: "sessions-delta", add, patch, remove, tags: event.tags, daemon: event.daemon, ...(event.error !== undefined ? { error: event.error } : {}) };
    const rebuilt = applySessionsDelta(previous.rows, delta);
    if (rebuilt.length !== event.sessions.length || rebuilt.some((row, index) => row.id !== event.sessions[index]?.id)) delta.order = event.sessions.map(row => row.id);
    if (!add.length && !patch.length && !remove.length && !delta.order && rest === previous.rest) return null;
    return delta;
  }
}
