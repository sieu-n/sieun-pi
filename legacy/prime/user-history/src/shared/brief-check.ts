import { BOARD_PREFIX, GO_WAIT_FIX, goWait, goWaitText, type GoWait } from "./chat-board.ts";
import { BRIEF_CHECK_PREFIX } from "./chat-feed.ts";
import { INVENTED_GATE_FIX, inventedGates, type InventedGate } from "./invented-gates.ts";
import { LAYOUT_WORDS_FIX, ownerAskedForPage, screenOptionsOnPage } from "./layout-ask.ts";
import { STRAY_BRANCH_FIX, strayBranches } from "./machine-branches.ts";
import { ownerMessage } from "./reply-lint.ts";
import type { ThreadMessage } from "./types.ts";

/**
 * The brief check: whether a job brief a chat wrote, from its Split line on, sets a gate with no cause and no owner rule behind it
 * (`inventedGates`, c47) or has the job wait for another thread's go, word or slot, or for the owner's ok on a push or a staging land (`goWait`,
 * c47), names a branch other than the machine's one dev branch (`strayBranches`, c119), or has the job put a 5180 screen's options on a page
 * instead of building them as variants when the owner's words before the Split line asked for no page (`screenOptionsOnPage`, c124). The owner
 * repeated c47 on 10-12, c119 on 10-27 and c124 on 10-28. The chat server steers a `[brief check]` after a spawn whose brief fails.
 */

/** A message the owner typed in the chat: its text and its time (ms). */
export interface OwnerMessage { text: string; at: number }
export type BriefFinding =
  | { kind: "invented-gate"; gates: InventedGate[] }
  | { kind: "waits-for-leave"; wait: GoWait }
  | { kind: "stray-branch"; branches: string[] }
  | { kind: "screen-options-page"; words: string };

const MESSAGE_ID = /\[message id: [^\]]*\]/g;
/** Text as a quote check compares it: straight quotes, no message id notes, whitespace runs as one space. */
export const normal = (text: string): string =>
  text.replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"').replace(/[\u2018\u2019\u201b\u2032]/g, "'").replace(MESSAGE_ID, " ").replace(/\s+/g, " ").trim();
const SPLIT = /^[\s#>*_-]*Split\b[^:\n]{0,40}:/im;

/** What breaks c47 in a brief, from its Split line on (the owner's quoted words come before it), in brief order; empty when it follows it. */
export function briefCheck(brief: string): BriefFinding[] {
  const findings: BriefFinding[] = [];
  const split = SPLIT.exec(brief);
  const task = split ? brief.slice(split.index) : brief;
  const gates = inventedGates(task);
  if (gates.length) findings.push({ kind: "invented-gate", gates });
  const wait = goWait(task);
  if (wait) findings.push({ kind: "waits-for-leave", wait });
  const branches = strayBranches(task);
  if (branches.length) findings.push({ kind: "stray-branch", branches });
  const owner = split ? brief.slice(0, split.index).split(/^[\s#>*_-]*My read\b/im)[0]! : "";
  const page = ownerAskedForPage(owner) ? null : screenOptionsOnPage(task);
  if (page) findings.push({ kind: "screen-options-page", words: page });
  return findings;
}

/** One finding as the plain line the `[brief check]` lists: what is wrong, then the fix. */
export function briefFindingLine(finding: BriefFinding): string {
  switch (finding.kind) {
    case "invented-gate": return `- It sets a gate nobody asked for: ${finding.gates.map(gate => `"${gate.phrase}"`).join(", ")}. ${INVENTED_GATE_FIX}`;
    case "waits-for-leave": return `- It has the job wait: it ${goWaitText(finding.wait)}. ${GO_WAIT_FIX} Tell the job to take that action itself.`;
    case "stray-branch": return `- It names a branch other than the machine's: ${finding.branches.map(branch => `"${branch}"`).join(", ")}. ${STRAY_BRANCH_FIX}`;
    case "screen-options-page": return `- It has the job put a screen's ${finding.words} on a page, and the owner asked for no page. ${LAYOUT_WORDS_FIX}. ` +
      "A page that answers his question stays, without the options (c124).";
  }
}

/** The steer for a job whose brief failed the check, naming the job by its exact name. */
export function briefCheckNote(job: string, findings: readonly BriefFinding[]): string {
  const kinds = new Set(findings.map(finding => finding.kind));
  const what = [
    ...kinds.has("invented-gate") || kinds.has("waits-for-leave") ? ["has the job wait or sets a gate (c47)"] : [],
    ...kinds.has("stray-branch") ? ["names a branch the owner retired (c119)"] : [],
    ...kinds.has("screen-options-page") ? ["has the job describe screen options on a page instead of building them (c124)"] : [],
  ].join(" and ");
  const send = `\`await agent_message.send(text, receiver_role="child", receiver_name="${job}")\``;
  const fix = kinds.has("invented-gate") || kinds.has("waits-for-leave") ? `Fix it in the job, not with a new job: ${send} with the action it takes without waiting.`
    : kinds.has("stray-branch") ? `Fix it in the job, not with a new job: ${send} with the machine's branch to work on.`
    : `Tell the job with ${send} to leave the options off its page, and start one builder per option.`;
  return `${BRIEF_CHECK_PREFIX}Your brief for [${job}](job:${job}) ${what}:\n${findings.map(briefFindingLine).join("\n")}\n${fix}`;
}

/** What the owner wrote in a chat, oldest first: his messages and his board actions ("[board] Owner checked ... and answered: ..."), no server notes. */
export function ownerSaid(messages: readonly ThreadMessage[]): OwnerMessage[] {
  return messages.flatMap(message => {
    const text = ownerMessage(message);
    return text === undefined ? [] : [{ text, at: message.timestamp }];
  });
}

/** The messages the owner typed in a chat, oldest first: no server notes and no board actions. */
export const ownerMessages = (messages: readonly ThreadMessage[]): OwnerMessage[] => ownerSaid(messages).filter(message => !message.text.startsWith(BOARD_PREFIX));

const BOARD_ANSWER = " and answered: ";
/**
 * The words the owner wrote in a chat, oldest first: his messages, and each answer he typed on a board todo, the part after "and answered: " of
 * "[board] Owner checked "<todo>" and answered: <words>". On 10-12 he answered "i said NEVER EVER SEND WITHOUT MY PERMISSION" on a VP of CI todo.
 */
export function ownerTexts(messages: readonly ThreadMessage[]): string[] {
  return messages.flatMap(message => {
    const text = ownerMessage(message);
    if (text === undefined) return [];
    if (!text.startsWith(BOARD_PREFIX)) return [text];
    const at = text.indexOf(BOARD_ANSWER);
    return at < 0 ? [] : [text.slice(at + BOARD_ANSWER.length).trim()];
  });
}
