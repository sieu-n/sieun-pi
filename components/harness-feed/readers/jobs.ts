import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Context, Sample } from "../otlp.ts";
import { readNew } from "./chat-health.ts";
import { treeOfFile } from "./delivery.ts";
import { copyIndex, type CopyRow } from "./session-copy.ts";

/*
 * Jobs and subagents: how many work, wait in pi-pool's turn queue or sit parked on an account, what ends and restarts their turns, and how long
 * a new job waits for its first turn. A job is any session that is not a chat: an RLM subagent, or a root job the chat lists in chat-jobs.json.
 *
 * Every box with a pi-pool and a Prime daemon sends the box part: pi-pool's turns.json (the queue's own state, about 30 KB), pi-pool.log's
 * turn_admitted and turn_swept lines, and the RLM ledger's spawn and delete records. The chat host also sends the chat part, from service.log's
 * resume pass lines (chat-resume.ts resumeChatJobs), pool-held.json (PoolHeldJobs) and job-cancels.json. The chat's name comes from the
 * session copies the chat service keeps (session-copy.json and ~/.cache/sieun-pi/hosts/<box>.sessions.json); a box with no copy names no chat.
 *
 * Logs are read from a saved offset. The first round reads a tail only to learn what is already there (the resume pass logs every stopped and
 * held job again on each pass), so event counters start at 0 when the feed starts.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The sliding window of the first-turn wait quantiles. */
const WAIT_WINDOW_MS = 30 * MINUTE;
/** How far back a spawn is kept to find its first turn; a job with no turn after this is left out of the waits. */
const SPAWN_KEEP_MS = 24 * HOUR;
/** pi-pool.log grew about 0.75 MB an hour on us-metal02 on 10-22, so the first read covers the spawns kept. */
const POOL_FIRST_BYTES = 24_000_000;
/** service.log's first read: about 100 resume passes on 10-22, enough to see each stopped and held job once. */
const SERVICE_FIRST_BYTES = 6_000_000;
/** A chat or reason seen within this time keeps sending 0, so its series ends at 0 instead of holding its last value. */
const ZERO_KEEP_MS = HOUR;
/** pi-pool writes its `ts` in local time without a zone, and on us-metal02 the writers mix UTC and KST. */
const KST_MS = 9 * HOUR;
/** How many of the longest first-turn waits still open go out one by one. */
const TOP = 5;
const NO_COPY = "unknown chat";
const NO_CHAT = "no chat";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The ms a UUIDv7 session id was made, from its first 48 bits. */
export const idTime = (id: string): number => parseInt(id.replace(/-/g, "").slice(0, 12), 16);

// ---- names ----

/** What the chat service lists: its chats (chats.json, archived-chats.json) and the chat of each root job (chat-jobs.json). */
export interface Lists { chats: Set<string>; jobChat: Map<string, string> }

/** The rows of the session copies by session id and by name; `own` holds the ids of this box's copy. Built again only when a copy changed. */
export class Rows {
  readonly byId = new Map<string, CopyRow>();
  readonly byName = new Map<string, string>();
  readonly own = new Set<string>();
  readonly from: readonly (readonly CopyRow[])[];
  constructor(own: readonly CopyRow[], others: readonly (readonly CopyRow[])[]) {
    this.from = [own, ...others];
    for (const rows of this.from) for (const row of rows) {
      const held = this.byId.get(row.id);
      if (!held || (row.live && !held.live)) this.byId.set(row.id, row);
      if (row.name) this.byName.set(row.name, row.id);
    }
    for (const row of own) this.own.add(row.id);
  }
  /** True when `copies` are the arrays these rows came from: copyIndex answers the same array until its file changes. */
  same(copies: readonly (readonly CopyRow[])[]): boolean {
    return copies.length === this.from.length && copies.every((rows, index) => rows === this.from[index]);
  }
}

/** Names each session's chat from the session copies and the chat service's lists. */
export class Names {
  readonly rows: Rows;
  readonly lists: Lists;
  constructor(rows: Rows, lists: Lists) {
    this.rows = rows;
    this.lists = lists;
  }
  get byId(): Map<string, CopyRow> { return this.rows.byId; }
  get own(): Set<string> { return this.rows.own; }

  isChat(session: string, tree?: string): boolean {
    return this.lists.chats.size ? this.lists.chats.has(session) : session === (tree ?? this.rootOf(session));
  }

  /** The top of the session's tree: the folder its subagent file sits in, else its parent chain. */
  rootOf(session: string): string {
    const seen = new Set<string>();
    let id = session;
    for (;;) {
      const row = this.byId.get(id);
      if (!row || seen.has(id)) return id;
      seen.add(id);
      const fileRoot = treeOfFile(row.file ?? undefined);
      if (fileRoot) return fileRoot;
      if (row.topLevel || !row.parent) return id;
      id = row.parent;
    }
  }

  /** The name of the chat whose tree holds the session, "no chat" for a tree no chat owns, and "unknown chat" on a box with no copy. */
  chatOf(session: string, tree?: string): string {
    if (!this.lists.chats.size) return NO_COPY;
    const root = tree ?? this.rootOf(session);
    const name = this.byId.get(root)?.name;
    if (this.lists.chats.has(root)) return name?.replace(/\s+/g, " ").trim() || NO_COPY;
    return this.lists.jobChat.get(root) ?? (name ? this.lists.jobChat.get(name) : undefined) ?? NO_CHAT;
  }

  /** The chat of a job the resume pass names only by its name (its "interrupted" line). */
  chatOfName(name: string): string {
    if (!this.lists.chats.size) return NO_COPY;
    const job = this.lists.jobChat.get(name);
    if (job) return job;
    const id = this.rows.byName.get(name);
    return id ? this.chatOf(id) : NO_CHAT;
  }

  /** The chat whose id starts with `prefix`, as a "chat 01a15427:" line names it. */
  chatOfPrefix(prefix: string): string {
    for (const id of this.lists.chats) if (id.startsWith(prefix)) return this.chatOf(id, id);
    return NO_CHAT;
  }
}

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")) as unknown; } catch { return null; }
}

const idList = (value: unknown): string[] => isRecord(value) && Array.isArray(value.ids) ? value.ids.filter((id): id is string => typeof id === "string") : [];

/** chat-jobs.json `{jobs: {<session id or job name>: {chat, at, chatId?}}}`, as the chat name of each key, and the session-keyed jobs with their record time. */
export function jobsOf(value: unknown): { jobChat: Map<string, string>; roots: Map<string, number> } {
  const jobChat = new Map<string, string>(), roots = new Map<string, number>();
  if (!isRecord(value) || !isRecord(value.jobs)) return { jobChat, roots };
  for (const [key, job] of Object.entries(value.jobs)) {
    if (!isRecord(job) || typeof job.chat !== "string") continue;
    jobChat.set(key, job.chat);
    if (SESSION.test(key) && typeof job.at === "number") roots.set(key, job.at);
  }
  return { jobChat, roots };
}

// ---- events ----

/**
 * Event counters by label set. A label set goes out at 0 in the round it first counts and with its count from the next round on, because
 * increase() reads a series' first sample as its start: a series that first showed at 1 would lose that event.
 */
export class Counts {
  readonly values = new Map<string, { labels: Record<string, string>; value: number; shown: boolean }>();
  add(labels: Record<string, string>, by = 1): void {
    const key = JSON.stringify(labels);
    const held = this.values.get(key);
    if (held) held.value += by; else this.values.set(key, { labels, value: by, shown: false });
  }
  samples(base: Omit<Sample, "value" | "labels">): Sample[] {
    return [...this.values.values()].map(entry => {
      const value = entry.shown ? entry.value : 0;
      entry.shown = true;
      return { ...base, labels: entry.labels, value };
    });
  }
}

/** Why pi-pool holds a job, from the resume pass's `held_by` (resume_paused.py account_blocker, hook_blocker, own_slot_hold, queued_in_pool). */
export function heldReason(heldBy: string): string {
  if (/holds the tree until|is limited/.test(heldBy)) return "account limit";
  if (/is depleted/.test(heldBy)) return "account depleted";
  if (/is disabled/.test(heldBy)) return "account disabled";
  if (/no \S+ account can serve/.test(heldBy)) return "no account";
  if (/token hook gave no/.test(heldBy)) return "no token";
  if (/gave this session a slot/.test(heldBy)) return "slot wait";
  if (/^queued in pi-pool/.test(heldBy)) return "turn queue";
  return "other";
}

/** A cut turn's cause from the words turn-error.ts turnErrorCause and chat-resume.ts cutWords write. */
export function causeReason(words: string): string {
  if (/^no account token/.test(words)) return "no token";
  if (/^usage limit/.test(words)) return "usage limit";
  if (/^rate limit/.test(words)) return "rate limit";
  if (/^provider overloaded/.test(words)) return "overloaded";
  if (/^provider server error/.test(words)) return "server error";
  if (/^connection error/.test(words)) return "connection error";
  if (/^sign-in refused/.test(words)) return "sign-in refused";
  if (/^request refused/.test(words)) return "request refused";
  if (/^how is not recorded/.test(words)) return "not recorded";
  const verdict = /^([a-z_]+)(?: at |$)/.exec(words)?.[1];
  return verdict ? verdict.replace(/_/g, " ") : "other error";
}

/** Why the resume pass keeps a stopped job stopped (resume_paused.py `stopped`'s `why`). */
export function stoppedReason(why: string): string {
  if (/^its parent deleted it/.test(why)) return "parent deleted";
  if (/^a job above it was deleted/.test(why)) return "ancestor deleted";
  if (/^the RLM runtime deleted it/.test(why)) return "runtime deleted";
  if (/^deleted on purpose/.test(why)) return "deleted";
  if (/^its chat is on the owner's archived list|^the owner archived its chat/.test(why)) return "chat archived";
  if (/^archived by the owner|^the owner archived it/.test(why)) return "owner archived";
  if (/^the owner stopped it/.test(why)) return "owner stopped";
  if (/^the idle unload stopped it/.test(why)) return "idle unload";
  if (/^the chat service archived it/.test(why)) return "service archived";
  if (/^a new session replaced it/.test(why)) return "replaced";
  if (/^it finished/.test(why)) return "finished";
  return "other stop";
}

const HELD = /^job (.+): held by pi-pool until (?:\S+|a time it does not say): (.+) \(cut at (\S+), tree [0-9a-f]+, ([0-9a-f-]{36})(?: on \S+)?\)$/;
const INTERRUPTED = /^job (.+): interrupted \(([a-z_?]+) at (\S+)\); continue: (.*)$/;
const TURN_STOPPED = /^job (.+): turn stopped: (.+)\. Not resumed: (.+) \(([0-9a-f-]{36})(?: on \S+)?\)$/;
const STOPPED = /^job (.+): not resumed, stopped on purpose: (.+) \(([0-9a-f-]{36})(?: on \S+)?\)$/;
const UNRESOLVED = /^job (.+): not resumed: (.+) \(archive at (\S+), ([0-9a-f-]{36})(?: on \S+)?\)$/;
const CHECK_IN = /^chat ([0-9a-f]{8}): check-in restarted job (.+?): /;

/** The result of a continue the pass sent: "delivered" or "queued" by the daemon's answer, else "failed". */
export function continueResult(said: string): string {
  try {
    const value: unknown = JSON.parse(said);
    if (isRecord(value) && typeof value.deliveryStatus === "string") return value.deliveryStatus;
    return isRecord(value) && "error" in value ? "failed" : "other";
  } catch { return /error|fail/i.test(said) ? "failed" : "other"; }
}

/**
 * What the resume pass lines told so far: the counters, each cut and skip already counted with when a line last named it, and why and since
 * when pi-pool holds each job. The pass names every held and stopped job again on each run, so a key leaves only after FORGET_MS unnamed.
 */
export interface PassState {
  cut: Counts; resumed: Counts; skipped: Counts;
  cuts: Map<string, number>; skips: Map<string, number>;
  held: Map<string, { reason: string; cutAt: number; seenAt: number }>;
}
export const passState = (): PassState => ({ cut: new Counts(), resumed: new Counts(), skipped: new Counts(), cuts: new Map(), skips: new Map(), held: new Map() });
const FORGET_MS = 6 * HOUR;

/** Drops the keys no line named for FORGET_MS. */
export function forget(state: PassState, now: number): void {
  for (const map of [state.cuts, state.skips]) for (const [key, at] of map) if (now - at > FORGET_MS) map.delete(key);
  for (const [session, held] of state.held) if (now - held.seenAt > FORGET_MS) state.held.delete(session);
}

/** Folds one service.log line in; `count` is false for the first read, which only learns what was there. */
export function passLine(state: PassState, line: string, names: Names, count: boolean, now: number): void {
  if (!line.startsWith("job ") && !line.startsWith("chat ")) return;
  const cut = (name: string, at: string, reason: string, chat: string) => {
    const key = `${name}|${at}`;
    const known = state.cuts.has(key);
    state.cuts.set(key, now);
    if (!known && count) state.cut.add({ chat, reason });
  };
  const skip = (session: string, reason: string, chat: string, at = "") => {
    const key = `${session}|${reason}|${at}`;
    const known = state.skips.has(key);
    state.skips.set(key, now);
    if (!known && count) state.skipped.add({ chat, reason });
  };
  let m: RegExpExecArray | null;
  if ((m = HELD.exec(line))) {
    const [, name, heldBy, cutAt, session] = m;
    const reason = heldReason(heldBy!);
    const at = Date.parse(cutAt!);
    state.held.set(session!, { reason, cutAt: Number.isFinite(at) ? at : NaN, seenAt: now });
    cut(name!, cutAt!, reason, names.chatOf(session!));
  } else if ((m = INTERRUPTED.exec(line))) {
    const [, name, reason, at, said] = m;
    const chat = names.chatOfName(name!);
    cut(name!, at!, reason!.replace(/_/g, " "), chat);
    if (count) state.resumed.add({ chat, how: "resume pass", result: continueResult(said!) });
  } else if ((m = TURN_STOPPED.exec(line))) {
    const [, name, words, why, session] = m;
    const chat = names.chatOf(session!);
    const at = / at (\d{4}-\d\d-\d\dT[\d:.]+Z)$/.exec(words!)?.[1] ?? "";
    cut(name!, at, causeReason(words!), chat);
    skip(session!, /^no work is owed/.test(why!) ? "not owed" : stoppedReason(why!), chat, at);
  } else if ((m = STOPPED.exec(line))) {
    const [, , why, session] = m;
    skip(session!, stoppedReason(why!), names.chatOf(session!));
  } else if ((m = UNRESOLVED.exec(line))) {
    const [, , , at, session] = m;
    skip(session!, "unresolved", names.chatOf(session!), at);
  } else if ((m = CHECK_IN.exec(line))) {
    if (count) state.resumed.add({ chat: names.chatOfPrefix(m[1]!), how: "check-in", result: "restarted" });
  }
}

/** job-cancels.json `{<session>: {at, how, by}}`: each new stop or archive is a cut, "<by> <how>". */
export function cancelLines(value: unknown, seen: Set<string>, names: Names, cut: Counts, count: boolean): void {
  if (!isRecord(value)) return;
  for (const [session, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.how !== "string") continue;
    const key = `${session}|${String(entry.at)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (count) cut.add({ chat: names.chatOf(session), reason: `${typeof entry.by === "string" ? entry.by : "someone"} ${entry.how}` });
  }
}

// ---- the box part: ledger, pi-pool ----

/** A job this box started: its spawn time, name and chat; `root` marks a root job of chat-jobs.json. */
interface Spawn { at: number; name: string; chat: string; root: boolean; deletedAt?: number }

/** What the box part keeps: spawns of the last day, each session's first turn_admitted `ts` (read as UTC), and the counters. */
export interface BoxState {
  ledger: Map<string, Tail>;
  pool?: Tail;
  spawns: Map<string, Spawn>;
  firstAdmit: Map<string, number>;
  spawned: Counts; deleted: Counts; swept: Counts;
}
type Tail = NonNullable<Awaited<ReturnType<typeof readNew>>>["tail"];
export const boxState = (): BoxState => ({ ledger: new Map(), spawns: new Map(), firstAdmit: new Map(), spawned: new Counts(), deleted: new Counts(), swept: new Counts() });

const sessionOfFile = (file: unknown): string | null => typeof file === "string" && file.endsWith(".jsonl") ? basename(file, ".jsonl") : null;

/** One RLM ledger record (`{v, op: spawn|delete, at, childId, parent?, child, depth?, name?, reason?}`). */
export function ledgerLine(state: BoxState, line: string, names: Names, now: number, count: boolean): void {
  let record: unknown;
  try { record = JSON.parse(line); } catch { return; }
  if (!isRecord(record) || typeof record.at !== "string") return;
  const session = sessionOfFile(record.child);
  const at = Date.parse(record.at);
  if (!session || !Number.isFinite(at)) return;
  const tree = treeOfFile(record.child as string);
  if (record.op === "spawn") {
    const chat = names.chatOf(session, tree);
    if (now - at <= SPAWN_KEEP_MS) state.spawns.set(session, { at, name: typeof record.name === "string" ? record.name : String(record.childId ?? ""), chat, root: false });
    if (count) state.spawned.add({ chat, kind: "subagent" });
  } else if (record.op === "delete") {
    const spawn = state.spawns.get(session);
    if (spawn) spawn.deletedAt = at;
    if (count) state.deleted.add({ chat: spawn?.chat ?? names.chatOf(session, tree), reason: typeof record.reason === "string" ? record.reason : "unknown" });
  }
}

/** One pi-pool.log line: a session's first turn_admitted, and turn_swept (a working lease that ran out) as a cut by the pool. */
export function poolLine(state: BoxState, line: string, names: Names, count: boolean): void {
  const admitted = line.includes('"turn_admitted"');
  if (!admitted && !line.includes('"turn_swept"')) return;
  let row: unknown;
  try { row = JSON.parse(line); } catch { return; }
  if (!isRecord(row) || typeof row.session !== "string" || typeof row.ts !== "string") return;
  if (admitted) {
    if (state.firstAdmit.has(row.session)) return;
    const at = Date.parse(`${row.ts}Z`);
    if (Number.isFinite(at)) state.firstAdmit.set(row.session, at);
  } else if (count && row.event === "turn_swept" && row.part === "working" && !names.isChat(row.session)) {
    state.swept.add({ chat: names.chatOf(row.session), reason: "lease ran out" });
  }
}

/**
 * The epoch ms of a turn_admitted `ts` read as UTC: the earliest of it and of it less 9 h (KST) that is not before the spawn, less a minute
 * for the ledger's write after the first admit, and not after now. Null when neither fits.
 */
export function admitTime(raw: number, spawnAt: number, now: number): number | null {
  const fits = [raw - KST_MS, raw].filter(at => at >= spawnAt - MINUTE && at <= now + 2 * MINUTE);
  return fits.length ? fits[0]! : null;
}

const quantile = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

/** The first-turn waits: each job whose first turn started in the window, and each job still waiting for one. */
export function waitSamples(state: BoxState, names: Names, now: number): Sample[] {
  const done: number[] = [];
  const open: { age: number; session: string; spawn: Spawn }[] = [];
  for (const [session, spawn] of state.spawns) {
    if (now - spawn.at > SPAWN_KEEP_MS) { state.spawns.delete(session); continue; }
    const raw = state.firstAdmit.get(session);
    const admit = raw === undefined ? null : admitTime(raw, spawn.at, now);
    if (admit !== null) {
      if (now - admit <= WAIT_WINDOW_MS) done.push(Math.max(0, admit - spawn.at) / 1000);
      continue;
    }
    const row = names.byId.get(session);
    if (spawn.deletedAt !== undefined || (row && row.lifecycle !== "live")) continue;
    open.push({ age: Math.max(0, now - spawn.at) / 1000, session, spawn });
  }
  const keep = now - SPAWN_KEEP_MS - KST_MS;
  for (const [session, at] of state.firstAdmit) if (at < keep) state.firstAdmit.delete(session);
  const out: Sample[] = [{ name: "harness.jobs.first_turn_count", kind: "gauge", help: "Jobs whose first turn started in the last 30 minutes, the sample count of the first-turn wait.",
    value: done.length, labels: { window: "30m" } }];
  done.sort((a, b) => a - b);
  if (done.length) for (const [q, at] of [["p50", 0.5], ["p90", 0.9], ["p99", 0.99], ["max", 1]] as const) {
    out.push({ name: "harness.jobs.first_turn_wait", kind: "gauge", unit: "s", help: "How long jobs whose first turn started in the last 30 minutes waited from their spawn record to that turn's pi-pool admission.",
      value: q === "max" ? done.at(-1)! : quantile(done, at), labels: { q, window: "30m" } });
  }
  open.sort((a, b) => b.age - a.age);
  out.push({ name: "harness.jobs.first_turn_waiting", kind: "gauge", help: "Jobs spawned in the last day that are still waiting for their first turn.", value: open.length },
    { name: "harness.jobs.first_turn_waiting_oldest", kind: "gauge", unit: "s", help: "How long the job waiting longest for its first turn has waited since its spawn record.", value: open[0]?.age ?? 0 });
  open.slice(0, TOP).forEach((entry, index) => out.push({ name: "harness.jobs.first_turn_waiting_top", kind: "gauge", unit: "s",
    help: "The jobs waiting longest for their first turn, one series each.", value: entry.age,
    labels: { rank: String(index + 1), name: entry.spawn.name.slice(0, 60), session: entry.session, chat: entry.spawn.chat } }));
  return out;
}

/** pi-pool's turns.json: `{working: {<session>: {tree, kind, since, queued_since}}, queued: {<session>: {tree, since}}}`. */
export function turnSamples(value: unknown, names: Names, now: number, zero: Map<string, number>): Sample[] {
  if (!isRecord(value)) return [];
  const running = new Map<string, number>(), queued = new Map<string, number>(), oldest = new Map<string, number>();
  const each = (part: unknown, fn: (session: string, tree: string | undefined, entry: Record<string, unknown>) => void) => {
    if (isRecord(part)) for (const [session, entry] of Object.entries(part)) if (isRecord(entry)) fn(session, typeof entry.tree === "string" ? entry.tree : undefined, entry);
  };
  each(value.working, (session, tree) => {
    if (names.isChat(session, tree)) return;
    const chat = names.chatOf(session, tree);
    running.set(chat, (running.get(chat) ?? 0) + 1);
  });
  each(value.queued, (session, tree, entry) => {
    if (names.isChat(session, tree)) return;
    const chat = names.chatOf(session, tree);
    queued.set(chat, (queued.get(chat) ?? 0) + 1);
    if (typeof entry.since === "number") oldest.set(chat, Math.max(oldest.get(chat) ?? 0, now / 1000 - entry.since));
  });
  for (const chat of [...running.keys(), ...queued.keys()]) zero.set(chat, now);
  const out: Sample[] = [];
  for (const [chat, at] of zero) {
    if (now - at > ZERO_KEEP_MS) { zero.delete(chat); continue; }
    out.push({ name: "harness.jobs.running", kind: "gauge", help: "Jobs whose turn holds a pi-pool working slot on this box now, by chat.", value: running.get(chat) ?? 0, labels: { chat } },
      { name: "harness.jobs.queued", kind: "gauge", help: "Jobs whose turn waits in pi-pool's turn queue on this box now, by chat.", value: queued.get(chat) ?? 0, labels: { chat } },
      { name: "harness.jobs.queued_oldest", kind: "gauge", unit: "s", help: "How long the chat's longest-queued job turn has waited in pi-pool's queue.", value: Math.max(0, oldest.get(chat) ?? 0), labels: { chat } });
  }
  return out;
}

/** pool-held.json, the sessions the last resume pass left held by pi-pool, by chat and the reason its held line gave. */
export function parkedSamples(sessions: unknown, held: PassState["held"], names: Names, now: number, zero: Map<string, number>): Sample[] {
  const parked = new Map<string, { labels: Record<string, string>; count: number }>();
  const longest = new Map<string, number>();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (typeof session !== "string") continue;
    const told = held.get(session);
    const reason = told?.reason ?? "unknown";
    const labels = { chat: names.chatOf(session), reason };
    const key = JSON.stringify(labels);
    const entry = parked.get(key) ?? { labels, count: 0 };
    entry.count++;
    parked.set(key, entry);
    zero.set(key, now);
    if (told && Number.isFinite(told.cutAt)) longest.set(reason, Math.max(longest.get(reason) ?? 0, (now - told.cutAt) / 1000));
  }
  const out: Sample[] = [];
  for (const [key, at] of zero) {
    if (now - at > ZERO_KEEP_MS) { zero.delete(key); continue; }
    out.push({ name: "harness.jobs.parked", kind: "gauge", help: "Jobs the last resume pass left held by pi-pool until a slot or an account reset, by chat and reason.",
      value: parked.get(key)?.count ?? 0, labels: JSON.parse(key) as Record<string, string> });
  }
  for (const [reason, seconds] of longest) out.push({ name: "harness.jobs.parked_longest", kind: "gauge", unit: "s",
    help: "Time since the cut of the job held longest by pi-pool, by reason.", value: seconds, labels: { reason } });
  return out;
}

// ---- read ----

interface State { rows?: Rows; box: BoxState; pass: PassState; service?: Tail; cancels: Set<string>; cancelsRead: boolean; runningZero: Map<string, number>; parkedZero: Map<string, number> }

async function copies(ctx: Context): Promise<{ own: CopyRow[]; others: CopyRow[][] }> {
  const mirror = join(ctx.home, ".cache/sieun-pi/hosts");
  const files = (await readdir(mirror).catch(() => [] as string[])).filter(name => name.endsWith(".sessions.json")).map(name => join(mirror, name));
  const [own, ...others] = await Promise.all([join(ctx.home, ".prime/agent/browser-chat/session-copy.json"), ...files].map(file => copyIndex(file).catch(() => [] as CopyRow[])));
  return { own: own!, others };
}

async function catchUp(file: string, tail: Tail | undefined, firstBytes: number, fold: (line: string, count: boolean) => void): Promise<Tail | undefined> {
  const read = await readNew(file, tail, firstBytes);
  if (!read) return tail;
  for (const line of read.lines) fold(line, tail !== undefined);
  return read.tail;
}

export async function read(ctx: Context): Promise<Sample[]> {
  const state: State = (ctx.state.get("jobs") as State | undefined) ?? { box: boxState(), pass: passState(), cancels: new Set(), cancelsRead: false, runningZero: new Map(), parkedZero: new Map() };
  ctx.state.set("jobs", state);
  const { now } = ctx;
  const chatDir = join(ctx.home, ".prime/agent/browser-chat");
  const poolDir = process.env.PI_POOL_DIR || join(ctx.home, ".config", "pi-pool");
  const ledgerDir = join(ctx.home, ".prime/agent/rlm-ledger");
  const [copy, chatsValue, archivedValue, jobsValue, turns, ledgerFiles] = await Promise.all([
    ctx.chatHost ? copies(ctx) : { own: [], others: [] },
    ctx.chatHost ? readJson(join(chatDir, "chats.json")) : null,
    ctx.chatHost ? readJson(join(chatDir, "archived-chats.json")) : null,
    ctx.chatHost ? readJson(join(chatDir, "chat-jobs.json")) : null,
    readJson(join(poolDir, "turns.json")),
    readdir(ledgerDir).then(names => names.filter(name => name.endsWith(".jsonl")), () => [] as string[]),
  ]);
  const { jobChat, roots } = jobsOf(jobsValue);
  if (!state.rows?.same([copy.own, ...copy.others])) state.rows = new Rows(copy.own, copy.others);
  const names = new Names(state.rows, { chats: new Set([...idList(chatsValue), ...idList(archivedValue)]), jobChat });
  const box = state.box;

  for (const name of ledgerFiles) {
    const file = join(ledgerDir, name);
    const tail = await catchUp(file, box.ledger.get(file), Infinity, (line, count) => ledgerLine(box, line, names, now, count));
    if (tail) box.ledger.set(file, tail);
  }
  for (const [session, at] of roots) {
    if (box.spawns.has(session) || !names.own.has(session) || names.isChat(session, session)) continue;
    const spawnAt = Math.min(at, idTime(session));
    if (now - spawnAt <= SPAWN_KEEP_MS) box.spawns.set(session, { at: spawnAt, name: names.byId.get(session)?.name ?? session, chat: jobChat.get(session)!, root: true });
  }
  box.pool = await catchUp(join(poolDir, "pi-pool.log"), box.pool, POOL_FIRST_BYTES, (line, count) => poolLine(box, line, names, count));

  const out: Sample[] = [
    ...turnSamples(turns, names, now, state.runningZero),
    ...waitSamples(box, names, now),
    ...box.spawned.samples({ name: "harness.jobs.spawned", kind: "counter", help: "Jobs started on this box: RLM spawn records in the ledger, by chat." }),
    ...box.deleted.samples({ name: "harness.jobs.deleted", kind: "counter", help: "Jobs deleted on this box: RLM ledger delete records, by chat and the ledger's reason." }),
  ];
  if (!ctx.chatHost) return [...out, ...box.swept.samples({ name: "harness.jobs.cut", kind: "counter", help: CUT_HELP })];

  const pass = state.pass;
  state.service = await catchUp(join(chatDir, "service.log"), state.service, SERVICE_FIRST_BYTES, (line, count) => passLine(pass, line, names, count, now));
  forget(pass, now);
  cancelLines(await readJson(join(chatDir, "job-cancels.json")), state.cancels, names, pass.cut, state.cancelsRead);
  state.cancelsRead = true;
  out.push(...parkedSamples(await readJson(join(chatDir, "pool-held.json")), pass.held, names, now, state.parkedZero),
    ...pass.cut.samples({ name: "harness.jobs.cut", kind: "counter", help: CUT_HELP }),
    ...box.swept.samples({ name: "harness.jobs.cut", kind: "counter", help: CUT_HELP }),
    ...pass.resumed.samples({ name: "harness.jobs.resumed", kind: "counter", help: "Continues sent to cut jobs: the resume pass's \"interrupted\" lines by the daemon's answer, and check-in restarts." }),
    ...pass.skipped.samples({ name: "harness.jobs.not_resumed", kind: "counter", help: "Cut or stopped jobs the resume pass first left alone, once per job and reason: not owed, deleted, archived or unresolved." }));
  return out;
}

const CUT_HELP = "Job turns that ended on a provider error, a pool hold, an owner stop or archive, or a pi-pool lease that ran out, once per cut, by chat and reason.";
