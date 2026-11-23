/**
 * What pi-host's settle and submit checks read from a conversation's context, kept per conversation and brought up to date from the entries
 * added since the last read. Prime's auto-refine check (`refine.ts` autoDue) runs at each settle of a root conversation, and Prime's harness
 * check (`prime-prompt.ts` deliverHarnessDigest) at each input submitted to one. Each read and parsed the whole context through
 * `Conversation.context` every time, which on 11-23 read 11,000 of the 15,000 entries a copy rig's 80 requests read
 * (~/work/pi-host-stalls/m-request-cpu/report.md); a comm root such as 5d50e997 holds 19.7 MB with no compaction.
 *
 * pi-durable keeps a context range for its generation tasks (`readContextFrom`), but only a task's runtime reads through it, and these checks
 * run outside a task. So a summary here holds the few things they use, per active entry: its id, whether it is an input, how many assistant
 * messages it contributes, and the newest four message texts. A later read scans only the entries after the summary's tail and extends it
 * the way `readContextFrom` extends a range: an added entry with edits or a head marker, or one an earlier edit targets, reads the whole
 * context again.
 */
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import type { ContextView, ConversationId, EntryId, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { queryText } from "./prime-harness.ts";

/** The newest message texts a summary keeps: Prime's harness check ranks by the last four (`digestQueryTerms`). */
export const RECENT_TEXTS = 4;

/** pi-durable drops an assistant message with one of these stop reasons from the context (`contribute` in harness/context.js). */
const EXCLUDED_STOP_REASONS = new Set(["aborted", "error", "deferred"]);

export interface ContextSummary {
  /** The context's head marker, when a compaction or reset started it. */
  readonly head: { readonly id: number; readonly kind: string } | undefined;
  /** The newest active entry's id; 0 for an empty context. */
  readonly tail: number;
  /** Each active entry's id, oldest first. */
  readonly ids: readonly number[];
  /** The assistant messages each active entry contributes, in the order of `ids`. */
  readonly assistants: readonly number[];
  /** The newest RECENT_TEXTS non-empty message texts of the context, oldest first, as `queryText` reads them. */
  readonly recent: readonly string[];
  /** Entries an edit in the context targets. */
  readonly edited: ReadonlySet<number>;
}

const contribution = (entry: EntryRecord): readonly Message[] =>
  (entry.model ?? []).filter(message => message.role !== "assistant" || !EXCLUDED_STOP_REASONS.has((message as { stopReason?: string }).stopReason ?? ""));

/** The summary of a whole context view. */
export function summarize(view: ContextView): ContextSummary {
  const edited = new Set<number>();
  const texts: string[] = [];
  view.entries.forEach((entry, index) => {
    for (const edit of entry.edits ?? []) edited.add(edit.target as number);
    for (const message of view.contributions[index] ?? []) {
      const text = queryText(entry, message);
      if (text) texts.push(text);
    }
  });
  return {
    head: view.head ? { id: view.head.id as number, kind: view.head.kind } : undefined,
    tail: view.entries.reduce((top, entry) => Math.max(top, entry.id as number), 0),
    ids: view.entries.map(entry => entry.id as number),
    assistants: view.contributions.map(messages => messages.filter(message => message.role === "assistant").length),
    recent: texts.slice(-RECENT_TEXTS),
    edited,
  };
}

/** `summary` with `added`, entries after its tail with no edits and no head marker, oldest first. */
function extend(summary: ContextSummary, added: readonly EntryRecord[]): ContextSummary {
  const texts = [...summary.recent];
  const assistants = [...summary.assistants];
  for (const entry of added) {
    const messages = contribution(entry);
    assistants.push(messages.filter(message => message.role === "assistant").length);
    for (const message of messages) {
      const text = queryText(entry, message);
      if (text) texts.push(text);
    }
  }
  return {
    head: summary.head,
    tail: Math.max(summary.tail, ...added.map(entry => entry.id as number)),
    ids: [...summary.ids, ...added.map(entry => entry.id as number)],
    assistants,
    recent: texts.slice(-RECENT_TEXTS),
    edited: summary.edited,
  };
}

/** The assistant messages of the summary's entries after `after`, as autoDue counts its turns. */
export function assistantsAfter(summary: ContextSummary, after: number): number {
  let turns = 0;
  summary.ids.forEach((id, index) => { if (id > after) turns += summary.assistants[index] ?? 0; });
  return turns;
}

/** Entries per page of the scan of added entries, pi-durable's page size (`SCAN_PAGE_SIZE`). */
const PAGE = 256;

/** The visible entries of `conversation` after `tail`, oldest first. */
async function entriesAfter(conversation: NonNullable<Awaited<ReturnType<Harness["conversation"]>>>, tail: number, context: Context): Promise<EntryRecord[]> {
  const out: EntryRecord[] = [];
  // Entry ids are numbers at run time; EntryId only brands them.
  const query = { minEntryId: (tail + 1) as unknown as EntryId, order: "ascending" as const };
  let cursor: Parameters<typeof conversation.entries>[2];
  do {
    const page = await conversation.entries(query, PAGE, cursor, context);
    out.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return out;
}

/** One summary per conversation of each open harness; a closed thread's harness and its summaries go together. */
const kept = new WeakMap<Harness, Map<ConversationId, ContextSummary>>();

/**
 * The summary of `conversationId`'s context now: the kept one extended by the entries added since, or one built from a whole read the first
 * time, and when an added entry carries edits or a head marker or is the target of an earlier edit. Undefined when the conversation is gone.
 * Calls for one conversation may run at once: each reads from the summary it found, and the one with the newer tail is kept.
 */
export async function contextSummary(harness: Harness, conversationId: ConversationId, context: Context): Promise<ContextSummary | undefined> {
  const conversation = await harness.conversation(conversationId, context);
  if (!conversation) return undefined;
  let own = kept.get(harness);
  if (!own) kept.set(harness, own = new Map());
  const before = own.get(conversationId);
  let next: ContextSummary | undefined;
  if (before) {
    const added = await entriesAfter(conversation, before.tail, context);
    if (!added.some(entry => entry.edits !== undefined || entry.head !== undefined || before.edited.has(entry.id as number))) next = added.length ? extend(before, added) : before;
  }
  next ??= summarize(await conversation.context(context));
  const now = own.get(conversationId);
  if (!now || now.tail <= next.tail) own.set(conversationId, next);
  return next;
}
