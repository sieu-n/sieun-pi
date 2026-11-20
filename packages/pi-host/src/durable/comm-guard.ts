/**
 * What a comm thread may post (`apps/chat/docs/agent-model.md`, the comm and work split): a result, an answer or a question, never a relay of
 * its own work. tell_owner runs this check in a comm thread before Prime's guard (`prime-chat.ts`), and a refusal comes back as the tool's
 * error, so the model reads why and ends the turn.
 *
 * 1. A post in the turn that handed the work thread a task (`CommHandedDoc`, written by `threads.ts` `sendRoot`) is refused, unless it asks a
 *    question or is a checklist with an open `- [ ]` item, and has no relay words. The agent's 👀 on the post shows it is on it, and the
 *    result comes once, from the work thread's report or the work-done notice, or as the last edit of that checklist. On 11-20 the owner
 *    asked for the checklist (#sw-factory-build p106): "checks를 먼저 얘기하고, `edit` 방식으로 체크리스트를 체크하거나 때론 수정하는 방식도
 *    추천해." On 11-03 vent's comm thread handed the panel list over and then posted "The vent thread is now listing every panel,
 *    ...", and the agent factory comm thread answered the owner's complaint about that line with "Got it, ..." and "The agent factory work
 *    thread is building all five now, ...", both after its hand-over in the same turn.
 * 2. A post with hand-over words (`relay-line.ts`) is refused on any turn.
 * 3. A post with progress words is refused unless the owner started the turn with a question (`asks`), which the progress may answer. On
 *    11-03 chrome extension answered the owner's "proxy가 아니라 근데 Client browser에서" with "... A job is testing whether that can be
 *    avoided.", a relay nobody asked for, and agent factory answered his "are you working on Meilisearch then?" with "Yes, the search job
 *    (p56) is timing Meilisearch ...", which answers him.
 * 4. A post with a markdown table is held once, unless the post that started the turn asks for a table (`asksTable`), and the very same
 *    text sent again goes out, the soft cap Prime's own tell_owner guard keeps for a long reply (chat-guard.ts `resent`, c98). A room reads
 *    like Slack, and a thread pane is about 400 px wide: on 11-20 Search product, misc. answered "what is our definitive catalog now?" in a
 *    #dev-search-general thread with a 4-column table the pane cut off on the right and at the bottom, and the owner asked "does this feel
 *    like slack to you?". A note on the sent post's result was tried first, and in the blind runs that day two of two fresh agents asked
 *    "what pieces make up the skill setup?" posted a table anyway, since the note came only after the post was out.
 */
import { relayWords } from "./relay-line.ts";

export interface CommPostTurn {
  /** Whether the owner's or a member's post started the turn, as Prime's guard reads it (`tellTurn`). */
  owner: boolean;
  /** Whether this comm thread handed its work thread a task after the turn's input arrived. */
  handed: boolean;
  /** Whether the post that started the turn asks something (`asks`). */
  asked: boolean;
  /** Whether the post that started the turn asks for a table (`asksTable`). */
  tableAsked?: boolean;
  /** Whether this very text was held for its table already in this turn, so sending it again sends it (`tableResent`). */
  tableResent?: boolean;
}

/**
 * A line that ends in a question: a "?" with at most a trailing @mention after it, or a Korean question ending the owner writes without one.
 * Of his 449 room posts by 11-03, 73 held a "?", and 52 of those end a line with it. The rest put the "?" mid-line before a task or a format
 * note, as in "이딴건 말하면 안되겠지? 계속 usage pattern 감시하고, ...", which handed agent factory five tasks and asked no status. None asked
 * with only a Korean ending, so that list stays to endings that read as a question and never as a statement.
 */
const QUESTION_LINE = /(?:[?？][\s)"”.~!ㅋㅎ]*(?:@.*)?|(?:어때|나요|까요?|니)[\s.~!ㅋㅎ]*)$/mu;

/** Whether the owner's post asks something, so progress may answer it. apps/chat's relay-posts precheck counts with it too. */
export const asks = (text: string): boolean => QUESTION_LINE.test(text);

/** A markdown table: a row of cells over its `|---|` divider line. */
const TABLE = /^[ \t]*\|?.*\|.*\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/m;

/** Whether a post holds a markdown table. */
export const hasTable = (text: string): boolean => TABLE.test(text);

/** Whether a post holds an open task item, `- [ ] ...`, as the checklist a comm thread posts when it hands over a multi-step ask. */
export const hasOpenTask = (text: string): boolean => /^[ \t]*[-*+] \[ \] \S/m.test(text);

/** Whether the owner's post asks for a table, in English or in the Korean he writes ("표로", "표 형식"). */
export const asksTable = (text: string): boolean => /\btables?\b|\btabular\b|표로|표를|표 ?형식|표 ?형태/iu.test(text);

/** Why a comm thread's post must not go out, or undefined when it may. */
export function commPostRefusal(text: string, turn: CommPostTurn): string | undefined {
  const relay = relayWords(text);
  if (turn.handed && (relay || !(text.includes("?") || hasOpenTask(text)))) {
    return "Not sent: you handed this to your work thread in this turn. Your 👀 on the post already shows that you are on it, so post nothing " +
      "about the hand-over and end the turn now. Post the result once, when the work thread's report or the [work-done ...] notice brings it. " +
      "Only a question the owner must answer before the work can go on, or the checklist of a multi-step ask with its `- [ ]` items, goes out now.";
  }
  if (relay?.kind === "handoff") {
    return `Not sent: "${relay.words}" announces a hand-over or a result to come. Your 👀 on the post already shows that the work runs, so post ` +
      "nothing until the result is in, then post the result once.";
  }
  if (relay && !(turn.owner && turn.asked)) {
    return `Not sent: "${relay.words}" is progress on work still going, and nobody asked for it on this turn. End the turn with no ` +
      "message, and post once when the result is in.";
  }
  if (hasTable(text) && !turn.tableAsked && !turn.tableResent) {
    return `${TABLE_MARK}, and a room reads like Slack: a table gets cut off in its narrow thread pane. Answer in one or two casual sentences, ` +
      "or in one line over short `- ` bullets when it holds several points, and put the detail on a wiki page with `wiki.write` in ipython, linked in the same post as `full list → [name](wiki:<path>)`. " +
      "If he must see this table as it is, send the very same text again and it goes out (c98).";
  }
  return undefined;
}

/** How a post held for its table opens. */
export const TABLE_MARK = "Not sent, it holds a table nobody asked for";

interface TurnCall { role: string; content?: unknown; toolCallId?: unknown }

/** Whether a speaking call with this very text was held for its table earlier in the turn; a blocked call's result wraps the mark in a harness line. */
export function tableResent(messages: readonly TurnCall[], text: string): boolean {
  const start = messages.findLastIndex(message => message.role === "user" || message.role === "custom");
  const held = new Set<string>();
  for (const message of messages.slice(start + 1)) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string" && Array.isArray(message.content)
      && (message.content as { type?: unknown; text?: unknown }[]).some(part => part.type === "text" && typeof part.text === "string" && part.text.includes(TABLE_MARK))) held.add(message.toolCallId);
  }
  return messages.slice(start + 1).some(message => message.role === "assistant" && Array.isArray(message.content)
    && (message.content as { type?: unknown; id?: unknown; arguments?: { text?: unknown } }[])
      .some(part => part.type === "toolCall" && typeof part.id === "string" && held.has(part.id) && part.arguments?.text === text));
}

interface TurnMessage { role: string; timestamp?: unknown; content?: unknown }

/** The current turn's input: the newest owner or agent message before the call. */
const turnInput = (messages: readonly TurnMessage[]): TurnMessage | undefined =>
  messages.findLast(message => message.role === "user" || message.role === "custom");

/** The time the current turn's input arrived, by its timestamp. */
export function turnStartedAt(messages: readonly TurnMessage[]): number | undefined {
  const timestamp = turnInput(messages)?.timestamp;
  return typeof timestamp === "number" ? timestamp : undefined;
}

/** The text of the current turn's input. */
function turnText(messages: readonly TurnMessage[]): string {
  const content = turnInput(messages)?.content;
  if (typeof content === "string") return content;
  const blocks = Array.isArray(content) ? (content as { type?: unknown; text?: unknown }[]) : [];
  return blocks.flatMap(block => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
}

/** Whether the current turn's input asks something (`asks`). */
export const turnAsked = (messages: readonly TurnMessage[]): boolean => asks(turnText(messages));

/** A room post's input without the earlier posts apps/chat adds under it (group-rooms.ts `envelope`), which may hold a table of their own. */
const ownPost = (text: string): string => text.split(/\n\((?:thread so far|channel before this post)\)\n/u)[0]!;

/** Whether the current turn's input asks for a table (`asksTable`), in its own post only. */
export const turnAskedTable = (messages: readonly TurnMessage[]): boolean => asksTable(ownPost(turnText(messages)));
