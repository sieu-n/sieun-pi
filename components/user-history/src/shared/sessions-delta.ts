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

function patchAgents<Agent extends { key: string }>(agents: readonly Agent[], patch: { upsert: Agent[]; remove: string[]; order?: string[] }): Agent[] {
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
  // Each row's time is read once: a comparator that parsed both dates ran Date.parse about 50,000 times a frame over 2,556 rows.
  const keyed = [...byId.values()].map(row => ({ row, at: activity(row) }));
  return keyed.sort((left, right) => right.at - left.at).map(entry => entry.row);
}

/**
 * Whether a page that applies a delta without `order` ends with the rows in `next`'s order: true when `next` keeps the ids of `previous` in
 * the same order and is already sorted newest first, since a stable sort leaves a sorted list as it is. A row with no time reads false, so
 * the full check runs.
 */
function keepsOrder(previous: readonly SessionRow[], next: readonly SessionRow[]): boolean {
  if (previous.length !== next.length) return false;
  let before = Infinity;
  for (const [index, row] of next.entries()) {
    if (row.id !== previous[index]!.id) return false;
    const at = activity(row);
    if (!(at <= before)) return false;
    before = at;
  }
  return true;
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
/** Each row object's JSON: the catalog hands out an unchanged row as the same object in each event (`KeptRow` in src/chat-catalog.ts) and never changes a row it sent. */
const rowText = new WeakMap<SessionRow, string>();
function textOf(row: SessionRow): string {
  let text = rowText.get(row);
  if (text === undefined) { text = JSON.stringify(row); rowText.set(row, text); }
  return text;
}
/** Each row's JSON, computed once per catalog event and shared by every socket that gets it. */
function jsonOf(event: SessionsEvent): Map<string, string> {
  let rows = rowJson.get(event);
  if (!rows) { rows = new Map(event.sessions.map(row => [row.id, textOf(row)])); rowJson.set(event, rows); }
  return rows;
}

/**
 * The list without its archived rows, for a page that did not ask for them (`archived: true` on the feed), with `archived` counting the rows
 * left out. On 10-18 2,531 of 2,754 rows were archived: 1.0 MB of the 1.5 MB first frame, which each page load and each reconnect from Korea
 * pulled beside app.js on the same 185 ms link. One view per catalog event, shared by every socket, and its rows are the event's own objects.
 */
const unarchived = new WeakMap<SessionsEvent, SessionsEvent>();
export function withoutArchived(event: SessionsEvent): SessionsEvent {
  let view = unarchived.get(event);
  if (!view) {
    const sessions = event.sessions.filter(row => !row.archived);
    view = { ...event, sessions, archived: event.sessions.length - sessions.length };
    unarchived.set(event, view);
  }
  return view;
}

/** JSON with each object's keys sorted, so the page and the server write a row the same way whatever order its fields were set in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? "null" : canonical(item)).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const fields = Object.keys(value).filter(key => (value as Fields)[key] !== undefined).sort();
  return `{${fields.map(key => `${JSON.stringify(key)}:${canonical((value as Fields)[key])}`).join(",")}}`;
}

/**
 * A short hash of a row's or an agent's content (FNV-1a over its canonical JSON): a reconnecting page names each one it holds by it
 * (`SessionsDiff.resume`, `AgentsDiff`).
 */
export function rowHash(row: SessionRow | ChatAgent): string {
  const text = canonical(row);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(36);
}

/** A page names at most this many rows on a reconnect; one that holds more (the archived rows too) gets the whole list. */
export const RESUME_ROWS = 1000;

const have = <Item extends SessionRow | ChatAgent>(items: readonly Item[], id: (item: Item) => string): string | undefined =>
  items.length && items.length <= RESUME_ROWS ? items.map(item => `${id(item)}:${rowHash(item)}`).join(",") : undefined;

/** What a reconnecting page holds, as the feed's `have`: `id:hash` per row, comma-separated. */
export const sessionsHave = (rows: readonly SessionRow[]): string | undefined => have(rows, row => row.id);
/** The same for an agents feed: `key:hash` per agent, in the page's order. */
export const agentsHave = (agents: readonly ChatAgent[]): string | undefined => have(agents, agent => agent.key);

/** A `have` as id to hash, in the page's order, or null for one that does not parse or names more than `RESUME_ROWS`. */
export function parseHave(text: string): Map<string, string> | null {
  const held = new Map<string, string>();
  for (const item of text.split(",")) {
    const at = item.lastIndexOf(":");
    if (at <= 0) return null;
    held.set(item.slice(0, at), item.slice(at + 1));
  }
  return held.size <= RESUME_ROWS ? held : null;
}

/**
 * A chat row without its `agents`, with `agentsRunning` and `agentsTotal` in their place; any other row as it is. On 10-18 the agents lists were
 * 385 KB of the 482 KB sessions frame from the Mac (1,074 agents, 423 of them done) while the page shows one chat's agents at a time. Kept per
 * row object, so a row the catalog kept stays the same object here too.
 */
const slimRows = new WeakMap<SessionRow, SessionRow>();
function slimRow(row: SessionRow): SessionRow {
  if (!row.agents) return row;
  let slim = slimRows.get(row);
  if (!slim) {
    const { agents, ...rest } = row;
    slim = { ...rest, agentsRunning: agents.filter(agent => agent.state === "working").length, agentsTotal: agents.length };
    slimRows.set(row, slim);
  }
  return slim;
}
const slimEvents = new WeakMap<SessionsEvent, SessionsEvent>();
/** The event with every chat row's agents left out (`slimRow`); one view per event, shared by every socket. */
export function withoutAgents(event: SessionsEvent): SessionsEvent {
  let view = slimEvents.get(event);
  if (!view) { view = { ...event, sessions: event.sessions.map(slimRow) }; slimEvents.set(event, view); }
  return view;
}

/** One `agents` feed frame: the chat's agents, and for a job's session the chat whose agent it is and what `store.openJob` takes for it. */
export interface AgentsView { chat: string | null; open?: string; agents: ChatAgent[] }
/**
 * An agents frame for a page that subscribed with `delta: true`: the agents that differ from what the page holds by `key`, the keys gone,
 * and the order only where patching would not rebuild it (`patchAgents`).
 */
export interface AgentsDelta { type: "agents-delta"; chat: string | null; open?: string; upsert: ChatAgent[]; remove: string[]; order?: string[] }
/** The agents a page asks for with `{ feed: "agents", id }`: `id` is a chat, or a job's session that a chat lists as its subagent or root. */
export function agentsView(rows: readonly SessionRow[], id: string): AgentsView {
  const chat = rows.find(row => row.id === id && row.chat);
  if (chat) return { chat: chat.id, agents: chat.agents ?? [] };
  for (const row of rows) {
    if (!row.chat) continue;
    const agent = row.agents?.find(entry => entry.sessionId === id && (entry.link === "subagent" || entry.link === "root"));
    if (agent) return { chat: row.id, open: agent.job, agents: row.agents ?? [] };
  }
  return { chat: null, agents: [] };
}

/**
 * One subscriber's view: the first event goes out whole, each later one as a delta against what this subscriber holds, or not at all when
 * nothing changed. A page that reconnects names the rows it holds (`resume`), and its first frame is a delta with only the rows that differ.
 */
export class SessionsDiff {
  private sent: { rows: readonly SessionRow[]; json: Map<string, string>; rest: string } | null = null;
  private held: Map<string, string> | null = null;

  /** The rows the page holds, by `rowHash`, from a reconnect's `have`. */
  resume(held: Map<string, string>): void { if (!this.sent) this.held = held; }

  frame(event: SessionsEvent): SessionsEvent | SessionsDelta | null {
    const rows = jsonOf(event);
    const rest = JSON.stringify([event.tags, event.daemon, event.error ?? null, event.archived ?? null]);
    const previous = this.sent;
    this.sent = { rows: event.sessions, json: rows, rest };
    const held = this.held;
    this.held = null;
    if (!previous && held) {
      return { type: "sessions-delta", add: event.sessions.filter(row => held.get(row.id) !== rowHash(row)), patch: [], remove: [...held.keys()].filter(id => !rows.has(id)),
        order: event.sessions.map(row => row.id), tags: event.tags, daemon: event.daemon, ...(event.error !== undefined ? { error: event.error } : {}),
        ...(event.archived !== undefined ? { archived: event.archived } : {}) };
    }
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
    const delta: SessionsDelta = { type: "sessions-delta", add, patch, remove, tags: event.tags, daemon: event.daemon, ...(event.error !== undefined ? { error: event.error } : {}), ...(event.archived !== undefined ? { archived: event.archived } : {}) };
    // The common frame changes fields of rows that keep their places, which needs no rebuild; on 10-18 the rebuild per socket and frame
    // was 4.4% of the box chat's main thread with three pages open.
    if (!keepsOrder(previous.rows, event.sessions)) {
      const rebuilt = applySessionsDelta(previous.rows, delta);
      if (rebuilt.length !== event.sessions.length || rebuilt.some((row, index) => row.id !== event.sessions[index]?.id)) delta.order = event.sessions.map(row => row.id);
    }
    if (!add.length && !patch.length && !remove.length && !delta.order && rest === previous.rest) return null;
    return delta;
  }
}

/**
 * A chat's agents in the order `chatAgents` (src/chat-agents.ts) gives them: working first, by key, then the rest with the latest activity
 * first, a stable sort. Working agents keep their places while they run: sorted by activity they swapped places every few seconds, and each
 * swap moved a sidebar row, which restarted its spinner and cost a style recalc of the whole page (10-19, 195 row moves in 20 s on the live sidebar).
 * An agent that sleeps on a wake reads working (`withWaits`, after the sort), so it sorts with the agents whose turn ended.
 */
export function sortAgents<Agent extends ChatAgent>(agents: Agent[]): Agent[] {
  const working = (agent: Agent) => Number(agent.state === "working" && !agent.wait);
  const at = new Map(agents.map(agent => [agent, Date.parse(agent.lastActivityAt ?? "") || 0]));
  return agents.sort((left, right) => working(right) - working(left)
    || (working(left) ? (left.key < right.key ? -1 : left.key > right.key ? 1 : 0) : at.get(right)! - at.get(left)!));
}

/** The agents view a page holds after an agents frame: a whole view replaces it, and a delta patches it and sorts it unless it sent `order`. */
export function applyAgentsFrame(view: AgentsView | null, frame: AgentsView | AgentsDelta): AgentsView {
  if (!("upsert" in frame)) return frame;
  const agents = patchAgents(view?.agents ?? [], frame);
  return { chat: frame.chat, ...(frame.open !== undefined ? { open: frame.open } : {}), agents: frame.order ? agents : sortAgents(agents) };
}

/**
 * One agents feed subscriber's view, the way `SessionsDiff` serves the sessions feed: the first frame goes out whole, each later one as the
 * agents that changed, or not at all. A page that reconnects names the agents it holds (`agentsHave`), and its first frame is a delta with
 * only the agents that differ. The order goes along only when `applyAgentsFrame`'s sort would not rebuild it. On 10-18 the feed sent the
 * whole list on every change: 01a1164b's 252 agents, 229 of them not working, were 84 KB a frame and 73 frames a minute, and a reconnect
 * pulled them again.
 */
export class AgentsDiff {
  private sent: AgentsView | null = null;

  /** `held` is a reconnecting page's `have`, the agents it holds by `rowHash`, in its order. */
  constructor(private held: Map<string, string> | null = null) {}

  frame(view: AgentsView): AgentsView | AgentsDelta | null {
    const previous = this.sent, held = this.held;
    this.sent = view;
    this.held = null;
    if (!previous && held && uniqueKeys(view.agents)) {
      const now = new Map(view.agents.map(agent => [agent.key, agent]));
      const kept = [...held.keys()].flatMap(key => now.get(key) ?? []);
      return this.delta(view, kept, view.agents.filter(agent => held.get(agent.key) !== rowHash(agent)), [...held.keys()].filter(key => !now.has(key)));
    }
    if (!previous || !uniqueKeys(previous.agents) || !uniqueKeys(view.agents)) return previous && json(previous) === json(view) ? null : view;
    const old = new Map(previous.agents.map(agent => [agent.key, json(agent)]));
    const keys = new Set(view.agents.map(agent => agent.key));
    const delta = this.delta(view, previous.agents, view.agents.filter(agent => old.get(agent.key) !== json(agent)), [...old.keys()].filter(key => !keys.has(key)));
    return delta.upsert.length || delta.remove.length || delta.order || view.chat !== previous.chat || view.open !== previous.open ? delta : null;
  }

  /** The delta from the page's `before` list, with `order` only when the page's patch and sort would put the agents elsewhere. */
  private delta(view: AgentsView, before: readonly ChatAgent[], upsert: ChatAgent[], remove: string[]): AgentsDelta {
    const delta: AgentsDelta = { type: "agents-delta", chat: view.chat, ...(view.open !== undefined ? { open: view.open } : {}), upsert, remove };
    const rebuilt = sortAgents(patchAgents(before, { upsert, remove }));
    if (rebuilt.length !== view.agents.length || rebuilt.some((agent, index) => agent.key !== view.agents[index]!.key)) delta.order = view.agents.map(agent => agent.key);
    return delta;
  }
}
