import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "prime-agent";
import { jobLedgerPrompt, ledgerPrompt, type Ledger, ruleId, ruleLines, snapshotRules, type SnapshotRule } from "./chat-corrections.ts";

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
  const current = job ? jobLedgerPrompt(ledger) : ledger && ledgerPrompt(ledger, input.brief);
  const lines = current?.split("\n") ?? [];
  if ((ledger !== null || (job && !previous)) && (current !== null || previous) && (!previous || previous.lines.join("\n") !== lines.join("\n"))) {
    const old = previous?.lines ?? [];
    // Removed means retired: a rule that changed its line or left a job's short list still holds, so it is not named.
    const inForce = new Set(ledger?.corrections.filter(entry => entry.status !== "retired").map(entry => entry.id));
    const oldRules = snapshotRules(old), newRules = snapshotRules(lines);
    const has = (rules: SnapshotRule[], rule: SnapshotRule) => rules.some(other => other.held === rule.held && other.text === rule.text);
    const removed = oldRules.filter(rule => !has(newRules, rule) && !inForce.has(ruleId(rule)));
    const added = newRules.filter(rule => !has(oldRules, rule));
    const kind = previous ? "update" : "snapshot";
    const oldMore = old.find(line => line.startsWith("and "));
    const newMore = lines.find(line => line.startsWith("and "));
    const text = kind === "snapshot" ? current! : ["[corrections] Update to the owner's rules. This update replaces earlier lines for the named ids.",
      ...removed.map(rule => `Remove ${ruleId(rule) || rule.text} from the active rules.`), ...ruleLines(added),
      ...(oldMore === newMore ? [] : [newMore ?? "No older rules are omitted."])].join("\n");
    const after = active.findLast(visible)?.id ?? (compact >= 0 ? branch[compact]!.id : null);
    const data: Checkpoint = { kind, lines, text, after };
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
