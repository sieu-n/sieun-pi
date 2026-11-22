/**
 * The flag of a run that keeps retrying a transient error. pi-pool's `durableSettings` gives pi-durable no retry count, so a run whose
 * error never clears sleeps out its backoff forever, and from outside it reads as sleeping like a run that waits for an account slot.
 * Agent factory asked on 11-22 that a turn retrying for more than 5 minutes carry "retrying since HH:MM: <error kind>" (KST) in its
 * thread's status, so the room's working line, the Jobs list and the fable sweep see it. It is a flag only and the retry goes on (c98).
 *
 * pi-durable keeps the retry in the conversation's `pi.live` document (`generation.retry`, the next try's time and the last error) and each
 * failed attempt as an assistant entry with `stopReason: "error"`, so the run's retrying start is the oldest of the error entries that end
 * the conversation, which a restart reads back the same.
 */
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId, Cursor, Harness } from "@earendil-works/pi-durable";

/** How long a run retries before its thread shows the flag, the 5 minutes agent factory named on 11-22. */
export const RETRY_FLAG_MS = 5 * 60_000;

/** A conversation's retry as pi-durable's `pi.live` document holds it, or undefined. */
export function liveRetry(value: unknown): { at: number; error: string } | undefined {
  const retry = (value as { generation?: { retry?: { at?: unknown; error?: unknown } } } | null | undefined)?.generation?.retry;
  return retry && typeof retry.at === "number" ? { at: retry.at, error: typeof retry.error === "string" ? retry.error : "" } : undefined;
}

/** A short name for a transient error, for the flag. */
export function retryKind(error: string): string {
  const hook = /token hook gave no token \((\w+)\)/.exec(error)?.[1];
  if (hook) return `pi-pool token hook ${hook}`;
  if (/(?<![a-z0-9])429(?![a-z0-9])|rate.?limit|too many requests/i.test(error)) return "429 rate limit";
  if (/(?<![a-z0-9])529(?![a-z0-9])|overloaded/i.test(error)) return "529 overloaded";
  const status = /(?<![a-z0-9])(5\d\d)(?![a-z0-9])/.exec(error)?.[1];
  if (status) return `${status} server error`;
  if (/fetch failed|socket|ECONN|network|connection|terminated|timed? out|timeout/i.test(error)) return "network error";
  return error.replace(/\s+/g, " ").trim().slice(0, 80) || "an error";
}

const KST = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** The flag text once the run has retried past `RETRY_FLAG_MS`, else undefined. */
export function retryingText(since: number, error: string, now: number): string | undefined {
  return now - since > RETRY_FLAG_MS ? `retrying since ${KST.format(since)}: ${retryKind(error)}` : undefined;
}

/** When the conversation's current retrying began: the timestamp of the oldest error entry in the run of them that ends it. */
export async function retrySince(harness: Harness, conversationId: ConversationId, context: Context): Promise<number | undefined> {
  let since: number | undefined;
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await harness.commit(tx => tx.scanEntries({ conversationId, order: "descending" }, 100, cursor), context);
    for (const entry of page.items) {
      if (entry.kind === "pi.system") continue;
      const message = entry.model?.[0] as Message | undefined;
      if (message?.role !== "assistant" || message.stopReason !== "error") return since;
      since = message.timestamp;
    }
    if (!page.next) return since;
    cursor = page.next;
  }
}
