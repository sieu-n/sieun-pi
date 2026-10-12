import { BOARD_PREFIX } from "./chat-board.ts";
import { BRIEF_CHECK_PREFIX, OWNER_RETRY_MARK, serverNote, turnAt } from "./chat-feed.ts";
import { ownerMessage } from "./reply-lint.ts";
import { messageText } from "./turns.ts";
import type { ThreadMessage } from "./types.ts";

/**
 * The brief check: whether a job brief a chat wrote follows the Jobs rule of the chat brief (CHAT_BRIEF in src/chats.ts). It opens with the
 * owner messages that started the job, quoted exactly, or `Owner's words: none, started by <who>`, and it carries a `Split:` line. The job
 * brief audit (10-12) found 34 of 88 briefs reusing an old goal quote, 5 calling ledger text the owner's words, and only 25% of jobs whose
 * brief did not mention subagents spawning one. The chat server steers a `[brief check]` after a spawn whose brief fails.
 */

/** A message the owner typed in the chat: its text and its time (ms). */
export interface OwnerMessage { text: string; at: number }
export type BriefFinding =
  | { kind: "no-owner-block" }
  | { kind: "not-verbatim"; piece: string }
  | { kind: "old-message"; quoted: OwnerMessage }
  | { kind: "none-but-owner-turn"; owner: OwnerMessage }
  | { kind: "no-split" };
/**
 * `turnOwner` is the owner message that started the turn the chat spawned the job on, null when a check-in, a job notice, another agent or a
 * board action started it. `previousSpawnAt` is when the chat last spawned a job before this one, null for its first.
 */
export interface BriefInput { brief: string; owner: readonly OwnerMessage[]; turnOwner: OwnerMessage | null; previousSpawnAt: number | null }

const MESSAGE_ID = /\[message id: [^\]]*\]/g;
/** Text as the check compares it: straight quotes, no message id notes, whitespace runs as one space. */
const normal = (text: string): string =>
  text.replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"').replace(/[\u2018\u2019\u201b\u2032]/g, "'").replace(MESSAGE_ID, " ").replace(/\s+/g, " ").trim();
const HEADER = /^[\s#>*_]*Owner's words\b[^:\n]*:(.*)$/im;
const BLOCK_END = /^[\s#>*_]*(?:My read|Split)\b/im;
const ENTRY = /^\s*\d+[.)]\s/m;
const SPLIT = /^[\s#>*_-]*Split\b[^:\n]{0,40}:/im;
/** A cut piece this short ("a", "and") proves nothing about verbatim quoting. */
const MIN_PIECE = 4;

/**
 * The quoted owner messages of a brief's `Owner's words` block, each as its pieces (the quote split at "..."), or "none" when the block says
 * no owner message started the job; null when the brief has no block or the block quotes nothing. Each numbered line is one message, quoted
 * from its first to its last double quote, so a note after the quote is left out.
 */
export function quotedOwnerWords(brief: string): string[][] | "none" | null {
  const text = brief.replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"').replace(/[\u2018\u2019\u201b\u2032]/g, "'");
  const header = HEADER.exec(text);
  if (!header) return null;
  if (/^\s*none\b/i.test(header[1]!)) return "none";
  const rest = text.slice(header.index + header[0].length - header[1]!.length);
  const end = BLOCK_END.exec(rest);
  const block = end ? rest.slice(0, end.index) : rest;
  const entries = ENTRY.test(block) ? block.split(new RegExp(ENTRY.source, "m")) : [block];
  const quotes = entries.flatMap(entry => {
    const first = entry.indexOf('"'), last = entry.lastIndexOf('"');
    if (last <= first) return [];
    const pieces = entry.slice(first + 1, last).split(/\.\.\.|\u2026/).map(normal).filter(piece => piece.length >= MIN_PIECE);
    return pieces.length ? [pieces] : [];
  });
  return quotes.length ? quotes : null;
}

const opening = (text: string): string => { const words = normal(text).split(" "); return words.slice(0, 8).join(" ") + (words.length > 8 ? "\u2026" : ""); };

/** What breaks the Jobs rule in a brief, in brief order; empty when it follows it. */
export function briefCheck(input: BriefInput): BriefFinding[] {
  const findings: BriefFinding[] = [];
  const quotes = quotedOwnerWords(input.brief);
  const owner = input.owner.map(message => ({ message, text: normal(message.text) }));
  if (quotes === null) findings.push({ kind: "no-owner-block" });
  else if (quotes === "none") { if (input.turnOwner) findings.push({ kind: "none-but-owner-turn", owner: input.turnOwner }); }
  else {
    const matched: OwnerMessage[] = [];
    for (const pieces of quotes) {
      for (const piece of pieces) if (!owner.some(entry => entry.text.includes(piece))) findings.push({ kind: "not-verbatim", piece });
      const source = owner.findLast(entry => pieces.every(piece => entry.text.includes(piece)));
      if (source) matched.push(source.message);
    }
    const { previousSpawnAt, turnOwner } = input;
    const newest = matched.reduce<OwnerMessage | undefined>((best, message) => !best || message.at > best.at ? message : best, undefined);
    if (newest && turnOwner === null && previousSpawnAt !== null && newest.at < previousSpawnAt)
      findings.push({ kind: "old-message", quoted: newest });
  }
  if (!SPLIT.test(input.brief)) findings.push({ kind: "no-split" });
  return findings;
}

/** One finding as the plain line the `[brief check]` lists: what is wrong, then the fix. */
export function briefFindingLine(finding: BriefFinding): string {
  switch (finding.kind) {
    case "no-owner-block": return "- No `Owner's words (verbatim):` block with a quote. Send the job the owner messages that started it, word for word, or say none started it and who did.";
    case "not-verbatim": return `- "${finding.piece}" is not in any owner message. Send the job the owner's exact words; cut only with "...".`;
    case "old-message": return `- The newest owner message you quoted ("${opening(finding.quoted.text)}") is older than your previous job, and no owner message started this turn. Quote the message that started this job, or say none did and who did.`;
    case "none-but-owner-turn": return `- It says no owner message started the job, but the owner's message "${opening(finding.owner.text)}" started this turn. Send the job that message word for word.`;
    case "no-split": return "- No `Split:` line. Send the job which subagents it spawns, one per unit of output, or why it stays inline (1 to 3 tool calls).";
  }
}

/** The steer for a job whose brief failed the check, naming the job by its exact name. */
export function briefCheckNote(job: string, findings: readonly BriefFinding[]): string {
  return `${BRIEF_CHECK_PREFIX}Your brief for [${job}](job:${job}) breaks the Jobs rule:\n${findings.map(briefFindingLine).join("\n")}\n` +
    `Fix it in the job, not with a new job: \`await agent_message.send(text, receiver_role="child", receiver_name="${job}")\` with the owner's exact ` +
    "words or the Split line. Write your next brief by the Jobs rule.";
}

/** The messages the owner typed in a chat, oldest first: no server notes and no board actions. */
export function ownerMessages(messages: readonly ThreadMessage[]): OwnerMessage[] {
  return messages.flatMap(message => {
    const text = ownerMessage(message);
    return text === undefined || text.startsWith(BOARD_PREFIX) ? [] : [{ text, at: message.timestamp }];
  });
}

/**
 * The owner message that started the turn the chat was on at `at`, null when something else started it. A server restart of a failed owner
 * turn (`OWNER_RETRY_MARK`) keeps the turn the owner's: the message is the owner's last one before it.
 */
export function turnOwnerAt(messages: readonly ThreadMessage[], at: number): OwnerMessage | null {
  const start = turnAt(messages, at);
  if (start?.starter !== "owner" || start.message.role !== "user") return null;
  const text = messageText(start.message).trim();
  if (text.startsWith(BOARD_PREFIX) || (serverNote(text) && !text.includes(OWNER_RETRY_MARK))) return null;
  return ownerMessages(messages).findLast(message => message.at <= start.message.timestamp) ?? null;
}
