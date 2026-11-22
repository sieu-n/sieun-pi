/**
 * What a comm thread may post (`apps/chat/docs/agent-model.md`, the comm and work split): a result, an answer or a question, never a relay of
 * its own work. tell_owner runs this check in a comm thread before Prime's guard (`prime-chat.ts`), and a refusal comes back as the tool's
 * error, so the model reads why and ends the turn.
 *
 * 1. A post with relay words in the turn that handed the work thread a task (`CommHandedDoc`, written by `threads.ts` `sendRoot`) is refused.
 *    The agent's 👀 on the post shows it is on it, and the result comes once, from the work thread's report or the work-done notice. On
 *    11-03 vent's comm thread handed the panel list over and then posted "The vent thread is now listing every panel, ...", and the agent
 *    factory comm thread answered the owner's complaint about that line with "Got it, ..." and "The agent factory work thread is building
 *    all five now, ...", both after its hand-over in the same turn. Until 11-21 the rule also refused any such post with no question and
 *    no open `- [ ]` item, which pushed agents to post a checklist of their own steps, and the owner called one (#sw-factory-build p158)
 *    "slop slop slop" (p159, c234). Now a plain line on what he will get goes out.
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
 * 5. A post with a line outside its list items that crams several results, 3 or more sentences or 3 or more clauses that each carry a
 *    number (`crammedLine`), is held once the same way, and the very same text sent again goes out. On 11-20 Search product, misc. answered
 *    the owner's cost ask in #dev-app-search-prospect with p13, "breathing costs about $1,850-2,210 a month on GeoNode's 200 Mbps plan, ...
 *    one tracked brand adds under 2 cents a month. the demo load alone would fit a $148.50 metered GeoNode plan, ...", three results in three
 *    sentences on one line, and he wrote "slop slop slop" under it on 11-21 (p33). Its role text then still said "no bullet reports".
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
  /** Whether this very text was held for a crammed line already in this turn, so sending it again sends it (`crammedResent`). */
  crammedResent?: boolean;
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

/**
 * Whether the owner's post asks for a table, in English or in the Korean he writes ("표로", "표 형식"), or asks how a setup, a skill or a
 * catalog is set up, which c225 answers with one table of each piece, where it lives, who loads it and what it says (his words, 11-20:
 * "씨발 이럴떄 스킬이 어떻게 됐는지 설명하라니까? what is our definitive catalog now after this update?").
 */
export const asksTable = (text: string): boolean =>
  /\btables?\b|\btabular\b|표로|표를|표 ?형식|표 ?형태|\bset ?up\b|\bsetup\b|\bconfigur|\bcatalog|설정|세팅|셋업/iu.test(text);

/** Why a comm thread's post must not go out, or undefined when it may. */
export function commPostRefusal(text: string, turn: CommPostTurn): string | undefined {
  const relay = relayWords(text);
  if (turn.handed && relay) {
    return `Not sent: "${relay.words}" reports the hand-over you made in this turn, and your 👀 on the post already shows that you are on it. ` +
      "Post what you already know or one plain line on what he will get, and the result once the work thread's report or the [work-done ...] notice brings it.";
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
  const crammed = crammedLine(text);
  if (crammed && !turn.crammedResent) {
    return `${CRAMMED_MARK}: "${crammed.length > 120 ? `${crammed.slice(0, 117)}...` : crammed}" holds several results in a row, and a room reads like Slack. ` +
      "Open with the answer in one short sentence, then give each result its own `- ` bullet of one short line, and put the rest on a wiki page " +
      "linked in the same post. An answer with one point stays one or two short sentences. If it must go as it is, send the very same text again " +
      "and it goes out (c98).";
  }
  return undefined;
}

/** How a post held for its table opens. */
export const TABLE_MARK = "Not sent, it holds a table nobody asked for";
/** How a post held for a crammed line opens. */
export const CRAMMED_MARK = "Not sent, one line crams several results";

/** A list item, a quote, a table row or a heading, which `crammedLine` leaves alone. */
const NOT_PROSE = /^[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+|>|\||#)/;

/**
 * A line with its links, code, ids, dates, times, ports and versions taken out, so a number in a URL, a path, a post id such as p12, a sha,
 * 11-20, 05:28, :5184 or v0.2.25 does not count, and "175 of 178" or 7/7 reads as one figure.
 */
const plainLine = (line: string): string => line
  .replace(/`[^`]*`/g, " ").replace(/!\[[^\]]*\]/g, " ").replace(/\]\([^)]*\)/g, "]").replace(/\b(?:https?|wiki|job|thread):\S+/g, " ")
  .replace(/\b(?:[a-z]{1,3}_[0-9a-f]+\/)?[ptdc]\d+\b/g, " ").replace(/\b(?=[0-9a-z]*\d)(?=[0-9a-z]*[a-z])[0-9a-z]{7,40}\b/g, " ")
  .replace(/\bv\d+(?:\.\d+)+\b/g, " ").replace(/\b\d{4}-\d\d-\d\d\b|\b\d\d?:\d\d\b|\b\d\d?-\d\d\b/g, " ").replace(/:\d{2,5}\b/g, " ")
  .replace(/\b(\d+)\s*\/\s*\d+\b/g, "$1").replace(/\d[\d,.]*\s+of\s+(?=\d)/g, "");

const NUMBER = /\$?\d[\d,.]*/;

/**
 * The first line outside the post's list items, quotes and code that crams several results: 3 or more sentences, or 3 or more clauses (split
 * at sentence ends, semicolons, commas, dashes and arrows) that each carry a number. Undefined when no line does.
 * On 11-21 this held 97 of the 1,177 tell_owner posts in the 217 comm threads on us-metal02 (8.2%), and 30 of the 310 sent since the role
 * text asked for bullets on 11-20 (9.7%): 84 for their sentences and 13 more for their numbers. Read one by one, most were results or
 * explanations the room rules put in bullets, such as "memory runs on its own now: today's check has 8 of 8 agents holding what they should,
 * 0 scratch notes, and fresh copies answered 21 of 21 questions"; the few one-point answers among them go out when sent again. p12 of the
 * same thread, "yes, 175 of 178 routes work, and 11 of 11 real customer calls just returned data. ...", has two numbered clauses and passes.
 */
export function crammedLine(text: string): string | undefined {
  return text.replace(/```[\s\S]*?```/g, "").split("\n").find(line => {
    if (!line.trim() || NOT_PROSE.test(line)) return false;
    const plain = plainLine(line);
    const sentences = plain.split(/(?<=[.!?])\s+(?=\S)/).filter(part => /\w/.test(part)).length;
    const numbered = plain.split(/(?<=[.!?;])\s+|,\s+|\s+→\s+|\s[-–]\s/).filter(part => NUMBER.test(part)).length;
    return sentences >= 3 || numbered >= 3;
  })?.trim();
}

/** How an edit held for a crammed line opens. */
export const CRAMMED_EDIT_MARK = "Not edited, one line crams several results";

/**
 * The note for an edit_message text with a crammed line (`crammedLine`), or undefined when it has none or this very text was held once
 * already, so the same text sent again goes out (c98). A checklist's last edit carries the answer, so it gets the same hold as a post: on
 * 11-21 the first blind-threads.mjs run's last edit opened with "The Elixir app has 37 source files, 9,845 lines and 16 test files; its 234
 * tests take about 35 s.", four results on the top line above bullets that gave them again.
 */
export function crammedEdit(edit: string, held: Set<string>): string | undefined {
  if (held.has(edit)) return undefined;
  const crammed = crammedLine(edit);
  if (!crammed) return undefined;
  held.add(edit);
  return `${CRAMMED_EDIT_MARK}: "${crammed.length > 120 ? `${crammed.slice(0, 117)}...` : crammed}" holds several results in a row. ` +
    "Keep the answer on top as one short sentence and give each result its own short item. Sending the very same text again edits it as it is (c98).";
}

interface TurnCall { role: string; content?: unknown; toolCallId?: unknown }

/** Whether a speaking call with this very text was held for its table earlier in the turn. */
export const tableResent = (messages: readonly TurnCall[], text: string): boolean => heldResent(messages, text, TABLE_MARK);

/** Whether a speaking call with this very text was held for a crammed line earlier in the turn. */
export const crammedResent = (messages: readonly TurnCall[], text: string): boolean => heldResent(messages, text, CRAMMED_MARK);

/** Whether a speaking call with this very text was held with this mark earlier in the turn; a blocked call's result wraps the mark in a harness line. */
function heldResent(messages: readonly TurnCall[], text: string, mark: string): boolean {
  const start = messages.findLastIndex(message => message.role === "user" || message.role === "custom");
  const held = new Set<string>();
  for (const message of messages.slice(start + 1)) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string" && Array.isArray(message.content)
      && (message.content as { type?: unknown; text?: unknown }[]).some(part => part.type === "text" && typeof part.text === "string" && part.text.includes(mark))) held.add(message.toolCallId);
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
