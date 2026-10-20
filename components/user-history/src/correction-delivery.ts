import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "prime-agent";
import { jobLedgerPrompt, ledgerPrompt, type Ledger } from "./chat-corrections.ts";

export const CORRECTION_CHECKPOINT = "chat_correction_checkpoint";

type Checkpoint = { kind: "snapshot" | "update"; lines: string[]; text: string; after: string | null };

const message = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
/** False for a failed or aborted reply: pi-ai drops it from every provider request. */
const sent = (value: AgentMessage): boolean => !(value.role === "assistant" && (value.stopReason === "error" || value.stopReason === "aborted"));
const visible = (entry: SessionEntry): boolean => entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
const checkpoint = (entry: SessionEntry): Checkpoint | null => {
  if (entry.type !== "custom" || entry.customType !== CORRECTION_CHECKPOINT || typeof entry.data !== "object" || entry.data === null) return null;
  const data = entry.data as Partial<Checkpoint>;
  return (data.kind === "snapshot" || data.kind === "update") && Array.isArray(data.lines) && data.lines.every(line => typeof line === "string") &&
    typeof data.text === "string" && (typeof data.after === "string" || data.after === null) ? data as Checkpoint : null;
};

/** A session's first prompt, a job's brief, read from the whole branch so the block a compaction brings back reads it too; "" with none. */
function firstPrompt(branch: readonly SessionEntry[]): string {
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    return typeof content === "string" ? content : content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  }
  return "";
}

export function deliverCorrections(input: {
  messages: AgentMessage[];
  branch: SessionEntry[];
  ledger: Ledger | null;
  job: boolean;
  /** The correction ids the chat brief holds (BRIEF_CORRECTIONS): a chat reads those as a title line. */
  brief: ReadonlySet<string>;
  append: (data: Checkpoint) => void;
}): AgentMessage[] {
  const { branch, ledger, job, append } = input;
  const compact = branch.findLastIndex(entry => entry.type === "compaction");
  const active = branch.slice(compact + 1);
  const checkpoints = active.flatMap(entry => { const data = checkpoint(entry); return data ? [data] : []; });
  const previous = checkpoints.at(-1);
  // The block goes in once per context: at the first call, and again after a compaction. A later ledger change is not sent; the session reads
  // the new rule with board.corrections(). Old sessions keep their "update" checkpoints where they were, so their cached prefix holds.
  const current = previous ? null : job ? jobLedgerPrompt(ledger, firstPrompt(branch)) : ledger && ledgerPrompt(ledger, input.brief);
  if (current !== null && (ledger !== null || job)) {
    const after = active.findLast(visible)?.id ?? (compact >= 0 ? branch[compact]!.id : null);
    const data: Checkpoint = { kind: "snapshot", lines: current.split("\n"), text: current, after };
    append(data);
    checkpoints.push(data);
  }
  if (!checkpoints.length) return input.messages;
  const live = compact < 0 ? branch : (() => {
    const compaction = branch[compact]!;
    if (compaction.type !== "compaction") return active;
    const kept = branch.findIndex(entry => entry.id === compaction.firstKeptEntryId);
    return [compaction, ...(kept < 0 ? [] : branch.slice(kept, compact)), ...active];
  })();
  const newestDigest = branch.findLastIndex(entry => entry.type === "custom_message" && entry.customType === "harness_digest");
  const compactedDigest = compact >= 0 && branch[compact]?.type === "compaction" && branch[compact].harnessDigest !== undefined;
  const keepDigest = compactedDigest && newestDigest <= compact ? null : branch[newestDigest]?.id;
  // Counted back from the newest message, skipping failed replies: Prime keeps a retried call's failed reply in the session but not in the
  // context, so counting from the start put the checkpoint at the end, where it moved on every call and rewrote the prompt cache.
  const counted = live.filter(entry => !(entry.type === "custom_message" && entry.customType === "harness_digest" && entry.id !== keepDigest) &&
    (entry.type === "compaction" || visible(entry)) && (entry.type !== "message" || sent(entry.message))).map(entry => entry.id);
  const at = (after: string | null) => {
    let index = input.messages.length;
    for (let left = counted.length - 1 - (after ? counted.indexOf(after) : -1); index > 0 && left > 0; index--) if (sent(input.messages[index - 1]!)) left--;
    return index;
  };
  const messages = [...input.messages];
  for (const data of [...checkpoints].reverse()) messages.splice(at(data.after), 0, message(data.text));
  return messages;
}
