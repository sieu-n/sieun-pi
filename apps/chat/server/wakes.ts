/**
 * board.wake for pi threads. The wake files, the 30 s ticker, the CI reads and the `[wake]` texts are today's chat's own
 * (legacy/prime/user-history/src/wakes.ts), imported as they are, and the wakes live where a `WakeStore` keeps them (wakes-db.ts). This file
 * only names a thread's conversation as a wake "session", arms a wake from the board skill's request, hands a due wake to pi-host as an
 * agent message from "board", which the turn wrappers mark as not the owner's, and holds that wake until the thread answered the message.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cacheWatch, type CheckResult, parseWake, readRunState, runCheck, runStamp, startWakes, TICK_MS, type Wake, type WakeDeps,
} from "../../../legacy/prime/user-history/src/wakes.ts";
import type { Host } from "./host/types.ts";
import { writeJson } from "./store.ts";
import type { WakeStore } from "./wakes-db.ts";

export { parseWake };
export type { CheckResult, Wake } from "../../../legacy/prime/user-history/src/wakes.ts";

/** A wake's `session` for a thread's conversation; the legacy file format keys every wake by one session id. */
export const wakeSession = (thread: string, conversation: number): string => `${thread}--${conversation}`;

/** The thread and conversation a wake's `session` names. */
export function wakeTarget(session: string): { thread: string; conversation: number } {
  const at = session.lastIndexOf("--");
  const conversation = at > 0 ? Number(session.slice(at + 2)) : NaN;
  return Number.isInteger(conversation) && conversation >= 1 ? { thread: session.slice(0, at), conversation } : { thread: session, conversation: 1 };
}

const FILE_ID = /^[\w.-]{1,160}$/;

/**
 * The board skill's request: `{id, conversation, on, note, since}`, where `on` is the WakeOn that `board.wake` builds for Prime. A kernel
 * still on the skill before run and check wakes sends `{id, conversation, at, text}`; that becomes a time wake whose note is the text after its time.
 */
export function parseArm(thread: string, body: Record<string, unknown>, now: number): { id: string; wake: Wake } {
  const conversation = Number.isInteger(body.conversation) && (body.conversation as number) >= 1 ? (body.conversation as number) : 1;
  const session = wakeSession(thread, conversation);
  const legacy = body.on === undefined && body.at !== undefined;
  const on = legacy ? { kind: "time", at: Number(body.at) } : body.on;
  const note = legacy ? (typeof body.text === "string" ? body.text.replace(/^It is \S+\.\s*/, "") : "") : body.note;
  const wake = parseWake({ session, on, note: typeof note === "string" ? note : "", since: typeof body.since === "number" ? body.since : now });
  if (!wake) throw new Error("A wake needs on={kind: \"run\", run} or {kind: \"time\", at} or {kind: \"check\", command, every, at}, with times in epoch ms.");
  const key = wake.on.kind === "run" ? `run-${wake.on.run}` : wake.on.kind === "time" ? `time-${Math.round(wake.on.at / 1000)}` : `check-${now}`;
  const id = typeof body.id === "string" && FILE_ID.test(body.id) ? body.id : `${session}-${key}`;
  return { id, wake };
}

/**
 * Stores the wake, where the ticker finds it after a restart too, and settles once it is stored. Arming runs no check: board.wake runs a
 * check once in the caller's kernel, on the box that runs it later, to warn that it already exits 0. On 11-04 the arm request ran it here
 * and took 6.1 s at p90 and 14.7 s at most over 98 calls, since checks run git fetch, ssh and curl.
 */
export async function armWake(store: WakeStore, thread: string, body: Record<string, unknown>, now = Date.now()): Promise<{ wake: Wake; path: string }> {
  const { id, wake } = parseArm(thread, body, now);
  await store.put(id, wake);
  return { wake, path: store.where(id) };
}

/** Runs a check's command on a thread's box for `thread`, whose id tags what the command starts. */
export type BoxCheckRun = (command: string, timeoutMs: number, thread: string) => Promise<CheckResult>;

export interface ThreadWakeOptions {
  wakes: WakeStore;
  host: Pick<Host, "submit" | "wait">;
  log: (line: string) => void;
  now?: () => number;
  everyMs?: number;
  runState?: WakeDeps["runState"];
  stamp?: WakeDeps["stamp"];
  check?: WakeDeps["check"];
  /** The check of a thread on another box, run by that box's relay; undefined runs it on this box. */
  checkOn?: (thread: string) => BoxCheckRun | undefined;
  /** The text a due wake sends, from the ticker's text; Remind me swaps its `[wake]` line for the post it names (later-agents.ts). */
  expand?: (text: string) => string;
  /** Runs once the thread took a due wake's text, with the ticker's text. */
  delivered?: (text: string) => void;
}

/**
 * Runs a check on the box of the thread whose wake it is, tagged with that thread as pi-host tags a thread's kernel (rlm.ts ownerTag), so a unit
 * the check starts names its owner to the d2 orphan reaper.
 */
function boxCheck(checkOn: NonNullable<ThreadWakeOptions["checkOn"]>): NonNullable<WakeDeps["check"]> {
  return (command, timeoutMs, session) => {
    const { thread } = wakeTarget(session);
    const remote = checkOn(thread);
    return remote ? remote(command, timeoutMs, thread) : runCheck(command, timeoutMs, thread);
  };
}

/**
 * Rewrites each time wake that apps/chat wrote before it took run and check wakes (`{id, thread, conversation?, at, text}`) in the legacy
 * format, which the ticker would otherwise remove as not a wake.
 */
export function adoptOldWakes(dir: string, log: (line: string) => void): void {
  let names: string[] = [];
  try { names = readdirSync(dir).filter(name => name.endsWith(".json")); } catch { return; }
  for (const name of names) {
    try {
      const old = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
      if (typeof old.thread !== "string" || old.on !== undefined || old.session !== undefined) continue;
      const { wake } = parseArm(old.thread, old, Date.now());
      writeJson(join(dir, name), wake);
      log(`wakes: ${name} moved to the legacy format`);
    } catch (error) {
      log(`wakes: ${name} not moved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** pi-host's answer that it holds no such thread or submission, so no answer to wait for will come. */
const UNKNOWN = /\bno submission\b|\bNo (durable )?thread\b/i;

/**
 * Starts the legacy ticker on the store's wakes, delivering to pi-host threads; returns its stop.
 *
 * A wake that went out is held in the store until its thread answered the message that carries it (`WakeStore.hold`), so the step its note
 * names keeps its owner while the message waits behind a busy thread's queue and while the thread reads it. The held wakes are watched
 * again after a restart, at every beat while pi-host or its box is away, and let go when pi-host no longer knows the submission.
 */
export function startThreadWakes(options: ThreadWakeOptions): () => void {
  const { wakes, host, log } = options;
  wakes.adopt(log);
  const stale = cacheWatch(log);
  const watching = new Set<string>();
  const watch = (): void => {
    for (const { id, wake, sent } of wakes.held()) {
      const key = `${id}:${sent.submission}`;
      if (watching.has(key)) continue;
      watching.add(key);
      void host.wait(wakeTarget(wake.session).thread, sent.submission).then(() => true, (error: unknown) => {
        const unknown = UNKNOWN.test(error instanceof Error ? error.message : String(error));
        if (unknown) log(`wakes: ${id} let go, ${String(error)}`);
        return unknown;
      }).then(async over => {
        // A wake set again under the same id while this one was held is another wake, and stays.
        if (over && wakes.held().some(held => held.id === id && held.sent.submission === sent.submission)) await wakes.remove(id);
      }).catch((error: unknown) => log(`wakes: ${id} not let go: ${String(error)}`)).finally(() => watching.delete(key));
    }
  };
  const stopWakes = startWakes({
    dir: wakes.dir, log, ...(options.now ? { now: options.now } : {}),
    files: {
      ...wakes.files,
      sent: async (id, submission) => {
        // A wake to a removed job has no submission (pi-host answers `{dropped}`), so nothing holds it.
        if (typeof submission !== "number") return wakes.remove(id);
        await wakes.hold(id, { submission, at: (options.now ?? Date.now)() });
        watch();
      },
    },
    check: options.check ?? boxCheck(options.checkOn ?? (() => undefined)),
    runState: options.runState ?? (on => readRunState(on, undefined, stale)),
    stamp: options.stamp ?? runStamp,
    deliver: async (session, text, _root, _kind, setAt) => {
      const { thread, conversation } = wakeTarget(session);
      const sent = await host.submit(thread, {
        ...(conversation !== 1 ? { conversation } : {}), text: options.expand?.(text) ?? text, whenBusy: "followUp", requestId: `wake:${session}:${setAt ?? 0}`,
        entry: { kind: "agent.message", data: { from: "board", via: "wake" } },
      });
      options.delivered?.(text);
      return sent.submission;
    },
  }, options.everyMs);
  watch();
  const timer = setInterval(watch, options.everyMs ?? TICK_MS);
  timer.unref();
  return () => { stopWakes(); clearInterval(timer); };
}
