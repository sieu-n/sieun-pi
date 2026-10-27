import { open, readdir, readFile, stat } from "node:fs/promises";
import { type FSWatcher, readFileSync, watch } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Context, Sample } from "../otlp.ts";
import { busyRows, findRow, messageKind, rowName, type Copy } from "./delivery.ts";

/*
 * Messaging between agents, from the records the chat service and Prime already write:
 *
 * 1. The chat service's agent outbox and owner outbox (components/user-history/src/outbox.ts, agent-outbox.ts): every message the service
 *    sends a session (wakes, alerts, relays, briefs, cross-host messages, the agent sends the daemon refused as full) and every owner send.
 *    An entry never changes once it has `doneAt`, so a done entry is read once. A delivered entry with `bundle` carried that many queued
 *    messages in one send_message; the others ended "obsolete" with "it went inside <head>" (the queue study of 10-22 counted 157 messages
 *    in 26 bundles the same way).
 * 2. Prime's log `~/.prime/agent/logs/agent.jsonl`: each send_message the daemon refused, from any sender, with its reason. It runs on every box.
 * 3. The chat service's `service.log`: each outbox try the daemon refused or timed out on, and the waits the outbox logs once.
 * 4. The daemon lists the chat service copies (session-copy.json, ~/.cache/sieun-pi/hosts/<box>.sessions.json): each live session's
 *    `unfinishedActionCount`, the pending count the daemon holds against its limit of 20. Their `queuedCount` read 0 for all of 10-21 while
 *    unfinished reached 68, so the backlog uses unfinished.
 * 5. pi-pool.log: `turn_admitted` and `turn_released`, one run of one session from its first model call to its end (pi-pool pool/turns.py).
 *    A message's read is the first run of its receiver that starts after the daemon took it, or the run that was going then.
 *
 * Agent sends that the daemon took at once (agent_message.send with room) are in no record outside the two session files, so no number here
 * counts them; notes/messaging.md names the one line that would.
 */

type OutboxName = "agent" | "owner";

/** One outbox entry as kept between rounds: its kind as its sender meant it, and the queued messages it carried in one send. */
export interface Rec {
  threadId: string;
  at: number;
  doneAt?: number;
  state: string;
  kind: string;
  /** The messages of a bundled send, its own first: each one's queue time and kind. */
  parts?: { at: number; kind: string }[];
  error?: string;
  /** Delivered entries only: a hash of the target and each carried message's trimmed text. */
  keys?: string[];
}

const MINUTE = 60_000;
const WINDOW_MS = 30 * MINUTE;
/** How far back the reader keeps turns and delivered messages, so a read that came hours after the send still finds both. */
const KEEP_MS = 6 * 3_600_000;
/** pi-pool.log read back at the feed's start, about 6 h of it on us-metal02 on 10-22 (0.67 MB an hour). */
const POOL_BACK_BYTES = 4 << 20;
/** pi-pool writes whole seconds, so a run that started in the second the daemon took a message reads up to 1 s before it. */
const SECOND = 1_000;
const TOP = 10;

const OWNER_KINDS = ["owner steer", "owner follow-up"];
const AGENT_KINDS = ["wake", "alert", "relay", "brief", "hung call", "cross-host", "report", "parent message", "sibling message", "part", "other"];
const SIZES = ["1", "2", "3-5", "6-10", "11-20", "21+"];
const DROPS = ["no such session", "chat archived", "already landed", "job deleted", "newer report waits", "split in parts", "all needless", "other"];
const REFUSALS = ["unknown session", "no worker found", "worker stopping or starting", "worker not reachable", "sent to itself", "pending limit",
  "too long", "update restart", "timed out after 30 s", "no api key", "other"];
const DRAIN_TURNS = ["0", "1", "2", "3", "4-5", "6-10", "11+", "no turn record"];
const DAY_MS = 24 * 3_600_000;
/** The audit's one target (messaging audit FINDINGS.md): no outbox message waits over 10 min for a live session. */
const LATE_MS = 10 * MINUTE;

/**
 * A short hash of the target and the exact trimmed text, the messaging audit's duplicate rule, so no text stays in memory or goes out. The
 * outbox's `fingerprint` drops ISO times, so wakes for different times would read as one.
 */
const keyOf = (target: string): string => createHash("sha1").update(target).digest("base64url").slice(0, 16);

/** What a message is, from its sender's opener (delivery.ts messageKind), with the held agent sends split by who sent them. */
export function kindOf(text: string): string {
  const kind = messageKind(text);
  if (kind === "held send") {
    const from = /^\[message from (your parent|your job|sibling)\b/.exec(text)?.[1];
    return from === "your parent" ? "parent message" : from === "your job" ? "report" : "sibling message";
  }
  if (kind === "other" && text.startsWith("[hung call]")) return "hung call";
  return kind === "bundle" ? "other" : kind;
}

export function parseRec(raw: string, outbox: OutboxName): Rec | null {
  const value = JSON.parse(raw) as { threadId?: unknown; at?: unknown; doneAt?: unknown; state?: unknown; text?: unknown; mode?: unknown; error?: unknown;
    bundle?: { at?: unknown; text?: unknown }[] };
  if (typeof value.threadId !== "string" || typeof value.at !== "number" || typeof value.state !== "string") return null;
  const textOf = (text: unknown) => typeof text === "string" ? text : "";
  const bundle = Array.isArray(value.bundle) && value.bundle.length > 1 ? value.bundle : null;
  const kind = outbox === "owner" ? value.mode === "followUp" ? "owner follow-up" : "owner steer" : kindOf(textOf(bundle?.[0]?.text ?? value.text));
  return {
    threadId: value.threadId, at: value.at, state: value.state, kind,
    ...typeof value.doneAt === "number" ? { doneAt: value.doneAt } : {},
    ...typeof value.error === "string" ? { error: value.error } : {},
    ...bundle ? { parts: bundle.map(part => ({ at: typeof part.at === "number" ? part.at : value.at as number, kind: kindOf(textOf(part.text)) })) } : {},
    ...value.state === "delivered" ? { keys: (bundle ? bundle.map(part => part.text) : [value.text]).map(text => keyOf(`${value.threadId}\n${textOf(text).trim()}`)) } : {},
  };
}

/** Why an entry ended without going: its proof or failure note (agent-outbox.ts `obsolete`, `Gone`, owner-outbox.ts `ArchivedFirst`). */
export function dropReason(note: string): string {
  if (/no such session/i.test(note)) return "no such session";
  if (/archived/.test(note)) return "chat archived";
  if (/landed in the target's file/.test(note)) return "already landed";
  if (/deleted the target job/.test(note)) return "job deleted";
  if (/newer report/.test(note)) return "newer report waits";
  if (/chars, over the daemon's/.test(note)) return "split in parts";
  if (/every message in it is needless/.test(note)) return "all needless";
  return "other";
}

/** A send_message refusal's reason, from the daemon's error text or the outbox's log line. */
export function refusalReason(error: string): string {
  if (/Unknown active session/.test(error)) return "unknown session";
  if (/too many pending messages|target is full/.test(error)) return "pending limit";
  if (/message is too long/.test(error)) return "too long";
  if (/worker is (stopping|starting|closing)|worker's? (?:is )?(stopping|starting|closing)/.test(error)) return "worker stopping or starting";
  if (/Timed out connecting to daemon session worker/.test(error)) return "worker not reachable";
  if (/cannot target the sending session/.test(error)) return "sent to itself";
  if (/update restart|update prepare/.test(error)) return "update restart";
  if (/Timed out after \d+ms/.test(error)) return "timed out after 30 s";
  if (/No API key found for/.test(error)) return "no api key";
  if (/^\s*Error\s*$/.test(error)) return "no worker found";
  return "other";
}

/** The refusal in one agent.jsonl line, or null. A worker's stderr echoed by the supervisor is skipped, so each refusal counts once. */
export function daemonRefusal(line: string): string | null {
  if (!line.includes("send_message") || !line.includes("failed")) return null;
  let value: { component?: unknown; msg?: unknown };
  try { value = JSON.parse(line); } catch { return null; }
  const msg = typeof value.msg === "string" ? value.msg : "";
  const first = msg.split("\n")[0]!;
  const supervisor = /^Supervisor command send_message failed:(.*)$/.exec(first);
  if (supervisor && value.component === "coding-agent.daemon-supervisor") return refusalReason(supervisor[1]!);
  const worker = /^daemon command "send_message" failed:(.*)$/.exec(first);
  if (worker && value.component === "coding-agent.daemon") return refusalReason(worker[1]!);
  return null;
}

/** The refused try or logged wait in one service.log line (agent-outbox.ts `send`, `room`, outbox.ts `attempt`), or null. */
export function outboxRefusal(line: string): string | null {
  const body = /^\S+Z outbox [0-9a-f]{8}(?: on [^:]+)?: (.*)$/.exec(line)?.[1];
  if (!body) return null;
  const tried = /^m-[0-9a-f-]+ try \d+(?: \(may have gone\))?: (.*)$/.exec(body);
  if (tried) return refusalReason(tried[1]!);
  if (body.startsWith("the target is full at")) return "pending limit";
  if (/^the target's worker is (stopping|starting|closing)/.test(body)) return "worker stopping or starting";
  if (/^m-[0-9a-f-]+ met the daemon's update/.test(body)) return "update restart";
  return null;
}

/** One service.log line the counts read (agent-outbox.ts `queue`, `send`, `room`, outbox.ts `attempt`), or null. */
export type ServiceEvent =
  | { type: "refused"; reason: string }
  | { type: "kernel full" }
  | { type: "copy found"; found: "landed" | "queued" }
  | { type: "full"; target: string; at: number; pending: number }
  | { type: "room"; target: string; at: number; unfinished: number };

/** The parse rules of the messaging audit's extract.py for the same lines. `target` is the short id with " on <box>" for another box's session. */
export function serviceEvent(line: string): ServiceEvent | null {
  const found = /^(\S+Z) outbox ([0-9a-f]{8}(?: on [^:]+)?): (.*)$/.exec(line);
  if (!found) return null;
  const [, stamp, target, body] = found as unknown as [string, string, string, string];
  if (/^queued m-\S+ from .* while the target held \S+(?: \S+)*? of \d+ pending/.test(body)) return { type: "kernel full" };
  const copy = /^m-\S+ is (landed|queued) from the send at /.exec(body);
  if (copy) return { type: "copy found", found: copy[1] as "landed" | "queued" };
  const full = /^the target is full at (\d+) of \d+ pending/.exec(body);
  if (full) return { type: "full", target, at: Date.parse(stamp), pending: Number(full[1]) };
  const room = /^the target has room, (\d+) of \d+ unfinished/.exec(body);
  if (room) return { type: "room", target, at: Date.parse(stamp), unfinished: Number(room[1]) };
  const reason = outboxRefusal(line);
  return reason ? { type: "refused", reason } : null;
}

/**
 * Pairs each "the target is full at P" line with the next "the target has room, U" line of that target, as the audit does: the target read at
 * least P minus U messages in between, in the runs of it that pi-pool admitted then (the run going at the full line, and each one started after).
 */
export function stepFull(open: Map<string, { at: number; pending: number }>, event: ServiceEvent, turns: Turns, counters: Counters): void {
  if (event.type === "full") { if (!open.has(event.target)) open.set(event.target, { at: event.at, pending: event.pending }); return; }
  if (event.type !== "room") return;
  const held = open.get(event.target);
  if (!held) return;
  open.delete(event.target);
  const session = event.target.includes(" on ") ? undefined
    : [...new Set([...turns.starts.keys(), ...turns.runs.keys(), ...turns.open.keys()])].find(id => id.startsWith(event.target));
  const runs = session === undefined ? "no turn record"
    : turnsOf((working(turns, session, held.at) ? 1 : 0) + (turns.starts.get(session) ?? []).filter(at => at > held.at + SECOND && at <= event.at).length);
  counters.add("harness.msg.full_drains", { turns: runs });
  counters.add("harness.msg.full_read", { turns: runs }, Math.max(0, held.pending - event.unfinished));
}

/**
 * The complete lines added to `file` since the last call. The first call starts `back` bytes before the end (0: at the end), past the
 * line it lands in; a file shorter than the saved offset (a rotation) is read again from its start.
 */
export async function newLines(file: string, kept: { offset?: number }, back = 0): Promise<string[]> {
  const size = await stat(file).then(info => info.size, () => -1);
  if (size < 0) return [];
  let skipFirst = false;
  if (kept.offset === undefined) {
    kept.offset = Math.max(0, size - back);
    skipFirst = kept.offset > 0;
  } else if (size < kept.offset) kept.offset = 0;
  if (size <= kept.offset) return [];
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(size - kept.offset);
    await handle.read(buffer, 0, buffer.length, kept.offset);
    const last = buffer.lastIndexOf(10);
    if (last < 0) return [];
    kept.offset += last + 1;
    const lines = buffer.toString("utf8", 0, last).split("\n");
    return skipFirst ? lines.slice(1) : lines;
  } finally { await handle.close(); }
}

/** The runs of each session pi-pool admitted, kept for KEEP_MS: their starts, and their ends once released. */
export interface Turns { starts: Map<string, number[]>; runs: Map<string, [number, number][]>; open: Map<string, number>; last?: number }

export const newTurns = (): Turns => ({ starts: new Map(), runs: new Map(), open: new Map() });

/** pi-pool writes UTC with no offset ("2026-10-22T07:32:26") since 10-27 (pool/base.py `log`). */
const poolTime = (ts: unknown): number => typeof ts === "string" ? Date.parse(`${ts}Z`) : NaN;

/**
 * Adds the runs in pi-pool.log lines. Before 10-27 not every pi-pool process wrote UTC: on us-metal02 on 10-22 the owner-turn command (the
 * chat service's mark before the owner's prompt, and the "ahead" admit it makes) wrote KST, 9 h ahead of the lines around it. A line later
 * than `now` was written so, and goes back by the whole hours it is ahead of the line before it.
 */
export function addTurnLines(turns: Turns, lines: readonly string[], now: number): void {
  for (const line of lines) {
    if (!line.includes('"turn_admitted"') && !line.includes('"turn_released"') && !line.includes('"turn_swept"')) continue;
    let row: { ts?: unknown; event?: unknown; session?: unknown };
    try { row = JSON.parse(line); } catch { continue; }
    let at = poolTime(row.ts);
    if (typeof row.session !== "string" || !Number.isFinite(at)) continue;
    if (at > now + MINUTE) at -= Math.max(1, Math.round((at - (turns.last ?? now)) / 3_600_000)) * 3_600_000;
    turns.last = at;
    const session = row.session;
    if (row.event === "turn_admitted") {
      const starts = turns.starts.get(session) ?? [];
      starts.push(at);
      turns.starts.set(session, starts);
      turns.open.set(session, at);
    } else if (row.event === "turn_released" || row.event === "turn_swept") {
      const start = turns.open.get(session);
      if (start === undefined) continue;
      turns.open.delete(session);
      const runs = turns.runs.get(session) ?? [];
      runs.push([start, at]);
      turns.runs.set(session, runs);
    }
  }
}

export function pruneTurns(turns: Turns, now: number): void {
  for (const [session, starts] of turns.starts) {
    const kept = starts.filter(at => now - at < KEEP_MS);
    if (kept.length) turns.starts.set(session, kept); else turns.starts.delete(session);
  }
  for (const [session, runs] of turns.runs) {
    const kept = runs.filter(([, end]) => now - end < KEEP_MS);
    if (kept.length) turns.runs.set(session, kept); else turns.runs.delete(session);
  }
}

/**
 * Whether the session had a run going at `at`. A stamp `s` means a moment in [s, s + 1 s), so a run counts only when it started in an earlier
 * second; one stamped in the same second as `at` is the next run.
 */
export function working(turns: Turns, session: string, at: number): boolean {
  const open = turns.open.get(session);
  if (open !== undefined && open + SECOND <= at) return true;
  return (turns.runs.get(session) ?? []).some(([start, end]) => start + SECOND <= at && at < end + SECOND);
}

const known = (turns: Turns, session: string): boolean => turns.starts.has(session) || turns.runs.has(session) || turns.open.has(session);

/** When the receiver read a message the daemon took at `doneAt`: the run going then, else its next run's start; null while it has not started. */
export function readAt(turns: Turns, session: string, doneAt: number): { via: "running turn" | "next turn" | "no turn record"; at: number } | null {
  if (!known(turns, session)) return { via: "no turn record", at: doneAt };
  if (working(turns, session, doneAt)) return { via: "running turn", at: doneAt };
  const next = (turns.starts.get(session) ?? []).find(at => at >= doneAt - SECOND);
  return next === undefined ? null : { via: "next turn", at: Math.max(next, doneAt) };
}

const quantile = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

/** Send-to-read times of the messages read in the last 30 min, per outbox and how they were read, as p50, p90, p99 and max, with counts. */
export function readSamples(entries: readonly { outbox: OutboxName; rec: Rec }[], turns: Turns, now: number): Sample[] {
  const groups = new Map<string, { labels: Record<string, string>; seconds: number[] }>();
  for (const { outbox, rec } of entries) {
    if (rec.state !== "delivered" || rec.doneAt === undefined || now - rec.doneAt >= KEEP_MS) continue;
    const read = readAt(turns, rec.threadId, rec.doneAt);
    if (!read || now - read.at >= WINDOW_MS) continue;
    const key = `${outbox}\n${read.via}`;
    const group = groups.get(key) ?? { labels: { outbox, via: read.via }, seconds: [] };
    for (const part of rec.parts ?? [{ at: rec.at }]) group.seconds.push(Math.max(0, read.at - part.at) / 1000);
    groups.set(key, group);
  }
  const samples: Sample[] = [];
  for (const { labels, seconds } of groups.values()) {
    samples.push({ name: "harness.msg.send_to_read_count", kind: "gauge", value: seconds.length, labels,
      help: "Messages read in the last 30 min, per outbox and how the receiver read them (next turn, running turn, or no turn record on this box)." });
    if (labels.via === "no turn record") continue;
    seconds.sort((a, b) => a - b);
    for (const [q, value] of [["p50", quantile(seconds, 0.5)], ["p90", quantile(seconds, 0.9)], ["p99", quantile(seconds, 0.99)], ["max", seconds.at(-1)!]] as const) {
      samples.push({ name: "harness.msg.send_to_read", kind: "gauge", unit: "s", value, labels: { ...labels, q },
        help: "Time from queue to the receiver's run that read it, for messages read in the last 30 min: the next run's start, or the daemon's accept when a run was going (a lower bound)." });
    }
  }
  return samples;
}

/** Counter totals by label set, kept in ctx.state so they only grow, with every known label set at 0 from the first round. */
export class Counters {
  private readonly values: Map<string, { name: string; labels: Record<string, string>; value: number }>;
  constructor(values: Map<string, { name: string; labels: Record<string, string>; value: number }>) { this.values = values; }
  seed(name: string, labels: Record<string, string>): void { this.add(name, labels, 0); }
  add(name: string, labels: Record<string, string>, by = 1): void {
    const key = `${name}\n${JSON.stringify(labels)}`;
    const held = this.values.get(key);
    if (held) held.value += by; else this.values.set(key, { name, labels, value: by });
  }
  samples(help: Record<string, string>): Sample[] {
    return [...this.values.values()].map(({ name, labels, value }) => ({ name, kind: "counter" as const, help: help[name]!, value, labels }));
  }
}

const HELP: Record<string, string> = {
  "harness.msg.sent": "Messages queued in the chat service's outboxes, by outbox and kind (wake, alert, relay, report, owner steer and the rest).",
  "harness.msg.delivered": "Messages the daemon took from the outboxes, by outbox, kind, and whether they went bundled with others in one send or alone.",
  "harness.msg.sends": "send_message calls that delivered outbox messages, by how many messages each carried.",
  "harness.msg.dropped": "Outbox messages that ended without going, by reason (a failure or the proof that made them needless).",
  "harness.msg.refused": "send_message refusals by reason: by the daemon for any sender (agent.jsonl), outbox tries and waits, and kernel sends refused as full that the outbox took (service.log).",
  "harness.msg.full_drains": "Times a session the daemon refused as full (20 pending) had room again, by how many of its runs that took (service.log full and room lines).",
  "harness.msg.full_read": "Messages those full sessions read between full and room (P minus U of the two lines), by the runs it took.",
  "harness.msg.duplicates": "Outbox messages delivered to a session that got the same text from another entry in the last 24 h.",
  "harness.msg.timeout_copies": "Sends that timed out after 30 s whose copy the outbox then found in the target's file or queue, so it did not send again.",
  "harness.msg.drains": "Backlogs that reached 2 or more pending messages and then 0, by how many runs of the receiver it took.",
};

const sizeOf = (n: number): string => n <= 2 ? String(n) : n <= 5 ? "3-5" : n <= 10 ? "6-10" : n <= 20 ? "11-20" : "21+";
const turnsOf = (n: number): string => n <= 3 ? String(n) : n <= 5 ? "4-5" : n <= 10 ? "6-10" : "11+";

function state<T>(ctx: Context, key: string, make: () => T): T {
  let value = ctx.state.get(key) as T | undefined;
  if (value === undefined) { value = make(); ctx.state.set(key, value); }
  return value;
}

/** An outbox folder as kept between rounds: its entries by file name, the names its watcher saw change, and when it was last listed whole. */
export interface OutboxCache { recs: Map<string, Rec>; dirty: Set<string>; watcher?: FSWatcher; listedAt?: number }

export const newOutboxCache = (): OutboxCache => ({ recs: new Map(), dirty: new Set() });

/** The folder is listed whole this often as well, in case its watcher missed a change. */
const RELIST_MS = 10 * MINUTE;

/**
 * An outbox folder, each done entry read once. `fresh` gets the entries first seen this round, `ended` the ones that got `doneAt` this round.
 * Listing the 16,892 entries of 10-22 took 30 to 45 ms and the work on the names as long again, so a watcher collects the names written
 * (each write renames a temp file onto `<id>.json`), and a round reads only those, with a whole listing at the start and every RELIST_MS.
 */
export async function readOutbox(dir: string, outbox: OutboxName, cache: OutboxCache, now: number): Promise<{ all: Rec[]; fresh: Rec[]; ended: Rec[] }> {
  const { recs, dirty } = cache;
  if (!cache.watcher) {
    try {
      const watcher = watch(dir, (_event, name) => { if (typeof name === "string" && name.endsWith(".json")) dirty.add(name); });
      watcher.on("error", () => { watcher.close(); if (cache.watcher === watcher) delete cache.watcher; });
      watcher.unref();
      cache.watcher = watcher;
      delete cache.listedAt;
    } catch {}
  }
  let names: string[];
  if (!cache.watcher || cache.listedAt === undefined || now - cache.listedAt >= RELIST_MS) {
    dirty.clear();
    names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith(".json"));
    cache.listedAt = now;
    const seen = new Set(names);
    for (const name of [...recs.keys()]) if (!seen.has(name)) recs.delete(name);
  } else {
    names = [...dirty];
    dirty.clear();
  }
  const fresh: Rec[] = [];
  const ended: Rec[] = [];
  await Promise.all(names.filter(name => recs.get(name)?.doneAt === undefined).map(async name => {
    const held = recs.get(name);
    const raw = await readFile(join(dir, name), "utf8").catch(() => null);
    if (raw === null) { recs.delete(name); return; }
    let rec: Rec | null = null;
    try { rec = parseRec(raw, outbox); } catch {}
    if (!rec) return;
    recs.set(name, rec);
    if (!held) fresh.push(rec);
    if (rec.doneAt !== undefined) ended.push(rec);
  }));
  return { all: [...recs.values()], fresh, ended };
}

/** Counts what the outbox entries did this round. */
export function countOutbox(counters: Counters, outbox: OutboxName, fresh: readonly Rec[], ended: readonly Rec[]): void {
  for (const rec of fresh) counters.add("harness.msg.sent", { outbox, kind: rec.kind });
  for (const rec of ended) {
    if (rec.state === "delivered") {
      const parts = rec.parts ?? [{ at: rec.at, kind: rec.kind }];
      counters.add("harness.msg.sends", { outbox, size: sizeOf(parts.length) });
      for (const part of parts) counters.add("harness.msg.delivered", { outbox, kind: part.kind, how: parts.length > 1 ? "bundled" : "alone" });
    } else if (!(rec.state === "obsolete" && rec.error?.startsWith("it went inside "))) {
      counters.add("harness.msg.dropped", { outbox, reason: dropReason(rec.error ?? "") });
    }
  }
}

/**
 * Counts a delivered message whose fingerprint reached the same target from another entry in the last 24 h. `count` false only learns them,
 * for the first round.
 */
export function stepDuplicates(seen: Map<string, number>, delivered: readonly Rec[], now: number, counters: Counters, count: boolean): void {
  for (const [key, at] of seen) if (now - at >= DAY_MS) seen.delete(key);
  for (const rec of [...delivered].sort((a, b) => a.doneAt! - b.doneAt!)) {
    for (const key of rec.keys ?? []) {
      if (count && seen.has(key)) counters.add("harness.msg.duplicates", {});
      seen.set(key, rec.doneAt!);
    }
  }
}

/** The daemon list copies of every box, each read again only when its size or mtime moved (delivery.ts `readCopies`). */
async function readCopies(ctx: Context): Promise<Copy[]> {
  const mirror = join(ctx.home, ".cache/sieun-pi/hosts");
  const others = (await readdir(mirror).catch(() => [] as string[])).filter(name => name.endsWith(".sessions.json"))
    .map(name => ({ host: name.slice(0, -".sessions.json".length), file: join(mirror, name) }));
  const files = [{ host: ctx.host, file: join(ctx.home, ".prime/agent/browser-chat/session-copy.json") }, ...others];
  const kept = state(ctx, "msg.copies", () => new Map<string, { stamp: string; busy: Copy["busy"] }>());
  const copies = await Promise.all(files.map(async ({ host, file }): Promise<Copy | null> => {
    const info = await stat(file).catch(() => null);
    if (!info) { kept.delete(file); return null; }
    let bytes: Buffer | null | undefined;
    const load = () => bytes === undefined ? (bytes = (() => { try { return readFileSync(file); } catch { return null; } })()) : bytes;
    const stamp = `${info.size}:${info.mtimeMs}`;
    let held = kept.get(file);
    if (held?.stamp !== stamp) {
      const read = load();
      held = { stamp, busy: read ? busyRows(read) : [] };
      kept.set(file, held);
    }
    return { host, busy: held.busy, bytes: load };
  }));
  return copies.filter((copy): copy is Copy => copy !== null);
}

/** One session's backlog: what the daemon holds unfinished for it, what waits for it in the outboxes, its name and the box that runs it. */
export interface Backlog { session: string; name: string; host: string; daemon: number; outbox: number }

/** Every session with a backlog: the busy rows of each copy, plus the targets of waiting outbox entries, named from the copies. */
export function backlogs(copies: readonly Copy[], waiting: ReadonlyMap<string, number>, look: (session: string) => { name: string; host: string }): Backlog[] {
  const out = new Map<string, Backlog>();
  for (const copy of copies) {
    for (const row of copy.busy) {
      if (out.has(row.sessionId)) continue;
      const daemon = row.unfinishedActionCount ?? 0;
      if (daemon > 0) out.set(row.sessionId, { session: row.sessionId, name: rowName(row) ?? "unnamed", host: copy.host, daemon, outbox: 0 });
    }
  }
  for (const [session, count] of waiting) {
    const held = out.get(session);
    if (held) { held.outbox = count; continue; }
    out.set(session, { session, ...look(session), daemon: 0, outbox: count });
  }
  return [...out.values()];
}

export function backlogSamples(list: readonly Backlog[]): Sample[] {
  const ranked = [...list].sort((a, b) => (b.daemon + b.outbox) - (a.daemon + a.outbox) || a.session.localeCompare(b.session));
  return [
    { name: "harness.msg.backlog_total", kind: "gauge", value: list.reduce((sum, b) => sum + b.daemon, 0), labels: { part: "daemon" },
      help: "Pending messages summed over every session: unfinished in the daemon (its limit is 20 per session), or waiting in the chat service's outboxes." },
    { name: "harness.msg.backlog_total", kind: "gauge", value: list.reduce((sum, b) => sum + b.outbox, 0), labels: { part: "outbox" },
      help: "Pending messages summed over every session: unfinished in the daemon (its limit is 20 per session), or waiting in the chat service's outboxes." },
    { name: "harness.msg.backlog_sessions", kind: "gauge", value: list.filter(b => b.daemon + b.outbox >= 2).length,
      help: "Sessions with 2 or more pending messages; a session in a run holds 1 unfinished for that run alone." },
    ...ranked.slice(0, TOP).map((b, index) => ({ name: "harness.msg.backlog", kind: "gauge" as const, value: b.daemon + b.outbox,
      labels: { rank: String(index + 1), name: b.name, session: b.session, host: b.host },
      help: "The ten sessions with the most pending messages now (unfinished in the daemon plus waiting in the outboxes), ranked, by name and full session id." })),
  ];
}

/**
 * An open backlog of one session: when it was first seen above 0, its peak, whether a run of the session was going then, and whether the
 * session runs on this box. One open at the feed's first round began before it, so its runs are not all known and it is not counted.
 */
export interface Episode { start: number; peak: number; running: boolean; local: boolean; partial: boolean }

/**
 * Follows each session's backlog round to round. A backlog that reached 2 or more ends when it reads 0, and counts the runs of the receiver it
 * took: the run going when it started, plus each run that started after. A session another box runs has no runs here ("no turn record").
 */
export function stepDrains(episodes: Map<string, Episode>, list: readonly Backlog[], turns: Turns, now: number, localHost: string, counters: Counters, first = false): void {
  const current = new Map(list.map(b => [b.session, b]));
  for (const [session, b] of current) {
    const total = b.daemon + b.outbox;
    const held = episodes.get(session);
    if (held) { held.peak = Math.max(held.peak, total); continue; }
    episodes.set(session, { start: now, peak: total, running: working(turns, session, now), local: b.host === localHost, partial: first });
  }
  for (const [session, episode] of episodes) {
    if (current.has(session)) continue;
    episodes.delete(session);
    if (episode.peak < 2 || episode.partial) continue;
    const runs = (episode.running ? 1 : 0) + (turns.starts.get(session) ?? []).filter(at => at > episode.start + SECOND && at <= now).length;
    counters.add("harness.msg.drains", { turns: episode.local ? turnsOf(runs) : "no turn record" });
  }
}

/** Every known label set at 0, so `increase` sees the first event of each. */
function seed(counters: Counters, chatHost: boolean): void {
  for (const reason of REFUSALS) counters.seed("harness.msg.refused", { source: "daemon", reason });
  if (!chatHost) return;
  for (const reason of REFUSALS) counters.seed("harness.msg.refused", { source: "outbox", reason });
  for (const [outbox, kinds] of [["agent", AGENT_KINDS], ["owner", OWNER_KINDS]] as const) {
    for (const kind of kinds) {
      counters.seed("harness.msg.sent", { outbox, kind });
      for (const how of ["alone", "bundled"]) counters.seed("harness.msg.delivered", { outbox, kind, how });
    }
    for (const size of SIZES) counters.seed("harness.msg.sends", { outbox, size });
    for (const reason of DROPS) counters.seed("harness.msg.dropped", { outbox, reason });
  }
  counters.seed("harness.msg.refused", { source: "kernel", reason: "pending limit" });
  for (const turns of DRAIN_TURNS) for (const name of ["harness.msg.drains", "harness.msg.full_drains", "harness.msg.full_read"]) counters.seed(name, { turns });
  counters.seed("harness.msg.duplicates", {});
  for (const found of ["landed", "queued"]) counters.seed("harness.msg.timeout_copies", { found });
}

export async function read(ctx: Context): Promise<Sample[]> {
  const first = !ctx.state.has("msg.counters");
  const counters = new Counters(state(ctx, "msg.counters", () => new Map()));
  if (first) seed(counters, ctx.chatHost);
  for (const line of await newLines(join(ctx.home, ".prime/agent/logs/agent.jsonl"), state(ctx, "msg.agentLog", () => ({})))) {
    const reason = daemonRefusal(line);
    if (reason) counters.add("harness.msg.refused", { source: "daemon", reason });
  }
  if (!ctx.chatHost) return counters.samples(HELP);

  const dir = join(ctx.home, ".prime/agent/browser-chat");
  const primed = ctx.state.has("msg.agent");
  const [agent, owner, copies, serviceLines, poolLines] = await Promise.all([
    readOutbox(join(dir, "agent-outbox"), "agent", state(ctx, "msg.agent", newOutboxCache), ctx.now),
    readOutbox(join(dir, "outbox"), "owner", state(ctx, "msg.owner", newOutboxCache), ctx.now),
    readCopies(ctx),
    newLines(join(dir, "service.log"), state(ctx, "msg.serviceLog", () => ({}))),
    newLines(join(process.env.PI_POOL_DIR || join(ctx.home, ".config/pi-pool"), "pi-pool.log"), state(ctx, "msg.poolLog", () => ({})), POOL_BACK_BYTES),
  ]);
  // The first round only learns what is there, so each counter starts at 0 when the feed starts.
  if (primed) {
    countOutbox(counters, "agent", agent.fresh, agent.ended);
    countOutbox(counters, "owner", owner.fresh, owner.ended);
  }
  const turns = state(ctx, "msg.turns", newTurns);
  addTurnLines(turns, poolLines, ctx.now);
  pruneTurns(turns, ctx.now);
  const full = state(ctx, "msg.full", () => new Map<string, { at: number; pending: number }>());
  for (const line of serviceLines) {
    const event = serviceEvent(line);
    if (!event) continue;
    if (event.type === "refused") counters.add("harness.msg.refused", { source: "outbox", reason: event.reason });
    else if (event.type === "kernel full") counters.add("harness.msg.refused", { source: "kernel", reason: "pending limit" });
    else if (event.type === "copy found") counters.add("harness.msg.timeout_copies", { found: event.found });
    else {
      if (event.type === "full") counters.add("harness.msg.refused", { source: "outbox", reason: "pending limit" });
      stepFull(full, event, turns, counters);
    }
  }
  for (const [target, held] of full) if (ctx.now - held.at >= DAY_MS) full.delete(target);
  const done = (recs: readonly Rec[]) => recs.filter(rec => rec.state === "delivered" && rec.doneAt !== undefined && ctx.now - rec.doneAt < DAY_MS);
  stepDuplicates(state(ctx, "msg.seen", () => new Map<string, number>()), [...done(primed ? agent.ended : agent.all), ...done(primed ? owner.ended : owner.all)], ctx.now, counters, primed);

  const waiting = new Map<string, number>();
  const late: Rec[] = [];
  for (const rec of [...agent.all, ...owner.all]) {
    if (rec.doneAt !== undefined) continue;
    waiting.set(rec.threadId, (waiting.get(rec.threadId) ?? 0) + 1);
    if (ctx.now - rec.at > LATE_MS) late.push(rec);
  }
  const where = state(ctx, "msg.where", () => new Map<string, { name: string; host: string; live: boolean }>());
  const look = (session: string) => {
    let held = where.get(session);
    if (!held) {
      const copy = copies.find(c => { const bytes = c.bytes(); return !!bytes && bytes.includes(`"sessionId":"${session}"`); });
      const row = copy ? findRow([copy], session) : null;
      held = { name: rowName(row) ?? (copy ? "unnamed" : "unknown"), host: copy?.host ?? "unknown", live: row?.lifecycle === "live" };
      where.set(session, held);
    }
    return held;
  };
  const lateLive = late.filter(rec => look(rec.threadId).live).length;
  const heldNotices = await readFile(join(dir, "held-notices.json"), "utf8").then(raw => JSON.parse(raw) as Record<string, unknown>, () => ({} as Record<string, unknown>));
  const list = backlogs(copies, waiting, look);
  for (const session of where.keys()) if (!waiting.has(session)) where.delete(session);
  stepDrains(state(ctx, "msg.episodes", () => new Map<string, Episode>()), list, turns, ctx.now, ctx.host, counters, !primed);

  // The delivered messages of the last KEEP_MS, the only ones a read time can come from: about 1,000 of the 16,892 entries on 10-22.
  const kept = state(ctx, "msg.delivered", () => [] as { outbox: OutboxName; rec: Rec }[]);
  const recent = (outbox: OutboxName, recs: readonly Rec[]) => recs.filter(rec => rec.state === "delivered" && ctx.now - rec.doneAt! < KEEP_MS).map(rec => ({ outbox, rec }));
  const delivered = [...kept.filter(({ rec }) => ctx.now - rec.doneAt! < KEEP_MS),
    ...recent("agent", primed ? agent.ended : agent.all), ...recent("owner", primed ? owner.ended : owner.all)];
  ctx.state.set("msg.delivered", delivered);

  return [
    ...counters.samples(HELP),
    ...backlogSamples(list),
    ...readSamples(delivered, turns, ctx.now),
    { name: "harness.msg.outbox_late", kind: "gauge", value: lateLive,
      help: "Outbox messages waiting over 10 min for a session its daemon lists as live; the target is 0 (messaging audit)." },
    { name: "harness.msg.held_notices", kind: "gauge", value: Object.values(heldNotices).reduce((sum: number, list) => sum + (Array.isArray(list) ? list.length : 0), 0),
      help: "Check-in and job notices the chat service holds while Prime parks their chat (held-notices.json), sent when the park ends." },
  ];
}
