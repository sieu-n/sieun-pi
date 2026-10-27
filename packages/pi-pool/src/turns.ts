import { readFileSync, statSync } from "node:fs";
import type { PoolCall } from "./errors.ts";

export interface AdmitReply { state: "admitted" | "queued" | "off" | "released"; kind: string | null; position: number | null; total: number | null }

/** Where turns.json has `sid` now: working, queued, gone, or null when the file cannot be read. */
export function placeIn(text: string, sid: string): { part: "working" | "queued" | "gone"; kind: string | null } | null {
  try {
    const turns = JSON.parse(text) as { working?: Record<string, { kind?: unknown }>; queued?: Record<string, unknown> } | null;
    if (!turns || typeof turns !== "object") return null;
    const working = turns.working?.[sid];
    if (working) return { part: "working", kind: typeof working.kind === "string" ? working.kind : null };
    return { part: turns.queued?.[sid] ? "queued" : "gone", kind: null };
  } catch {
    return null;
  }
}

/** The admit answer on the last line of the CLI's output, or null. */
export function admitReply(out: string): AdmitReply | null {
  try {
    const reply = JSON.parse(out.trim().split("\n").at(-1) ?? "") as AdmitReply;
    return typeof reply.state === "string" ? reply : null;
  } catch {
    return null;
  }
}

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

const WAIT_READ_MS = 1000;
const WAIT_ASK_MS = 30_000;

export interface AdmitWait { result: Promise<AdmitReply | "stopped" | "failed">; cancel: () => void }

/**
 * Waits for one run's working slot in this machine's turn queue (pool/turns.py), with no process of its own: the
 * first ask queues the run, an unlocked read of turns.json each WAIT_READ_MS sees the admit that another run's
 * release made, and a plain ask every WAIT_ASK_MS keeps the place. Pi has no credential wait to park a run in, so
 * the run waits here until its slot, the queue turns off, an error that leaves no entry (fail open), or an abort,
 * which releases the entry.
 */
export function admitWait(pool: PoolCall, turnsFile: string, sid: string, signal: AbortSignal | undefined, onQueued: (reply: AdmitReply) => void): AdmitWait {
  let cancel = () => {};
  const readPlace = () => {
    try {
      return placeIn(readFileSync(turnsFile, "utf8"), sid);
    } catch {
      return null;
    }
  };
  const result = new Promise<AdmitReply | "stopped" | "failed">(resolve => {
    let done = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let askedAt = 0;
    let seen = 0;
    const finish = (value: AdmitReply | "stopped" | "failed") => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(value);
    };
    const stop = () => {
      if (done || stopped) return;
      stopped = true;
      void pool(["release", sid]).finally(() => finish("stopped"));
    };
    cancel = stop;
    signal?.addEventListener("abort", stop, { once: true });
    const ask = async (): Promise<boolean> => {
      askedAt = Date.now();
      const res = await pool(["admit", sid]);
      if (stopped) {
        void pool(["release", sid]);
        return true;
      }
      const reply = admitReply(res.out);
      if (!res.ok || !reply) {
        const place = readPlace();
        if (place?.part === "working") {
          finish({ state: "admitted", kind: place.kind, position: null, total: null });
          return true;
        }
        if (place?.part === "queued") return false;
        finish("failed");
        return true;
      }
      if (reply.state === "queued") {
        onQueued(reply);
        return false;
      }
      finish(reply.state === "admitted" || reply.state === "off" ? reply : "failed");
      return true;
    };
    const tick = async () => {
      timer = undefined;
      if (done || stopped) return;
      if (signal?.aborted) return stop();
      let again = Date.now() - askedAt >= WAIT_ASK_MS;
      if (!again) {
        try {
          const mtime = statSync(turnsFile).mtimeMs;
          if (mtime !== seen) {
            seen = mtime;
            const place = readPlace();
            if (place?.part === "working") return finish({ state: "admitted", kind: place.kind, position: null, total: null });
            if (place?.part === "gone") again = true;
          }
        } catch {
          again = true;
        }
      }
      if (again && (await ask())) return;
      if (!done) timer = setTimeout(() => void tick(), WAIT_READ_MS);
    };
    void ask().then(over => {
      if (!over && !done) timer = setTimeout(() => void tick(), WAIT_READ_MS);
    });
  });
  return { result, cancel: () => cancel() };
}
