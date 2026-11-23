/**
 * What pi-host does when a root conversation's run ends with no answer because its model call failed, and how an owner post such a run
 * left unanswered gets its turn again.
 *
 * pi-durable retries every error pi-ai's `isRetryableAssistantError` calls transient, with no retry count (pi-pool `durableSettings`), so
 * a run that still ends `unanswered` with `model_error` or `no_model` met an error that a retry of the same request cannot fix, such as
 * a 400 for a bad image media type: on 11-22 comm thread 5d50e997 failed that way on the owner's posts 42 and 43 in #dev-app-search-prospect,
 * and nothing told the room or anyone else. So each such run tells someone once:
 *
 * 1. A comm thread whose failed run held a room post writes `roomLine` as its own tell_owner call and result, which apps/chat's feed
 *    (`apps/chat/server/rooms.ts` `readFeedThread`) posts in the room in the thread of that post, and agent factory's work thread gets
 *    `failureNotice`.
 * 2. A job's agent's work thread gets `failureNotice`, so a job never reads as working while it is dead.
 * 3. A work thread, or a thread with no agent, sends `failureNotice` to agent factory's work thread. No thread tells itself, since that
 *    input would start a run on the same context and fail again, so agent factory's own work thread tells its DM comm thread, which tells
 *    the owner: on 11-23 its 11 failed compaction turns only logged "run failed with no one to tell".
 *
 * A pi-host child conversation reports its own failure to its parent as `[child-failed ...]` (`children.ts`), so only roots come here.
 * Request ids keyed by the failed submission keep each line and notice once.
 *
 * After a fix ships, `retryInput` gives a comm thread's newest owner post its turn again when the run that held it failed and no later
 * call of the thread answered or closed it; the retry's request id `retry:<the post's request id>` keeps it to one retry per post. A post
 * whose run failed on an error that clears on its own gets that retry at once (`clearsOnItsOwn`).
 */
import type { Context } from "@earendil-works/chord";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { AssistantEntry, ROOT_CONVERSATION_ID, ToolResultEntry, type CommitChange, type Cursor, type EntryRecord, type Harness, type Storage, type SubmissionDraft, type SubmissionRecord } from "@earendil-works/pi-durable";
import { DatabaseSync } from "node:sqlite";
import { PLATFORM_AGENT, type AgentRef } from "./agent-profile.ts";
import { TOLD } from "./turn-end.ts";

/**
 * What the room reads when a comm thread's run on its post failed: who hears of it, or, when nobody does, the error itself, so the room says
 * why. A compose dev instance has no agent factory, and on 11-23 its line said "agent factory is told" over a missing API key.
 */
export function roomLine(told: string | undefined, error: string): string {
  if (told) return `I couldn't read this post because of an error on my side, and ${told} is told.`;
  const reason = error.replace(/\s+/g, " ").trim().slice(0, 300);
  return `I couldn't read this post because of an error on my side${reason ? `: ${reason}` : "."}`;
}

/** The name `roomLine` gives the work thread that `failureTarget` picks. */
export function toldName(ref: AgentRef | undefined): string {
  return failureTarget(ref) === PLATFORM_AGENT.id ? PLATFORM_AGENT.name : failureTarget(ref);
}

/**
 * Whether a failed input is `retryInput`'s retry of a post. Its room already shows the line of the first failure, so a retry that fails
 * again posts none: on 11-23 each `docker compose down` and `up` of a dev instance with no API key added the same line under the post.
 */
export const isRetry = (failed: FailedInput): boolean => failed.requestId?.startsWith(RETRY) === true;
/**
 * Whether a failed run's error clears on its own, such as a dropped connection or pi-pool or the provider being unavailable for a moment, so
 * its post gets its one retry at once instead of after a restart. A 400 or a missing credential needs a fix first, so its retry waits for the
 * restart that ships the fix (`retryFailedPosts`). From 11-19 to 11-24, 9 of the 14 owner posts whose comm turn failed with no answer failed on
 * "Connection error" or pi-pool "service is temporarily unavailable", and waited 4 to 17 min for someone to send them again
 * (~/work/duty-and-nudge/part3-lazy.md).
 */
export const clearsOnItsOwn = (error: string): boolean =>
  /connection error|temporarily unavailable|fetch failed|ECONN|socket hang up|network|timed? ?out|overloaded|(?<![0-9])(429|5\d\d)(?![0-9])/i.test(error);
/** The `via` of a failure notice's agent message. */
export const TURN_FAILED_VIA = "turn.failed";
/** The settle reasons of a run whose model call failed (pi-durable generation.js `failModelError`, `failNoModel`, `classify`). */
const FAILED_REASONS = new Set(["model_error", "no_model"]);
const RETRY = "retry:";
/** The call id prefix of a room line, which `retryInput` does not count as an answer. */
const LINE_CALL = "turn-failed-";

/** One root input that a failed run settled with no answer. */
export interface FailedInput { submission: number; requestId?: string; reason: string; error: string }

const isFailed = (record: SubmissionRecord): boolean => record.type === "input" && record.status === "unanswered" && FAILED_REASONS.has(record.reason);
const errorOf = (record: SubmissionRecord): string =>
  record.status !== "unanswered" ? "" : typeof record.detail === "string" ? record.detail : record.detail === undefined ? record.reason : JSON.stringify(record.detail);

/** The root inputs of one commit that settled `unanswered` because the model call failed; a failed run settles all of its inputs in one commit. */
export function failedInputs(changes: readonly CommitChange[]): FailedInput[] {
  return changes.flatMap(change => {
    if (change.type !== "submission") return [];
    const record = change.value as SubmissionRecord;
    if (record.conversationId !== ROOT_CONVERSATION_ID || !isFailed(record)) return [];
    return [{ submission: record.id as number, ...(record.requestId ? { requestId: record.requestId } : {}), reason: record.reason!, error: errorOf(record) }];
  }).sort((a, b) => a.submission - b.submission);
}

/**
 * The room post a delivery's request id names, apps/chat's `d:<post>:<agent>` for a DM (rooms.ts) and `d:<room>:<post>:<agent>` for a
 * channel or Solo room (group-rooms.ts), as `<room>/<post>`; a retry's id names its post's. Undefined for any other input.
 */
export function roomPost(requestId: string | undefined, room: string): string | undefined {
  const base = requestId?.startsWith(RETRY) ? requestId.slice(RETRY.length) : requestId;
  const parts = base?.startsWith("d:") ? base.slice(2).split(":") : [];
  if (parts.length === 2 && parts[0]) return `${room}/${parts[0]}`;
  if (parts.length === 3 && parts[0] && parts[1]) return `${parts[0]}/${parts[1]}`;
  return undefined;
}

/** The settle reasons that end a root input with no failure of the run: a stop, a reset, or an input dropped before it ran. */
const NOT_FAILED = new Set(["aborted", "reset", "stale"]);
/** Whether a settled root input leaves its thread failed: unanswered for any reason but a stop, a reset or a dropped input. */
const failsRoot = (record: SubmissionRecord): boolean => record.status === "unanswered" && !NOT_FAILED.has(record.reason);

/**
 * Whether a commit leaves the thread's newest root turn failed, for the index row's `failed`: true when a root input settled unanswered
 * on a failure, false when one settled any other way, and undefined when no root input settled. A failure wins within one commit.
 */
export function rootFailed(changes: readonly CommitChange[]): boolean | undefined {
  let failed: boolean | undefined;
  for (const change of changes) {
    if (change.type !== "submission") continue;
    const record = change.value as SubmissionRecord;
    if (record.conversationId !== ROOT_CONVERSATION_ID || record.type !== "input") continue;
    if (failsRoot(record)) failed = true;
    else if (record.status === "done" || record.status === "unanswered") failed ??= false;
  }
  return failed;
}

/** Who hears of a failed run: an agent's work thread by agent id. */
export function failureTarget(ref: AgentRef | undefined): string {
  return ref?.role === "job" ? ref.agent : PLATFORM_AGENT.id;
}

/** The agent message a failed run sends: the thread, its role and the error, so the reader can open it. */
export function failureNotice(thread: { id: string; name: string }, ref: AgentRef | undefined, failed: FailedInput, toComm = false): string {
  const role = ref ? `${ref.role} of ${ref.agent}` : "a thread with no agent";
  return `[turn-failed thread:${thread.id} conversation:${ROOT_CONVERSATION_ID}]\n\n` +
    `The run of ${thread.name} (${role}) ended with no answer on input ${failed.requestId ?? `submission ${failed.submission}`}, ` +
    `and pi-host does not retry this error: ${failed.error}` +
    (toComm ? "\n\nYour work thread can't answer now. Tell the owner in a few words, and don't hand this to the work thread, which would fail again." : "");
}

/**
 * The comm thread's tell_owner call that posts `text`, a `roomLine`, in the thread of `post`, and its result, as two model writes. apps/chat's feed
 * posts a speaking call once its result says it went out (`TOLD`), so the room shows the line from the agent's name.
 */
export function roomLineWrites(failed: FailedInput, post: string, model: { api: string; provider: string; model: string }, at: number, text: string): SubmissionDraft[] {
  const id = `${LINE_CALL}${failed.submission}`;
  const call: Message = {
    role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text, reply_to: post } }],
    api: model.api, provider: model.provider, model: model.model, stopReason: "toolUse", timestamp: at,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as Message;
  const result: Message = { role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text: TOLD }], isError: false, timestamp: at };
  return [
    { type: "write", requestId: `${id}:call`, entry: { kind: AssistantEntry.kind, model: [call] } },
    { type: "write", requestId: `${id}:result`, entry: { kind: ToolResultEntry.kind, model: [result], data: { diagnostics: [] } } },
  ] as SubmissionDraft[];
}

/** The model fields of the newest assistant entry, which the room line copies so the next request reads it as the thread's own. */
export async function lastModel(harness: Harness, context: Context): Promise<{ api: string; provider: string; model: string } | undefined> {
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await harness.commit(tx => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "descending" }, 50, cursor), context);
    for (const entry of page.items) {
      const message = entry.model?.[0] as (Message & { api?: string; provider?: string; model?: string }) | undefined;
      if (message?.role === "assistant" && message.api && message.provider && message.model) return { api: message.api, provider: message.provider, model: message.model };
    }
    if (!page.next) return undefined;
    cursor = page.next;
  }
}

const POST_CALLS = new Set(["tell_owner", "send_message", "edit_message", "mark_message", "set_emoji"]);

/** Whether an assistant message after the post's input replies to the post, edits its reply, or marks or reacts to it; the room line is no answer. */
function names(message: Message | undefined, post: string): boolean {
  if (message?.role !== "assistant") return false;
  const id = post.slice(post.indexOf("/") + 1);
  const pattern = new RegExp(`(^|[^\\w])${id}($|[^\\w])`);
  return message.content.some(part => part.type === "toolCall" && POST_CALLS.has(part.name) && !part.id.startsWith(LINE_CALL) &&
    [part.arguments.reply_to, part.arguments.message_id].some(value => typeof value === "string" && pattern.test(value)));
}

/** The input to submit again: the owner post's own content under its retry request id. */
export interface RetryInput { requestId: string; text: string; images: { data: string; mimeType: string }[] }

/**
 * The retry of a comm thread's newest owner post, when the run that held it failed on its model call and no later call of the thread
 * names that post, or undefined. A post is the owner's when apps/chat delivered it (`d:` request id) as a `pi.user` entry; agents'
 * posts come as `agent.message`. A newer owner post that is queued, running or answered, an abort, or a retry already made decides no.
 */
export async function retryInput(harness: Harness, storage: Pick<Storage, "scanSubmissions">, room: string, context: Context): Promise<RetryInput | undefined> {
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID, order: "descending" }, 50, cursor, context);
    for (const record of page.items) {
      const post = record.type === "input" ? roomPost(record.requestId, room) : undefined;
      if (!post) continue;
      if (record.entry === undefined) return undefined;
      const entry = await harness.commit(tx => tx.entry(record.entry!), context);
      if (entry?.kind !== "pi.user") continue;
      if (!isFailed(record)) return undefined;
      const base = record.requestId!.startsWith(RETRY) ? record.requestId!.slice(RETRY.length) : record.requestId!;
      const requestId = `${RETRY}${base}`;
      if (await harness.commit(tx => tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId), context)) return undefined;
      if (await answeredAfter(harness, entry, post, context)) return undefined;
      const content = entry.model?.[0]?.content;
      const parts = (typeof content === "string" ? [{ type: "text", text: content }] : content ?? []) as (TextContent | ImageContent)[];
      return {
        requestId,
        text: parts.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n"),
        images: parts.flatMap(part => (part.type === "image" ? [{ data: part.data, mimeType: part.mimeType }] : [])),
      };
    }
    if (!page.next) return undefined;
    cursor = page.next;
  }
}

async function answeredAfter(harness: Harness, input: EntryRecord, post: string, context: Context): Promise<boolean> {
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await harness.commit(tx => tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending", minEntryId: (input.id + 1) as EntryRecord["id"] }, 200, cursor), context);
    if (page.items.some(entry => names(entry.model?.[0] as Message | undefined, post))) return true;
    if (!page.next) return false;
    cursor = page.next;
  }
}

/**
 * Whether a thread file's newest owner-delivered root input settled as a failed run, from a read-only look at its submissions, so pi-host
 * opens only those files after a restart. The open file then decides with `retryInput`. A file this cannot read answers false.
 */
export function mayRetry(file: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare(
      "SELECT s.record AS record FROM submissions s JOIN entries e ON e.id = json_extract(s.record, '$.entry') " +
      "WHERE s.conversation_id = 1 AND (json_extract(s.record, '$.requestId') LIKE 'd:%' OR json_extract(s.record, '$.requestId') LIKE 'retry:d:%') " +
      "AND json_extract(e.record, '$.kind') = 'pi.user' ORDER BY s.id DESC LIMIT 1",
    ).get() as { record?: string } | undefined;
    return row?.record ? isFailed(JSON.parse(row.record) as SubmissionRecord) : false;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Whether the newest settled root input of a thread file leaves the thread failed, by `rootFailed`'s rule, or undefined when none settled
 * or the file does not read. A read-only look, as `mayRetry`. pi-host's start uses it to clear a `failed` an older build wrote: before
 * 58af9c85 a stop marked its thread failed, and on 11-23 20 of the 66 threads that read failed on us-metal02, such as duty thread
 * efbf242e, had only been stopped.
 */
export function newestRootFailed(file: string): boolean | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare(
      "SELECT record FROM submissions WHERE conversation_id = 1 AND status IN ('done', 'unanswered') AND json_extract(record, '$.type') = 'input' " +
      "ORDER BY id DESC LIMIT 1",
    ).get() as { record?: string } | undefined;
    return row?.record ? failsRoot(JSON.parse(row.record) as SubmissionRecord) : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
