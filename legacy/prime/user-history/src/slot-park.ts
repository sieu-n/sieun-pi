import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { CUT_CONFIRM_BYTES, CUT_TAIL_BYTES, tailLines } from "./cut-end.ts";

/**
 * One reader for "this session waits for a pi-pool working slot". Since load.2 (us-metal02, 10-28 about 05:44 KST) a turn that waits for its
 * slot ends on a failed assistant message ("pi-pool: this run waits for a working slot, place 134 of 139; ... asks again at <time>"), Prime
 * writes a `provider_quota_park` entry with `resumeAt`, and the idle unload stops its worker (`session_state` archived `idle_unload`). Every
 * view then read the job as failed, completed or idle: rlm.list_subagents said completed, the chat service sent "[job] harness memory
 * explainer failed", and d9 called its steps ownerless. The session is waiting, and its place in pi-pool's line says how long.
 *
 * The session file says whether a wait is open: from its end, a `pi-pool-queue` place, a slot-wait error or a `provider_quota_park` comes
 * before any turn that ran, any other failure, a `provider_quota_resume` or a stop. `pi-pool queue --json` says whether the pool still holds
 * the place and which it is now. 01a17f25 on 10-28: parked at 20:56:57Z, woken at 21:16:40Z, when Prime wrote provider_quota_resume
 * "cancelled" and ran no turn, so it waited on nothing until a message came at 21:22:09Z (test/fixtures/slot-park-01a17f25-1028.jsonl).
 */
export type SlotPark = {
  /** When the open wait began: its oldest entry since the last turn, resume or stop. */
  since: number;
  /** Place and line length, from pi-pool now when it lists the session, else from the newest entry that names them. */
  place?: number;
  total?: number;
  /** When Prime asks again by itself: the newest park's resumeAt or the time the slot-wait error names. */
  resumeAt?: number;
  /** pi-pool started the slot and waits for the session to load and take it. */
  starting?: true;
};

/** `pi-pool queue --json`, only the parts this reader uses. */
export type PoolQueue = {
  queued: ReadonlyMap<string, { place: number; total: number }>;
  working: ReadonlySet<string>;
};

/** pi-pool's slot wait as Prime ends the turn with it (legacy/prime/pi-pool-extension/index.ts). */
const SLOT_ERROR = /pi-pool: this (?:run|session) waits for (?:a working slot|its slot)(?:, place (\d+) of (\d+))?[^]*?(?:asks again at|waits for its slot at) (\d{4}-\d\d-\d\dT[\d:.]+Z)/;
/** The archive reasons that are the daemon's own and leave the session restorable (Prime's RT set); any other archive is a stop. */
const NOT_A_STOP = new Set(["idle_unload", "daemon_shutdown", "update_discarded"]);

type Line = {
  type?: unknown; customType?: unknown; timestamp?: unknown;
  data?: { position?: unknown; total?: unknown; resumeAt?: unknown };
  state?: { status?: unknown; reason?: unknown };
  message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
};
type Signal = { at: number; place?: number | undefined; total?: number | undefined; resumeAt?: number | undefined };

const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const time = (value: unknown): number | undefined => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : undefined;
};

/** What one line says: a wait signal, a clear (a turn that ran, another failure, a resume or a stop), or nothing (undefined). */
function classify(line: Line): Signal | "clear" | undefined {
  const at = time(line.timestamp) ?? 0;
  if (line.type === "message" && line.message?.role === "assistant") {
    if (line.message.stopReason !== "error") return "clear";
    const slot = SLOT_ERROR.exec(String(line.message.errorMessage ?? ""));
    if (!slot) return "clear";
    return { at, place: num(Number(slot[1])), total: num(Number(slot[2])), resumeAt: time(slot[3]) };
  }
  if (line.type === "custom" && line.customType === "pi-pool-queue") return { at, place: num(line.data?.position), total: num(line.data?.total) };
  if (line.type === "custom" && line.customType === "provider_quota_park") return { at, resumeAt: time(line.data?.resumeAt) };
  if (line.type === "custom" && line.customType === "provider_quota_resume") return "clear";
  if (line.type === "session_state" && line.state?.status === "archived" && !NOT_A_STOP.has(String(line.state.reason))) return "clear";
  return undefined;
}

/** The open slot wait in a session's lines, newest last, or undefined when it has none (`complete` false: the lines hold no clear). */
export function fileSlotPark(lines: readonly string[]): { park?: SlotPark; complete: boolean } {
  const signals: Signal[] = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const raw = lines[index]!;
    if (!raw.includes('"customType":"p') && !raw.includes('"role":"assistant"') && !raw.includes('"session_state"')) continue;
    let line: Line;
    try { line = JSON.parse(raw); } catch { continue; }
    const read = classify(line);
    if (read === "clear") return { ...signals.length ? { park: merge(signals) } : {}, complete: true };
    if (read) signals.push(read);
  }
  return { ...signals.length ? { park: merge(signals) } : {}, complete: false };
}

/** Signals newest first into one wait: its start, and the newest place, total and resume time. */
function merge(signals: readonly Signal[]): SlotPark {
  const placed = signals.find(signal => signal.place !== undefined);
  const resumeAt = signals.find(signal => signal.resumeAt !== undefined)?.resumeAt;
  return { since: signals.at(-1)!.at, ...placed ? { place: placed.place!, ...placed.total !== undefined ? { total: placed.total } : {} } : {}, ...resumeAt !== undefined ? { resumeAt } : {} };
}

/**
 * The slot wait of session `sessionId` from its lines and pi-pool now (`pool`, null where this box runs no pool): open in the file, and either
 * listed by the pool (whose place wins) or due to ask again after `now`. A wait the pool dropped and whose time passed is over.
 */
export function slotParkOf(lines: readonly string[], sessionId: string, now: number, pool: PoolQueue | null): SlotPark | null {
  const { park } = fileSlotPark(lines);
  if (!park) return null;
  if (!pool) return park;
  const queued = pool.queued.get(sessionId);
  if (queued) return { ...park, place: queued.place, total: queued.total };
  if (pool.working.has(sessionId)) return { since: park.since, ...park.resumeAt !== undefined ? { resumeAt: park.resumeAt } : {}, starting: true };
  return park.resumeAt !== undefined && park.resumeAt > now ? park : null;
}

/** `slotParkOf` for a session file, reading longer tails until one holds a clear. The session id is the file's name. */
export async function readSlotPark(file: string, now: number, pool: PoolQueue | null): Promise<SlotPark | null> {
  let lines: string[] = [];
  for (const bytes of [CUT_TAIL_BYTES, CUT_CONFIRM_BYTES]) {
    lines = await tailLines(file, bytes);
    if (fileSlotPark(lines).complete) break;
  }
  return slotParkOf(lines, basename(file, ".jsonl"), now, pool);
}

/** `pi-pool queue --json` as a PoolQueue; null when pi-pool is missing, off or unreadable. */
export function parsePoolQueue(text: string): PoolQueue | null {
  let raw: { enabled?: unknown; queued?: unknown; working?: unknown };
  try { raw = JSON.parse(text); } catch { return null; }
  if (raw.enabled === false || !Array.isArray(raw.queued)) return null;
  const queued = new Map<string, { place: number; total: number }>();
  for (const entry of raw.queued as { session?: unknown; position?: unknown; total?: unknown }[]) {
    const place = num(entry.position);
    if (typeof entry.session === "string" && place !== undefined) queued.set(entry.session, { place, total: num(entry.total) ?? raw.queued.length });
  }
  const working = new Set((Array.isArray(raw.working) ? raw.working as { session?: unknown }[] : []).flatMap(entry => typeof entry.session === "string" ? [entry.session] : []));
  return { queued, working };
}

const run = promisify(execFile);
let cached: { at: number; read: Promise<PoolQueue | null> } | undefined;

/** pi-pool's line now, read at most once per `maxAgeMs` (one `pi-pool queue --json` took 0.36 s on us-metal02 on 10-28). */
export function readPoolQueue(now = Date.now(), maxAgeMs = 5_000): Promise<PoolQueue | null> {
  if (cached && now - cached.at < maxAgeMs) return cached.read;
  const read = run("pi-pool", ["queue", "--json"], { timeout: 10_000, maxBuffer: 16_000_000 }).then(({ stdout }) => parsePoolQueue(stdout), () => null);
  cached = { at: now, read };
  return read;
}

/** A slot wait in words for a notice or a roster row: "waits for a working slot, place 104 of 193". */
export function slotParkWords(park: SlotPark): string {
  if (park.starting) return "waits for its working slot to start";
  if (park.place === undefined) return "waits for a working slot";
  return `waits for a working slot, place ${park.place}${park.total !== undefined ? ` of ${park.total}` : ""}`;
}
