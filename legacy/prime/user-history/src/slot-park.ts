import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { clockTime } from "./checkin-settings.ts";
import { CUT_CONFIRM_BYTES, CUT_TAIL_BYTES, tailLines } from "./cut-end.ts";
import { PARK_STOP_REASON, turnError } from "./shared/credential-wait.ts";

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
  /** When the open wait began: its oldest entry since the last turn, resume or stop, or Prime's `waitingSince`. A verdict-only Prime park has none. */
  since?: number;
  /** Place and line length, from pi-pool now when it lists the session, else from the newest entry that names them. */
  place?: number;
  total?: number;
  /** When Prime asks again by itself: the newest park's resumeAt or the time the slot-wait error names. */
  resumeAt?: number;
  /** pi-pool started the slot and waits for the session to load and take it. */
  starting?: true;
  /**
   * Its turn ended on the wait: the newest entry is a slot-wait error or a `provider_quota_park`, so no live model call holds the queue place
   * and its worker can stop. Absent while the newest entry is a `pi-pool-queue` place, a turn that waits inside a live model call.
   */
  ended?: true;
  /**
   * What Prime says the session waits for, when Prime reported the park itself (`primePark`): pi-pool's "a working slot, place 3 of 9" from
   * load.3 on, or Prime's own "a provider credential". Such a park lasts until Prime clears it.
   */
  label?: string;
};

/** One session file's own reading: its open wait, or when Prime dropped its park with no turn after (`dropped`), and whether the lines held a clear. */
export type FileSlotPark = { park?: SlotPark; dropped?: number; complete: boolean };

/** `pi-pool queue --json`, only the parts this reader uses; the chat service's `PoolPlaces` (src/chat-turn-queue.ts) is one. */
export type PoolQueue = {
  queued: ReadonlyMap<string, { position: number; total: number }>;
  working: ReadonlySet<string>;
};

/**
 * pi-pool's slot wait as Prime ends the turn with it (components/pi-pool/app/extension/index.ts): load.2's "this run waits for a working slot,
 * place 134 of 139; ... asks again at <time>", and the token hook's older "this session waits for its slot at <time>" (10-18 to 10-20).
 */
const SLOT_ERROR = /pi-pool: this (?:run|session) waits for (?:a working slot|its slot)(?:, place (\d+) of (\d+))?(?:[^]*?\bat (\d{4}-\d\d-\d\dT[\d:.]+Z))?/;
/** The archive reasons that are the daemon's own and leave the session restorable (Prime's RT set); any other archive is a stop. */
const NOT_A_STOP = new Set(["idle_unload", "daemon_shutdown", "update_discarded"]);

type Line = {
  type?: unknown; customType?: unknown; timestamp?: unknown;
  data?: { position?: unknown; total?: unknown; resumeAt?: unknown };
  state?: { status?: unknown; reason?: unknown };
  message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown; diagnostics?: unknown };
};
type Signal = { at: number; place?: number | undefined; total?: number | undefined; resumeAt?: number | undefined; ended?: true | undefined };
/** A line that ends a wait; `dropped` is Prime's provider_quota_resume "cancelled", its wake that ran no turn (the stop generation bug). */
type Clear = { clear: true; dropped?: number };

const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const time = (value: unknown): number | undefined => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : undefined;
};

/** What one line says: a wait signal, a clear (a turn that ran, another failure, a resume or a stop), or nothing (undefined). */
function classify(line: Line): Signal | Clear | undefined {
  const at = time(line.timestamp) ?? 0;
  if (line.type === "message" && line.message?.role === "assistant") {
    if (line.message.stopReason !== "error") return { clear: true };
    // load.2 writes a credential_unavailable diagnostic too, which turnError words without the place, so the error's own words go first.
    const slot = SLOT_ERROR.exec(String(line.message.errorMessage ?? "")) ?? SLOT_ERROR.exec(turnError(line.message) ?? "");
    if (!slot) return { clear: true };
    return { at, place: num(Number(slot[1])), total: num(Number(slot[2])), resumeAt: time(slot[3]), ended: true };
  }
  if (line.type === "custom" && line.customType === "pi-pool-queue") return { at, place: num(line.data?.position), total: num(line.data?.total) };
  if (line.type === "custom" && line.customType === "provider_quota_park") return { at, resumeAt: time(line.data?.resumeAt), ended: true };
  if (line.type === "custom" && line.customType === "provider_quota_resume") return { clear: true, ...(line.data as { outcome?: unknown } | undefined)?.outcome === "cancelled" ? { dropped: at } : {} };
  // An archive with no reason is older Prime's idle unload (10-20's credential wait marker test); a named reason outside NOT_A_STOP is a stop.
  if (line.type === "session_state" && line.state?.status === "archived" && typeof line.state.reason === "string" && !NOT_A_STOP.has(line.state.reason)) return { clear: true };
  return undefined;
}

/**
 * The open slot wait in a session's lines, newest last, or none (`complete` false: the lines hold no clear). `dropped` is when Prime's wake
 * dropped the park with no turn after it: 01a17f25's provider_quota_resume "cancelled" at 21:16:40Z, after which it ran nothing until a message.
 */
export function fileSlotPark(lines: readonly string[]): FileSlotPark {
  const signals: Signal[] = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const raw = lines[index]!;
    if (!raw.includes("provider_quota_") && !raw.includes("pi-pool-queue") && !raw.includes('"assistant"') && !raw.includes('"session_state"')) continue;
    let line: Line;
    try { line = JSON.parse(raw); } catch { continue; }
    const read = classify(line);
    if (read && "clear" in read) {
      if (signals.length) return { park: merge(signals), complete: true };
      return { ...read.dropped !== undefined ? { dropped: read.dropped } : {}, complete: true };
    }
    if (read) signals.push(read);
  }
  return { ...signals.length ? { park: merge(signals) } : {}, complete: false };
}

/** Signals newest first into one wait: its start, the newest place, total and resume time, and whether the newest one ended the turn. */
function merge(signals: readonly Signal[]): SlotPark {
  const placed = signals.find(signal => signal.place !== undefined);
  const resumeAt = signals.find(signal => signal.resumeAt !== undefined)?.resumeAt;
  return { since: signals.at(-1)!.at, ...placed ? { place: placed.place!, ...placed.total !== undefined ? { total: placed.total } : {} } : {},
    ...resumeAt !== undefined ? { resumeAt } : {}, ...signals[0]!.ended ? { ended: true as const } : {} };
}

/**
 * The slot wait of session `sessionId` from its lines and pi-pool now (`pool`, null where this box runs no pool): open in the file, and either
 * listed by the pool (whose place wins) or due to ask again after `now`. A wait the pool dropped and whose time passed is over.
 */
export function slotParkOf(lines: readonly string[], sessionId: string, now: number, pool: PoolQueue | null): SlotPark | null {
  return poolPark(fileSlotPark(lines).park, sessionId, now, pool);
}

/**
 * A file's or row's open wait (`fileSlotPark`, `primePark`) checked against pi-pool now, as `slotParkOf` reads it. A wait whose resumeAt
 * passed and that the pool lists neither queued nor working is over, Prime's labelled park too: a box that went offline keeps its last row,
 * and on 10-29 the outbox held a message to designer bro on the Mac at 23:04Z "while the target waits for its pi-pool slot at 19:30:01Z".
 * A labelled park with no resumeAt lasts until Prime clears it.
 */
export function poolPark(park: SlotPark | undefined, sessionId: string, now: number, pool: PoolQueue | null): SlotPark | null {
  if (!park) return null;
  if (!pool) return park;
  const queued = pool.queued.get(sessionId);
  if (queued) return { ...park, place: queued.position, total: queued.total };
  if (pool.working.has(sessionId)) return { ...park.since !== undefined ? { since: park.since } : {}, ...park.resumeAt !== undefined ? { resumeAt: park.resumeAt } : {}, starting: true };
  return (park.resumeAt !== undefined ? park.resumeAt > now : park.label !== undefined) ? park : null;
}

/** Prime's credential park on a summary row (load.3, schema 39 `SessionCredentialPark`): its times are ISO strings, as agent_observe gives them. */
type RowPark = { credentialPark?: { waitingFor?: unknown; waitingSince?: unknown; resumeAt?: unknown }; taskState?: unknown; summary?: unknown };

/**
 * Prime's own park on a daemon summary row, or undefined on a Prime before load.3 or a row with none. A resident row carries `credentialPark`
 * {waitingFor, waitingSince?, resumeAt}; a saved row carries only the verdict, taskState "waiting" with summary "Waiting for <waitingFor>",
 * which Prime sends only while it is current. Prime ends both when the turn runs or stops, and a wake that drops the park leaves an "error"
 * verdict, so the file's reading (`readFileSlotPark`) still finds the dropped park.
 */
export function primePark(row: object | undefined): SlotPark | undefined {
  const { credentialPark: park, taskState, summary } = (row ?? {}) as RowPark;
  if (park && typeof park.waitingFor === "string" && park.waitingFor.trim()) {
    const since = time(park.waitingSince);
    const resumeAt = time(park.resumeAt);
    return { label: park.waitingFor.trim(), ...since !== undefined ? { since } : {}, ...resumeAt !== undefined ? { resumeAt } : {}, ended: true };
  }
  if (taskState !== "waiting") return undefined;
  const label = typeof summary === "string" ? summary.trim().replace(/^Waiting for\s+/, "") : "";
  return { label: label || "a provider credential", ended: true };
}

/** A session's open wait: Prime's own on its daemon row (`primePark`) when the row has one, else the reading of its file (`readFileSlotPark`). */
export async function readRowSlotPark(row: { sessionFile?: string | undefined } | undefined, file = row?.sessionFile): Promise<FileSlotPark> {
  const park = primePark(row);
  if (park) return { park, complete: true };
  return file ? readFileSlotPark(file) : { complete: true };
}

const fileReads = new Map<string, { key: string; read: FileSlotPark }>();

/**
 * `fileSlotPark` of a session file, reading longer tails until one holds a clear, and read again only after the file changed (its size or
 * mtime): the catalog asks for every chat's stopped jobs at each projection, every 2 s while an agent works (RATES_MS), and a parked session
 * writes nothing. A file that cannot be read has no wait.
 */
export async function readFileSlotPark(file: string): Promise<FileSlotPark> {
  const info = await stat(file).catch(() => null);
  if (!info) return { complete: true };
  const key = `${info.size}:${info.mtimeMs}`;
  const known = fileReads.get(file);
  if (known?.key === key) return known.read;
  let read: FileSlotPark = { complete: false };
  for (const bytes of [CUT_TAIL_BYTES, CUT_CONFIRM_BYTES]) {
    read = fileSlotPark(await tailLines(file, bytes).catch(() => []));
    if (read.complete) break;
  }
  fileReads.set(file, { key, read });
  return read;
}

/** Every file's reading so far, with the key it was read at, for the next start (chat-catalog.ts `TAILS_FILE`). */
export const heldSlotParkReads = (): Record<string, { key: string; read: FileSlotPark }> => Object.fromEntries(fileReads);

/**
 * Takes the readings a last run saved, so `readFileSlotPark` reads again only a file whose size or mtime changed since. A file this run read
 * already keeps its own reading, and an entry of another shape is left out and read as before.
 */
export function takeSlotParkReads(saved: unknown): void {
  if (typeof saved !== "object" || saved === null) return;
  for (const [file, value] of Object.entries(saved as Record<string, unknown>)) {
    const { key, read } = (typeof value === "object" && value !== null ? value : {}) as { key?: unknown; read?: unknown };
    if (fileReads.has(file) || typeof key !== "string" || typeof read !== "object" || read === null || typeof (read as FileSlotPark).complete !== "boolean") continue;
    fileReads.set(file, { key, read: read as FileSlotPark });
  }
}

/** `slotParkOf` for a session file (`readFileSlotPark`). The session id is the file's name. */
export async function readSlotPark(file: string, now: number, pool: PoolQueue | null): Promise<SlotPark | null> {
  return poolPark((await readFileSlotPark(file)).park, basename(file, ".jsonl"), now, pool);
}

/** `pi-pool queue --json` as a PoolQueue; null when pi-pool is missing, off or unreadable. */
export function parsePoolQueue(text: string): PoolQueue | null {
  let raw: { enabled?: unknown; queued?: unknown; working?: unknown };
  try { raw = JSON.parse(text); } catch { return null; }
  if (raw.enabled === false || !Array.isArray(raw.queued)) return null;
  const queued = new Map<string, { position: number; total: number }>();
  for (const entry of raw.queued as { session?: unknown; position?: unknown; total?: unknown }[]) {
    const position = num(entry.position);
    if (typeof entry.session === "string" && position !== undefined) queued.set(entry.session, { position, total: num(entry.total) ?? raw.queued.length });
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

/**
 * When a session whose turn ended on its wait (`SlotPark.ended`) is due to ask again, if that is after `now`: Prime's park or the slot-wait
 * error names it, so the idle unload can stop the worker at once and the daemon's durable wake or pi-pool loads it again. Null for a session
 * that waits inside a live model call, took a turn since, or whose time passed.
 */
export function parkedUntil(read: Pick<FileSlotPark, "park">, now: number): number | null {
  const at = read.park?.ended ? read.park.resumeAt : undefined;
  return at !== undefined && at > now ? at : null;
}

/** A slot wait in words for a notice or a roster row: "waits for a working slot, place 104 of 193". */
export function slotParkWords(park: SlotPark): string {
  if (park.starting) return "waits for its working slot to start";
  if (park.place === undefined) return `waits for ${park.label ?? "a working slot"}`;
  return `waits for a working slot, place ${park.place}${park.total !== undefined ? ` of ${park.total}` : ""}`;
}

/** A dropped park in words: "its slot park was dropped at 21:16, when Prime's wake ran no turn, so it runs again only when it gets a message". */
export const droppedWords = (at: number): string =>
  `its slot park was dropped at ${clockTime(at)}, when Prime's wake ran no turn, so it runs again only when it gets a message`;


/** The child a park-stop notice names (its rlm child id and name), or null for any other message. */
export function parkStopNotice(message: unknown): { child: string; name: string } | null {
  const notice = message as { role?: unknown; customType?: unknown; content?: unknown; details?: unknown };
  if (notice.role !== "custom" || notice.customType !== "rlm_child_terminal_notice") return null;
  const details = (typeof notice.details === "object" && notice.details !== null ? notice.details : {}) as { childId?: unknown; sessionName?: unknown; reason?: unknown; by?: unknown };
  // A notice the job-cancel rewrite already worded (`withCancelledNotices`) is a real cancel by the owner or a chat.
  if (details.by !== undefined) return null;
  if (details.reason !== PARK_STOP_REASON && !(typeof notice.content === "string" && notice.content.includes(PARK_STOP_REASON))) return null;
  if (typeof details.childId !== "string") return null;
  return { child: details.childId, name: typeof details.sessionName === "string" && details.sessionName ? details.sessionName : details.childId };
}

/** What a parent reads in place of a park-stop notice, from the child's file when the notice first came: still waiting, dropped, or run since. */
export function parkStopText(name: string, read: { park: SlotPark | null; dropped?: number }): string {
  if (read.park) return `[child-parked child:${name}] ${name} was not cancelled: Prime stopped its worker while it ${slotParkWords(read.park)}, and pi-pool ` +
    "wakes it when its slot starts. Leave it as it is and do not start a copy of it.";
  if (read.dropped !== undefined) return `[child-park-dropped child:${name}] ${name} was not cancelled: it waited for a working slot, and ${droppedWords(read.dropped)}. ` +
    "Send it a message to continue its task.";
  return `[child-parked child:${name}] ${name} was not cancelled: Prime stopped its worker while its turn waited for a working slot, and it has run again since.`;
}

/** The session file of rlm child `child` of the session whose file is `parentFile`: a root's children sit under `<agentDir>/session-artifacts/<root id>/`. */
export async function childSessionFile(parentFile: string, child: string, agentDir: string): Promise<string | null> {
  const parentDir = basename(dirname(parentFile)).startsWith("sub-") ? dirname(parentFile) : join(agentDir, "session-artifacts", basename(parentFile, ".jsonl"));
  const folder = join(parentDir, child);
  const files = (await readdir(folder).catch(() => [] as string[])).filter(name => /^[0-9a-f-]{36}\.jsonl$/.test(name));
  return files.length === 1 ? join(folder, files[0]!) : null;
}
