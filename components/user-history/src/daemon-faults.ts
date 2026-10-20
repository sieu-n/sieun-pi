/**
 * Daemon calls that failed or ran over SLOW_MS, read from the chat service's log and the supervisor's own log, for the Whole system precheck
 * (scripts/duties/whole-system.ts). The VP's rule on 10-18: a minute where opening a chat (the daemon's attach), a status read (get_state or
 * get_queue) or a send to a session fails or takes over 30 s, on either box, is not clean. That day requests routed to Mac worker 35553 hung
 * from about 08:03Z (`open 01a11ba8 ... failed: Timed out after 30000ms waiting for the Prime Agent daemon response to "attach". Socket:
 * .../hosts/mac.sock`), and the owner's open of AI harness developer environment timed out its 30 s attach on us-metal02 at 08:16Z, while
 * every watch line read both boxes usable.
 */

/** The owner's line: an open, status read or send that takes longer than this is a fault even when it answers. */
export const SLOW_MS = 30_000;

export interface DaemonFault {
  at: number;
  /** The box whose daemon the call went to: the `hosts/<name>.sock` bridge it named, else the box that wrote the log. */
  host: string;
  /** The session the call was for, a short or full id; absent for a supervisor line or a create, which names a session title instead. */
  session?: string;
  /** A create's session title, which names its chat. */
  title?: string;
  what: string;
  /** The daemon command whose answer timed out and how long the service waited, from a "Timed out after <ms>ms ... to "<call>"" line. */
  timedOut?: { call: string; ms: number };
  /** The outbox's id of the message a send carried (`m-<uuid>`), which its "is landed" line names (src/slot-wait-timeouts.ts). */
  message?: string;
}

const STAMPED = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/;
const SUPERVISOR = /^\[(\S+Z)\] supervisor: Supervisor command (\w+) failed: (?:Error: )?(.*)$/;
const OPEN = /^open ([0-9a-f]{8})(?: on ([\w.-]+))? (?:live|saved) \d+ messages: (.*), total (\d+)ms$/;
const WORKER_START = /^daemon (create|resume|reload) (.+?): (answered|refused) in ([\d.]+) s(?:: (.*))?$/;
/**
 * A create refused because a session of its name exists: an earlier create of the same job that the daemon finished though its caller lost
 * the answer, which the duty adopts (src/chat-duty-job.ts). 10-18 11:37:37Z the release cut off "visitors become paying users slack green guy
 * 20:37" ("client closed", a fault), and its retry at 11:40:09Z was refused for the name, so the minute of the retry is no new fault.
 */
const NAME_TAKEN = /is unavailable: an agent of that name already exists/;
const WORKER_NO_ANSWER = /^daemon (create|resume|reload) (.+): no answer after ([\d.]+) s: (.*)$/;
/**
 * The service closed its own daemon link: DaemonClient.close() is the only source of this error, and the clients of worker starts belong to
 * the catalog, which closes them only when the service stops. 10-18 12:29:18Z the release cut "check-in metal-management 21:29" 3.3 s in, the
 * daemon made the session anyway, and the next service's retry at 12:30:15Z found its name and the duty adopted it.
 */
const OWN_STOP = /Prime Agent daemon client closed before the operation completed/;
/**
 * A worker that a client asked to shut down over its socket: the wait_for_idle the same client still had open fails with "Daemon worker client
 * closed" 1 to 2 ms later, a stop it asked for. The watchdog's model probe (components/watchdog/wd_probe.py) ends its --no-session rpc client
 * this way every 10 min, and from 23:33Z on 10-19 to 00:43Z on 10-20 its 13 such failures made 8 d7 minutes dirty while every box read usable.
 */
const ASKED_STOP = /^\[(\S+Z)\] supervisor: Session worker \S+ stderr: shutdown command received over socket/;
/** The measured gap was 1 to 2 ms on 10-20; a failure a full second after the stop is no longer read as its echo. */
const ASKED_STOP_MS = 1000;
/**
 * An agent message the outbox held while its target's worker stopped or started (src/agent-outbox.ts). The wait counts once it passes
 * SLOW_MS, as a send that slow would; the refusals before it are no fault of their own, since the outbox delivered each such message.
 */
const OUTBOX_MOVED = /^outbox ([0-9a-f]{8})(?: on [\w.-]+)?: m-\S+ went after its target's worker was (\w+) for (\d+) s$/;
/**
 * The service.log lines whose calls are opens, status reads or sends, by their prefix. Others, such as the catalog's copies of the Mac's
 * session files (591 "read ECONNRESET" lines from 11:15Z on 10-18) and the session list, are background reads outside the rule.
 */
const IDLE_WORKER_FAILED = /^idle unload: [0-9a-f-]+: Session worker is failed\b/;
const PREFIXED = /^(idle unload|wakes: wake|reopen|briefs: child|outbox|pin|chat|job [0-9a-f]{8}: (\w+))\b/;
const FILE_READ = /The session file on [\w.-]+ (?:did not read|is gone)/;
const SESSION_IN = /\b(01[0-9a-f]{6})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/;
const SOCKET = /Socket: \S*\/hosts\/([\w.-]+)\.sock\b/;
/**
 * The box an outbox or open line names after its session (`outbox 01a11d25 on mac: ...`). Before, only a timeout's Socket named one, so on
 * 10-18 the refusals and waits of Mac sessions 01a11d25, 01a10810, 01a10db4, 01a11ba8 and 01a14ec1 were booked on us-metal02.
 */
const ON_BOX = /^(?:outbox|open) [0-9a-f]{8} on ([\w.-]+)[: ]/;
/** Calls outside the owner's rule: stopping an idle session and the catalog's own lists. */
const OTHER_CALLS = new Set(["kill", "list", "cron_list"]);
/**
 * Supervisor answers that are a caller's stale id, a close already under way, or a worker that is stopping or starting, not a daemon that
 * failed. The chat service waits out a moving worker and sends or attaches once more (src/worker-move.ts, src/agent-outbox.ts), and its own
 * line counts a wait over SLOW_MS: at 12:46:22Z on 10-18 the supervisor refused a send_message with "Session worker is stopping" that the outbox
 * waited out with no line, and the refusal alone made the minute dirty.
 */
const STALE = /Unknown active session|is closing|Session worker is (?:stopping|starting)/;

/**
 * A send that met a failed worker, opened its session again and went out (src/reopen-send.ts), with what the second send answered: "sent"
 * delivered it. At 16:42:36Z on 10-18 `reopen: 01a14edd answered "Session worker is failed"; opened it again and sent again: sent` counted as a
 * failed send, though the message landed 2 s after the first refusal.
 */
const REOPENED = /^reopen: [0-9a-f]{8} answered ".*"; opened it again and sent again: (.*)$/;
/**
 * A Prime worker's crash handler logs one of these and exits 1 (`installCrashHandlers` in the bundle), which drops every session the worker ran;
 * the supervisor then logs "Recovered worker <id> without replaying uncertain operations" and parks it failed until a client opens a session
 * again. On 10-18 us-metal02 logged six, each `unhandled rejection: Error: Lock file is already being held` (08:24Z, 12:26Z, 12:49Z, 16:14Z,
 * 16:37Z, 17:09Z), and none counted while the sends that met the dead worker did.
 */
const WORKER_CRASH = /^\[(\S+Z)\] supervisor: Session worker (\w+) stderr: (unhandled rejection|uncaught exception): (.*)$/;

const TIMED_OUT = /Timed out after (\d+)ms waiting for the Prime Agent daemon response to "(\w+)"/;
const MESSAGE_ID = /\b(m-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/;

/** The short reason of a daemon error, or undefined when the text is no daemon or connection failure, or one for a call outside the rule. */
export function faultReason(text: string): string | undefined {
  let found: RegExpExecArray | null;
  if ((found = TIMED_OUT.exec(text)))
    return OTHER_CALLS.has(found[2]!) ? undefined : `${found[2]} timed out after ${Number(found[1]) / 1000} s`;
  if ((found = /Timed out after (\d+)ms waiting for the Prime Agent daemon handshake/.exec(text))) return `the handshake timed out after ${Number(found[1]) / 1000} s`;
  if ((found = /Timed out waiting for daemon worker response to (\w+)/.exec(text))) return OTHER_CALLS.has(found[1]!) ? undefined : `${found[1]} timed out in its worker`;
  if (/Timed out waiting for snapshot/.test(text)) return "its snapshot timed out";
  if (/Connection to the Prime Agent daemon closed/.test(text)) return "the daemon connection closed";
  if (/Failed to connect to the Prime Agent daemon|Prime Agent daemon is not reachable/.test(text)) return "the daemon did not connect";
  if (/Prime Agent daemon client closed before the operation completed/.test(text)) return "the client closed before an answer";
  if (/Daemon worker (?:socket|client) closed/.test(text)) return "its worker's connection closed";
  if ((found = /Session worker is (failed|stopping|starting)/.exec(text))) return `its session worker was ${found[1]}`;
  if (/read ECONNRESET/.test(text)) return "its worker reset the connection";
  // A pending-limit refusal is no fault: the outbox keeps every such send until the target has room (src/agent-outbox.ts), and
  // `readQueueOverruns` shows it as detail. On 10-18 01a0cc5e's refusals made each minute from 11:15Z dirty.
  return undefined;
}

/** A send that met a target over the daemon's pending message limit and waited in the agent outbox (src/agent-outbox.ts). */
export interface QueueOverrun { at: number; host: string; session: string; pending?: number; limit: number }

const OVER_TARGET = /^outbox ([0-9a-f]{8})(?: on [\w.-]+)?: (?:queued m-\S+ from .* while the target held (\d+|an unknown number) of (\d+) pending|the target is full at (\d+) of (\d+) pending)/;

/** The outbox lines of sends to a target over its pending limit: one the sender's kernel handed over (`queue`), or one the outbox met as full. */
export function readQueueOverruns(lines: readonly string[], local: string): QueueOverrun[] {
  const found: QueueOverrun[] = [];
  for (const raw of lines) {
    const stamped = STAMPED.exec(raw);
    const at = stamped ? Date.parse(stamped[1]!) : NaN;
    const line = stamped && OVER_TARGET.exec(stamped[2]!);
    if (!line || !Number.isFinite(at)) continue;
    const pending = Number(line[2] ?? line[4]);
    found.push({ at, host: hostOf(stamped[2]!, local), session: line[1]!, ...Number.isFinite(pending) ? { pending } : {}, limit: Number(line[3] ?? line[5]) });
  }
  return found;
}

const hostOf = (text: string, local: string): string => SOCKET.exec(text)?.[1] ?? ON_BOX.exec(text)?.[1] ?? local;

/** What a prefixed service.log line did, in the flag's words. */
const ACTIONS: Record<string, string> = { "idle unload": "an idle check", "wakes: wake": "a wake's send", reopen: "a send", "briefs: child": "a brief's send",
  outbox: "an outbox send", pin: "keeping it open", chat: "a chat call" };

/**
 * The faults in chat service log lines. A line written to stderr carries no stamp, so it takes the last stamped line's time, as
 * `readServiceLog` reads it: an open's line is written when the open ends. A worker start's stamp is its start, so its fault is at its end.
 */
export function readServiceFaults(lines: readonly string[], local: string): DaemonFault[] {
  const faults: DaemonFault[] = [];
  // A job's wake opens the job first, and a failed open writes its line just before the wake's (`job 01a14efc: wake: ...`), which names no box.
  const opened = new Map<string, string>();
  let at = NaN;
  for (const raw of lines) {
    const stamped = STAMPED.exec(raw);
    if (stamped) at = Date.parse(stamped[1]!);
    if (!Number.isFinite(at)) continue;
    const text = stamped ? stamped[2]! : raw;
    let found: RegExpExecArray | null;
    if ((found = OPEN.exec(text))) {
      const marks = found[3]!;
      opened.set(found[1]!, hostOf(text, local));
      const failed = /(?:^|, )failed: (.*)$/.exec(marks)?.[1];
      const reason = failed === undefined || /This thread was closed while it was/.test(failed) ? undefined : faultReason(failed) ?? failed.slice(0, 80);
      const tried = /(?:^|, )(?:queue|attach) \d+ms/.test(marks);
      const slow = tried && Number(found[4]) > SLOW_MS;
      if (reason || slow) faults.push({ at, host: hostOf(text, local), session: found[1]!,
        what: `opening it ${reason ? `failed, ${reason}` : `took ${Math.round(Number(found[4]) / 1000)} s`}` });
      continue;
    }
    if ((found = WORKER_START.exec(text))) {
      const seconds = Number(found[4]);
      const refused = found[3] === "refused" && !NAME_TAKEN.test(found[5] ?? "");
      if (refused || seconds * 1000 > SLOW_MS)
        faults.push({ at: at + seconds * 1000, host: local, ...titleOrSession(found[2]!), what: `its ${found[1]} was ${found[3]} in ${seconds} s${found[5] ? `, ${faultReason(found[5]) ?? found[5].slice(0, 80)}` : ""}` });
      continue;
    }
    if ((found = WORKER_NO_ANSWER.exec(text))) {
      if (OWN_STOP.test(found[4]!)) continue;
      faults.push({ at: at + Number(found[3]) * 1000, host: hostOf(text, local), ...titleOrSession(found[2]!), what: `its ${found[1]} got no answer, ${faultReason(found[4]!) ?? found[4]!.slice(0, 80)}` });
      continue;
    }
    if ((found = OUTBOX_MOVED.exec(text))) {
      if (Number(found[3]) * 1000 > SLOW_MS) faults.push({ at, host: hostOf(text, local), session: found[1]!, what: `an outbox send waited ${found[3]} s while its worker was ${found[2]}` });
      continue;
    }
    const prefix = PREFIXED.exec(text);
    const reopened = REOPENED.exec(text)?.[1];
    if (reopened === "sent") continue;
    // A job's wake that reads the job's file through another box's relay first ("The session file on mac did not read: read ECONNRESET", 625
    // lines from 11:15Z on 10-18) failed on a file read, before any daemon call.
    const reason = prefix && !FILE_READ.test(text) ? faultReason(reopened ?? text) ?? reopened?.slice(0, 80) : undefined;
    if (!prefix || !reason) continue;
    // An idle check that finds the worker already failed had nothing to stop, and nobody waited on it: the owner meets a failed worker when he
    // opens the chat, and that open, which resumes it, is counted on its own line. On 10-20 the one at 02:11:23Z made a d7 minute dirty.
    if (prefix[1] === "idle unload" && IDLE_WORKER_FAILED.test(text)) continue;
    const session = SESSION_IN.exec(text)?.[1];
    const wakeOf = prefix[2] === "wake" ? /^job ([0-9a-f]{8})/.exec(text)?.[1] : undefined;
    const host = SOCKET.exec(text)?.[1] ?? ON_BOX.exec(text)?.[1] ?? (wakeOf ? opened.get(wakeOf) : undefined) ?? local;
    const timed = TIMED_OUT.exec(text);
    const message = MESSAGE_ID.exec(text)?.[1];
    faults.push({ at, host, ...session ? { session } : {}, what: `${prefix[2] ? `a job's ${prefix[2]}` : ACTIONS[prefix[1]!]} failed, ${reason}`,
      ...timed ? { timedOut: { call: timed[2]!, ms: Number(timed[1]) } } : {}, ...message ? { message } : {} });
  }
  return faults;
}

const titleOrSession = (name: string): { session: string } | { title: string } => /^[0-9a-f]{8}$/.test(name) ? { session: name } : { title: name };

/** When each send that a reopen delivered went out, from the chat service's `reopen: ... sent again: sent` lines. */
export function readReopenedSends(lines: readonly string[]): number[] {
  const sent: number[] = [];
  for (const raw of lines) {
    const stamped = STAMPED.exec(raw);
    if (stamped && REOPENED.exec(stamped[2]!)?.[1] === "sent") sent.push(Date.parse(stamped[1]!));
  }
  return sent;
}

const minuteOf = (at: number): number => Math.floor(at / 60_000);

/**
 * The supervisor's failed commands and its workers' crashes in a daemon log's lines: they name no session, and they catch callers other than
 * the chat service. A send_message refused for a failed worker in a minute where a reopen delivered a send (`reopened`, from
 * `readReopenedSends`) is that send's first try. The refusals name no session, so the minute pairs them: on 10-18 each of the 14 refusals
 * before a reopen's "sent" came 1.3 to 5.6 s before it, in its minute (06:01Z, 08:16Z, 16:42Z, 17:14Z), and the 3 at 08:25Z had no reopen.
 */
export function readSupervisorFaults(lines: readonly string[], local: string, reopened: readonly number[] = []): DaemonFault[] {
  const faults: DaemonFault[] = [];
  const delivered = new Set(reopened.map(minuteOf));
  let askedStop = -Infinity;
  for (const line of lines) {
    const stop = ASKED_STOP.exec(line);
    if (stop) { askedStop = Date.parse(stop[1]!); continue; }
    const crash = WORKER_CRASH.exec(line);
    if (crash) {
      const at = Date.parse(crash[1]!);
      if (Number.isFinite(at)) faults.push({ at, host: local, what: `Prime worker ${crash[2]} crashed, ${crash[3]}: ${crash[4]!.slice(0, 80)}` });
      continue;
    }
    const found = SUPERVISOR.exec(line);
    if (!found || OTHER_CALLS.has(found[2]!) || STALE.test(found[3]!)) continue;
    const reason = faultReason(found[3]!);
    const at = Date.parse(found[1]!);
    if (found[2] === "send_message" && /Session worker is failed/.test(found[3]!) && delivered.has(minuteOf(at))) continue;
    if (found[2] === "wait_for_idle" && /Daemon worker client closed/.test(found[3]!) && at - askedStop <= ASKED_STOP_MS) continue;
    if (reason && Number.isFinite(at)) faults.push({ at, host: local, what: `the supervisor's ${found[2]} failed, ${reason}` });
  }
  return faults;
}

/** A session a box's catalog copy lists: the chat at the root of its tree and its own name. */
export interface ListedSession { root: string; name?: string; rootName?: string;
  /** The session's file on its own box, which src/slot-wait-timeouts.ts reads for a timed-out send's delivery. */
  file?: string }

const ROOT_IN_PATH = /\/session-artifacts\/([0-9a-f-]{36})\/|\/sessions\/([0-9a-f-]{36})\.jsonl$/;

/**
 * The sessions of `shorts` (short ids) in catalog copies' text: the box's own `session-copy.json` and each other box's `<host>.sessions.json`
 * (src/host-catalogs.ts `copyPath`), whose rows carry each session's file, under its root's folder, and its name. The Mac's copy was 38 MB on
 * 10-18, so this looks up the few ids a window's faults name by text search instead of parsing every row.
 */
export function listedSessions(texts: readonly string[], shorts: Iterable<string>): Map<string, ListedSession> {
  const row = (id: string): ListedSession | undefined => {
    for (const text of texts) {
      const at = text.indexOf(`"sessionId":"${id}`);
      if (at < 0) continue;
      const slice = text.slice(at, at + 4000);
      const file = /"sessionFile":"([^"]*)"/.exec(slice)?.[1];
      const root = file ? ROOT_IN_PATH.exec(file) : null;
      if (!root) continue;
      const name = /"sessionName":"((?:[^"\\]|\\.)*)"/.exec(slice)?.[1];
      return { root: root[1] ?? root[2]!, file: JSON.parse(`"${file}"`) as string, ...name ? { name: JSON.parse(`"${name}"`) as string } : {} };
    }
    return undefined;
  };
  const found = new Map<string, ListedSession>();
  for (const short of new Set(shorts)) {
    const own = row(short);
    if (!own) continue;
    const rootName = own.root.startsWith(short) ? own.name : row(own.root)?.name;
    found.set(short, { ...own, ...rootName ? { rootName } : {} });
  }
  return found;
}

/**
 * Names a fault's chat as the precheck names chats, by the title of its tree's root: the chat itself, or `<chat>, job <name>` for a job its
 * box's catalog copy lists (`listedSessions`) or a job of the chat (`named`); a create by its title; undefined when nothing names it. A short id
 * is a session id's first 8 characters, about a minute of a UUIDv7's clock, so two sessions can share one; the first match names it.
 */
export function chatNamer(chats: readonly { id: string; name: string }[], jobs: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map(),
  listed: ReadonlyMap<string, ListedSession> = new Map()): (fault: DaemonFault) => string | undefined {
  // The precheck names a chat no watch line titled by its short id; a catalog copy's name for it reads better.
  const byId = new Map(chats.filter(chat => chat.name !== chat.id.slice(0, 8)).map(chat => [chat.id, chat.name] as const));
  const jobOf = new Map<string, string>();
  for (const [chat, names] of jobs) for (const [job, sessions] of names) for (const session of sessions) jobOf.set(session, `${byId.get(chat) ?? chat.slice(0, 8)}, job ${job}`);
  const find = (map: ReadonlyMap<string, string>, short: string) => { for (const [id, name] of map) if (id.startsWith(short)) return name; return undefined; };
  return fault => {
    if (fault.title) return fault.title;
    if (!fault.session) return undefined;
    const short = fault.session.slice(0, 8);
    const own = find(byId, short) ?? find(jobOf, short);
    if (own) return own;
    const entry = listed.get(short);
    if (!entry) return undefined;
    const chat = byId.get(entry.root) ?? entry.rootName ?? `chat ${entry.root.slice(0, 8)}`;
    return entry.root.startsWith(short) ? chat : `${chat}, job ${entry.name ?? short}`;
  };
}

/**
 * One minute's faults in the flag's words: each chat once with its reasons, named chats first and then the busiest, at most `most` of them. A
 * fault nothing names reads as its short session id, or as its box's daemon for a supervisor line.
 */
export function faultWords(faults: readonly DaemonFault[], name: (fault: DaemonFault) => string | undefined, most = 3): string {
  const byChat = new Map<string, { named: boolean; reasons: Map<string, number> }>();
  for (const fault of faults) {
    const named = name(fault);
    const key = `${named ?? (fault.session ? `session ${fault.session.slice(0, 8)}` : `the ${fault.host} daemon`)} on ${fault.host}`;
    const entry = byChat.get(key) ?? { named: named !== undefined, reasons: new Map<string, number>() };
    entry.reasons.set(fault.what, (entry.reasons.get(fault.what) ?? 0) + 1);
    byChat.set(key, entry);
  }
  const total = (reasons: Map<string, number>) => [...reasons.values()].reduce((sum, count) => sum + count, 0);
  const sorted = [...byChat].sort((a, b) => Number(b[1].named) - Number(a[1].named) || total(b[1].reasons) - total(a[1].reasons));
  const words = sorted.slice(0, most).map(([chat, { reasons }]) => `${chat} (${[...reasons].map(([what, count]) => count > 1 ? `${what}, ${count} times` : what).join("; ")})`);
  return words.join(", ") + (sorted.length > most ? ` and ${sorted.length - most} more` : "");
}
