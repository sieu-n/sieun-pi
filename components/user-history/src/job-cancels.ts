import { open } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { clockTime } from "./checkin-settings.ts";
import { type JsonFile, snapshotJsonFile, transactJsonFile } from "./locked-json.ts";

/**
 * Who asked for a cancel: the owner, by his Stop or Archive in the chat's controls, or a chat that owns the job, by its session id, through the
 * same route. On 10-21 at 08:11:31Z a job of chat-057a stopped vent's finished job 01a14ffa at vent's request, and the record could only say
 * "by owner", which told the resume pass and chat-057a that the owner had ended it.
 */
export type CancelBy = { by: "owner" } | { by: "chat"; chat: string };

/** A cancel as it is asked for: who, when, Stop or Archive, and where the job sits. */
export type CancelRequest = CancelBy & { at: number; how: "stop" | "archive"; parent?: string; child?: string; name?: string };

/**
 * An explicit cancel of a job: a Stop or Archive of the job's thread, asked by the owner or by its chat (`CancelBy`). Both hold the same way. On
 * 10-20 run7's Stop and Archive ended job "user history test run" at 11:20:16Z, Prime told the chat "[child-exited: no-reply ...]" 49 ms after
 * the abort and before the archive, and the chat's "You exited without a reply. Finish the task" reopened the job at 11:20:49Z. The service
 * writes the cancel before it aborts or kills the session, so every reader sees it before the notice it explains. `parent` and `child` are the
 * parent session and the RLM child id from the job's session file, for a subagent; a root job has neither. `reopenedAt` is the owner's later
 * send or unarchive, which ends the cancel.
 */
export type JobCancel = CancelRequest & { reopenedAt?: number };
export type JobCancelMap = Readonly<Record<string, JobCancel>>;

export const JOB_CANCELS_FILE = "job-cancels.json";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const optionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Who asked, from a record or a request body; null for anything else. */
export function parseCancelBy(value: Record<string, unknown>): CancelBy | null {
  if (value.by === "owner") return { by: "owner" };
  return value.by === "chat" && typeof value.chat === "string" && SESSION_ID.test(value.chat) ? { by: "chat", chat: value.chat } : null;
}

function parseCancel(value: unknown): JobCancel | null {
  if (!isRecord(value) || typeof value.at !== "number" || (value.how !== "stop" && value.how !== "archive")) return null;
  const by = parseCancelBy(value);
  if (!by || !optionalString(value.parent) || !optionalString(value.child) || !optionalString(value.name)) return null;
  if (value.reopenedAt !== undefined && typeof value.reopenedAt !== "number") return null;
  return { at: value.at, how: value.how, ...by, ...value.parent ? { parent: value.parent } : {}, ...value.child ? { child: value.child } : {},
    ...value.name ? { name: value.name } : {}, ...value.reopenedAt !== undefined ? { reopenedAt: value.reopenedAt } : {} };
}

/** `{ [job session id]: JobCancel }` from the file's JSON; entries that do not parse are dropped. */
export function parseJobCancels(value: unknown): Record<string, JobCancel> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([session, entry]) => { const cancel = parseCancel(entry); return cancel ? [[session, cancel]] : []; }));
}

/** Whether the cancel still holds: the owner has not reopened the job since. */
export const cancelHolds = (cancel: JobCancel | undefined): cancel is JobCancel => cancel !== undefined && cancel.reopenedAt === undefined;

export interface JobCancelRecord {
  /** Records a cancel of the job session `session`; an earlier cancel that still holds keeps its time, way and asker. */
  cancel(session: string, cancel: CancelRequest): Promise<JobCancel>;
  /** Ends a holding cancel at `at`: the owner sent the job a message or unarchived it. False when none held. */
  reopen(session: string, at: number): Promise<boolean>;
  /** The cancel of `session` while it holds. */
  holding(session: string): Promise<JobCancel | undefined>;
  all(): Promise<JobCancelMap>;
}

/** `<data dir>/job-cancels.json`, written whole by rename under its lock, so a reader without the lock sees a whole file. */
export function jobCancelRecord(path: string): JobCancelRecord {
  const file: JsonFile<Record<string, JobCancel>> = { path, label: "Job cancel record", initial: () => ({}), parse: parseJobCancels };
  return {
    async cancel(session, cancel) {
      let kept!: JobCancel;
      await transactJsonFile(file, state => {
        const held = state[session];
        kept = cancelHolds(held) ? held : { ...cancel };
        state[session] = kept;
      });
      return kept;
    },
    async reopen(session, at) {
      let ended = false;
      await transactJsonFile(file, state => {
        const held = state[session];
        if (!cancelHolds(held)) return;
        state[session] = { ...held, reopenedAt: at };
        ended = true;
      });
      return ended;
    },
    async holding(session) { const cancel = (await snapshotJsonFile(file))[session]; return cancelHolds(cancel) ? cancel : undefined; },
    async all() { return await snapshotJsonFile(file); },
  };
}

/**
 * Where a job's session file says it sits: the parent session id from its header's `parentSession` and the RLM child id (its `sub-*` folder),
 * for a subagent; `{}` for a root or a file whose head does not read.
 */
export async function jobPlace(sessionFile: string): Promise<{ parent?: string; child?: string }> {
  const child = basename(dirname(sessionFile));
  if (!child.startsWith("sub-")) return {};
  let head = "";
  try {
    const handle = await open(sessionFile, "r");
    try { const buffer = Buffer.alloc(8192); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); head = buffer.subarray(0, bytesRead).toString("utf8"); }
    finally { await handle.close(); }
  } catch { return { child }; }
  try {
    const header = JSON.parse(head.split("\n", 1)[0]!) as { parentSession?: unknown };
    const parent = typeof header.parentSession === "string" ? basename(header.parentSession).replace(/\.jsonl$/, "") : undefined;
    return parent ? { parent, child } : { child };
  } catch { return { child }; }
}

/** Who asked for a cancel, in a sentence: "the owner", or "chat 01a14dd5-e9d3-705d-bd63-245c21b2eee2". */
export const cancelAsker = (cancel: CancelBy): string => cancel.by === "owner" ? "the owner" : `chat ${cancel.chat}`;

/** Who ended the job on purpose, opening a sentence: "The owner ended it on purpose". */
export const cancelPurpose = (cancel: CancelBy): string => cancel.by === "owner" ? "The owner ended it on purpose" : `Its chat ${cancel.chat} ended it on purpose`;

type Worded = Pick<JobCancel, "at" | "how"> & CancelBy;

/** The words for a cancel in a sentence: "stopped by the owner at 11:20", or "stopped by chat <id> at 08:11". */
export const cancelWords = (cancel: Worded): string =>
  `${cancel.how === "archive" ? "archived" : "stopped"} by ${cancelAsker(cancel)} at ${clockTime(cancel.at)}`;

/** The parent's notice for a cancelled child, in place of Prime's "[child-exited: no-reply ...]". */
export const cancelledNoticeText = (name: string, cancel: Worded): string =>
  `[child-exited: cancelled child:${name}] ${name} was ${cancelWords(cancel)}. ${cancelPurpose(cancel)}, so don't reopen it, message it to ` +
  "finish, or start a copy of it.";

/** Prime's notices about a child's end: the plain exit and the failed turn. */
const CHILD_END_TYPES: ReadonlySet<string> = new Set(["rlm_child_terminal_notice", "rlm_child_failure"]);
/**
 * A notice up to this long before the cancel's own time still belongs to it: the cancel is written before the abort, but a job whose worker
 * runs on another box stamps the notice with that box's clock, and NTP keeps the boxes well under it.
 */
export const CANCEL_CLOCK_SLACK_MS = 5_000;

type Notice = { role?: unknown; customType?: unknown; content?: unknown; details?: unknown; timestamp?: unknown };

/** The child id a child-end notice names, or null for any other message. */
export function childEndId(message: unknown): string | null {
  const notice = message as Notice;
  if (notice.role !== "custom" || typeof notice.customType !== "string" || !CHILD_END_TYPES.has(notice.customType)) return null;
  const details = isRecord(notice.details) ? notice.details : {};
  return typeof details.childId === "string" ? details.childId : null;
}

/** The cancel each child of session `parent` had, by child id, from the record. */
export function childCancels(parent: string, cancels: JobCancelMap): Map<string, JobCancel> {
  const byChild = new Map<string, JobCancel>();
  for (const cancel of Object.values(cancels)) if (cancel.parent === parent && cancel.child) byChild.set(cancel.child, cancel);
  return byChild;
}

/** Whether a child-end notice stamped `at` belongs to `cancel`: not before the cancel, and not after the owner reopened the child. */
export const noticeOfCancel = (at: number, cancel: JobCancel): boolean =>
  at >= cancel.at - CANCEL_CLOCK_SLACK_MS && (cancel.reopenedAt === undefined || at < cancel.reopenedAt);

/** The time a message is stamped with, or NaN. */
export const stampOf = (message: unknown): number => { const at = (message as Notice).timestamp; return typeof at === "number" ? at : Number.NaN; };

/**
 * The messages with each child-end notice of a child the owner cancelled rewritten (`cancelledNoticeText`), as a new array; undefined when none
 * changed. `cancelOf` gives the cancel a notice belongs to (`noticeOfCancel`), so a notice before the cancel, or after the owner reopened the
 * child, stays as Prime wrote it. Each rewrite depends only on the message and its cancel, which never changes once written, so the cached
 * prompt prefix stays the same.
 */
export function withCancelledNotices<T>(messages: readonly T[], cancelOf: (child: string, at: number) => JobCancel | undefined): T[] | undefined {
  let changed = false;
  const out = messages.map(message => {
    const child = childEndId(message);
    const cancel = child === null ? undefined : cancelOf(child, stampOf(message));
    if (!cancel) return message;
    const details = isRecord((message as Notice).details) ? (message as Notice).details as Record<string, unknown> : {};
    const name = typeof details.sessionName === "string" && details.sessionName ? details.sessionName : cancel.name ?? child!;
    changed = true;
    return { ...message, content: cancelledNoticeText(name, cancel), details: { ...details, kind: "cancelled", by: cancel.by, ...cancel.by === "chat" ? { chat: cancel.chat } : {}, at: cancel.at, how: cancel.how } };
  });
  return changed ? out : undefined;
}
