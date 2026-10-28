/**
 * board.wake for pi threads. The wake files, the 30 s ticker, the CI reads and the `[wake]` texts are today's chat's own
 * (legacy/prime/user-history/src/wakes.ts), imported as they are. This file only names a thread's conversation as a wake "session", arms a wake
 * from the board skill's request, and hands a due wake to pi-host as an agent message from "board", which the turn wrappers mark as not the owner's.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cacheWatch, type CheckResult, parseWake, readRunState, runCheck, runStamp, startWakes, type Wake, type WakeDeps,
} from "../../../legacy/prime/user-history/src/wakes.ts";
import type { Host } from "./host/types.ts";
import { writeJson } from "./store.ts";

export type { Wake } from "../../../legacy/prime/user-history/src/wakes.ts";

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
 * Writes the wake's file, where the ticker finds it after a restart too. A check runs once first, from the home folder with sh and its own pace
 * as the time limit, as board.wake does on Prime's chat host; `passes` tells the skill to warn that the check already exits 0. The wake is set either way.
 */
export async function armWake(dir: string, thread: string, body: Record<string, unknown>, check: (command: string, timeoutMs: number) => Promise<CheckResult> = runCheck,
  now = Date.now()): Promise<{ wake: Wake; path: string; passes?: CheckResult }> {
  const { id, wake } = parseArm(thread, body, now);
  const passes = wake.on.kind === "check" ? await check(wake.on.command, wake.on.every) : undefined;
  const path = join(dir, `${id}.json`);
  writeJson(path, wake);
  return { wake, path, ...(passes?.ok ? { passes } : {}) };
}

export interface ThreadWakeOptions {
  dir: string;
  host: Pick<Host, "submit">;
  log: (line: string) => void;
  now?: () => number;
  everyMs?: number;
  runState?: WakeDeps["runState"];
  stamp?: WakeDeps["stamp"];
  check?: WakeDeps["check"];
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

/** Starts the legacy ticker on `dir`, delivering to pi-host threads; returns its stop. */
export function startThreadWakes(options: ThreadWakeOptions): () => void {
  adoptOldWakes(options.dir, options.log);
  const stale = cacheWatch(options.log);
  return startWakes({
    dir: options.dir, log: options.log, ...(options.now ? { now: options.now } : {}), ...(options.check ? { check: options.check } : {}),
    runState: options.runState ?? (on => readRunState(on, undefined, stale)),
    stamp: options.stamp ?? runStamp,
    deliver: async (session, text, _root, _kind, setAt) => {
      const { thread, conversation } = wakeTarget(session);
      await options.host.submit(thread, {
        ...(conversation !== 1 ? { conversation } : {}), text, whenBusy: "followUp", requestId: `wake:${session}:${setAt ?? 0}`,
        entry: { kind: "agent.message", data: { from: "board", via: "wake" } },
      });
    },
  }, options.everyMs);
}
