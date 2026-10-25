import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { WIKI_CONTENT_HOME, wikiLinkPath } from "./shared/artifact-link.ts";
import { chatLines, CHECK_IN_PREFIX, messageIdNote, ownerMessageId, serverNote, TELL_OWNER_HELD, TELL_OWNER_TOOL, TELL_WHY, type TellWhy, turnStarter } from "./shared/chat-feed.ts";
import { messageText } from "./shared/turns.ts";
import type { PlanItem, ThreadMessage } from "./shared/types.ts";
import { targetMet } from "./shared/chat-board.ts";
import { ALLOWED_SHELL, SHELL_LIST } from "./chat-brief.ts";
import { fileLines } from "./file-lines.ts";
import { LONG_REPLY_MARK, longReply, SHOP_TALK_MARK, shopTalk } from "./shared/reply-lint.ts";
import { type ServiceArchive, serviceArchiveLines } from "./service-archives.ts";

/** What makes a session a chat and what a chat may run: the chat_mode marker, its tools, the tell_owner tool, the owner message ids, and the shell guard. */

/** The extension flag the chat server sets on `create`. The extension turns it into the session entry at the first session_start. */
export const CHAT_FLAG = "chat";
/**
 * The extension flag the chat server sets on a thread the owner starts with his first message: such a thread is no job, so the extension skips
 * the job registry lookups, which on the Mac read the box's 125 KB registry twice over a new TLS link, about 1.4 s of each Mac create on 10-20.
 */
export const OWNER_THREAD_FLAG = "owner-thread";
/** The session entry that defines "this session is a chat". Children get their own session files, so it never reaches them. */
export const CHAT_MODE_ENTRY = "chat_mode";
/** The board tool. Its promptGuidelines carry the brief, so it is active only in a marked root. */
export const CHAT_BOARD_TOOL = "chat_board";
/** The only way the chat reaches the owner on a turn the owner did not start; active with the board tool. The feed reads its calls from the transcript. */
export const CHAT_TOOLS: readonly string[] = [CHAT_BOARD_TOOL, TELL_OWNER_TOOL];
export const TELL_OWNER_DONE = "told the owner";

/** A chat with no name from the owner gets one, so a create_session root can reply to it by name. */
export function chatName(): string { return `chat-${randomBytes(2).toString("hex")}`; }

export function hasChatMarker(entries: ReadonlyArray<{ type: string; customType?: string }>): boolean {
  return entries.some(entry => entry.type === "custom" && entry.customType === CHAT_MODE_ENTRY);
}

/**
 * Whether a session file carries the chat_mode entry. The entry is written at the first session_start, before the first message, so the scan
 * stops at the first message entry and reads only the head of a long session.
 */
export async function fileHasChatMarker(sessionFile: string): Promise<boolean> {
  const lines = fileLines(sessionFile);
  try {
    for await (const line of lines) {
      if (line.startsWith('{"type":"message"')) return false;
      if (!line.includes(`"customType":"${CHAT_MODE_ENTRY}"`)) continue;
      try { if (hasChatMarker([JSON.parse(line)])) return true; } catch { continue; }
    }
    return false;
  } catch { return false; }
}

/**
 * The archive reasons Prime writes for the owner's stop or archive; idle_unload and a forced shutdown are the daemon's own. Prime writes the same
 * two for the chat service's own archives, so the exact line a service archive operation wrote is no owner stop (service-archives.ts).
 */
const OWNER_STOPS: ReadonlySet<string> = new Set(["owner_stop", "owner_archive"]);

/**
 * The owner's stop or archive that a session file records after its last active state, as "<reason> at <time>", or null. On 10-20 06:25:25Z a
 * clean-room setup archived stray chat 01a157fb (owner_stop), and the scan re-adopted and resumed it at 06:25:28Z from its chat_mode entry.
 * `service` holds the service's own archive operations on the session (service-archives.json). Only the line each confirmed one wrote, matched
 * by its entry id, is skipped, and it neither sets nor clears an owner stop around it.
 */
export async function ownerStopSinceActive(sessionFile: string, service: readonly ServiceArchive[] = []): Promise<string | null> {
  const serviceLines = serviceArchiveLines(service);
  let stop: string | null = null;
  try {
    for await (const line of fileLines(sessionFile)) {
      if (!line.includes('"type":"session_state"')) continue;
      let entry: { type?: unknown; id?: unknown; timestamp?: unknown; state?: { status?: unknown; reason?: unknown } };
      try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
      if (entry.type !== "session_state") continue;
      if (entry.state?.status === "active") stop = null;
      else if (entry.state?.status === "archived" && typeof entry.state.reason === "string" && OWNER_STOPS.has(entry.state.reason)
        && !(typeof entry.id === "string" && serviceLines.has(entry.id))) stop = `${entry.state.reason} at ${String(entry.timestamp)}`;
    }
  } catch { return null; }
  return stop;
}

/** What the extension does at session_start: write the marker (flagged root, not marked yet) and whether the brief tool is active. */
export function chatModeAt(input: { depth: number; flagged: boolean; marked: boolean }): { mark: boolean; active: boolean } {
  if (input.depth !== 0) return { mark: false, active: false };
  const mark = input.flagged && !input.marked;
  return { mark, active: input.marked || mark };
}

/** The active tool list with the chat tools (board, tell_owner) added or removed; null when it is already right. Extension tools start active in every session. */
export function withChatTool(active: readonly string[], on: boolean): string[] | null {
  const missing = CHAT_TOOLS.filter(name => !active.includes(name));
  if (on) return missing.length ? [...active, ...missing] : null;
  return missing.length === CHAT_TOOLS.length ? null : active.filter(name => !CHAT_TOOLS.includes(name));
}

type ContextMessage = { role: string; content?: unknown; timestamp?: unknown };
/**
 * The model's view of a chat with each owner message's id (`messageIdNote`) after it, so the chat can pass it to tell_owner as `reply_to`;
 * undefined when no owner message has a timestamp. Every note depends only on its own message, so the cached prefix holds.
 */
export function withMessageIds<M extends ContextMessage>(messages: readonly M[]): M[] | undefined {
  let changed = false;
  const view = messages.map(message => {
    const content = message.content;
    if (message.role !== "user" || typeof message.timestamp !== "number" || !(typeof content === "string" || Array.isArray(content))) return message;
    const text = messageText({ content: content as string | { type: string; text?: string }[] }).trim();
    if (!text || serverNote(text)) return message;
    changed = true;
    const id = { type: "text", text: messageIdNote(message.timestamp) };
    return { ...message, content: typeof content === "string" ? [{ type: "text", text: content }, id] : [...content, id] };
  });
  return changed ? view : undefined;
}

/**
 * The line after each wake-up in a chat's model view (an agent message, a child's exit, a server note other than a turn restart), so every wake
 * path says the default at the point the chat reads it (c117). It depends only on its own message, so the cached prefix holds.
 */
export const WAKE_NOTE = "[not from the owner: send no tell_owner for it unless it finishes a goal he asked for, needs a decision or a blocker only he can clear, or answers his question, " +
  "and then set why and about. News he already got, a fix of your own earlier message, and progress on work still going are none of those]";
/**
 * The server's restart of a failed turn. It belongs to the turn that failed: after an aborted owner turn the note carries no OWNER_RETRY_MARK,
 * and the answer it brings is still his (10-19 measurement: 2 of 4 labelled restart messages were needed answers).
 */
const revival = (text: string): boolean => text.startsWith(`${CHECK_IN_PREFIX}Your last turn failed at `);
const WAKE_TYPES = new Set(["agent_message", "rlm_child_terminal_notice", "rlm_child_failure", "heartbeat_prompt"]);

/** The model's view of a chat with `WAKE_NOTE` after each wake-up; undefined when it has none. */
export function withWakeNotes<M extends ContextMessage & { customType?: unknown }>(messages: readonly M[]): M[] | undefined {
  let changed = false;
  const view = messages.map(message => {
    const content = message.content;
    if (!(typeof content === "string" || Array.isArray(content))) return message;
    const text = messageText({ content: content as string | { type: string; text?: string }[] }).trim();
    const wake = message.role === "custom" ? typeof message.customType === "string" && WAKE_TYPES.has(message.customType)
      : message.role === "user" && serverNote(text) !== undefined && !revival(text);
    if (!wake) return message;
    changed = true;
    const note = { type: "text", text: WAKE_NOTE };
    return { ...message, content: typeof content === "string" ? [{ type: "text", text: content }, note] : [...content, note] };
  });
  return changed ? view : undefined;
}

/** The tell_owner tool's description and parameters, which the extension registers in a chat. */
export const TELL_OWNER_DESCRIPTION = "Send the owner one chat message, its own bubble, like a VP's Slack DM to his CTO. On a turn he started, " +
  "answer him. On a turn he did not start (a job report, another thread, a check-in, a [job] notice, a wake, a duty run, an alert, a " +
  "restart), the default is no call: update the board and end the turn. Call it there only for a goal he asked for that finished, with " +
  "its result (why done), a decision only he can make (decision), a blocker only he can clear (blocker), or the answer to a question he " +
  "asked (answer), and name that goal, decision, blocker or question in about. A finished goal he asked for, or a plan change he would " +
  "act on (a new land order, a move of his sessions or boxes), is done or decision, never update. News he already got, a fix of your own " +
  "earlier message and progress on work still going are update, even when the work is a goal or a decision of his. So is a result he " +
  "never asked for, like a speed-up or cleanup your own job found, even when its step is done. A blocker is one only " +
  "he can clear, and the message says what he must do; an incident or delay a job or another chat already fixes, and its later status, " +
  "is update. A question is its own call, with only the words he needs to answer it. Each decision or todo he must act on is its own point and its own call, even a small one, so three todos are three messages, never one. Any other call there, " +
  "and one with no why, is kept as a note (c117). Write one " +
  "point, best as one dry, plain sentence and at most 2, each of at most 25 words with one fact or ask, with no lead-in sentence like " +
  "\"One thing needs you.\", no bullets and no bold (c18). Put no colon in its sentences, because \"Not quite:\", \"Quick read:\" " +
  "or \"Here's the diagram:\" before the point reads as a label, so use a comma or a period. " +
  "Use the plain words he would use himself, saying what he would see or can do now, never a job report's terms, a UI label or state, a " +
  "clipped verb or git talk like land or roll out, and give a time in KST, like 23:50 KST or 밤 11시 50분, never UTC or a Z (c18, c135, c138). " +
  "Write \"onboarding works now, but the campaign it makes comes out empty because the AI guessed too small a follower range\", not \"Home " +
  "shows 0 matched after landing because the drafted 2K to 20K follower filter misses most creators\". Name each plan step, goal, todo and duty " +
  "you mention by its id, like p684 or d9, written bare, which shows as a chip he can click; keep hashes, session ids and paths out (c145). Count its sentences and " +
  "words before you send it, and cut what is over. Aim each sentence at about 15 words, so it stays under 25. Each sentence holds one fact or one ask, so never join two facts with \"and\", as in \"They are about 70% of its work, and its queue keeps growing.\" A second fact that is not the point of the message stays on the board, never in another sentence or call. Call it again for a second point. The rest of an answer is detail, which stays on the " +
  "board or a wiki page, never in more sentences or calls; a status answer gives only the one thing that matters most and the ids of " +
  "the steps that hold the rest. Name a step for the rest only when its title or note already holds that detail. An explanation or diagram goes on a " +
  "wiki page, sent as one message with the one-line takeaway and its wiki: link, which shows as a page card. In your first reply to a new " +
  "request, answer his question first with what you know, then name the job you started in its own call.";
export const TELL_OWNER_PARAMETERS = {
  type: "object",
  properties: {
    text: { type: "string" },
    why: { type: "string", enum: [...TELL_WHY], description: "answer, done, decision or blocker as above (blocker only when he must act, and the text says how); update for anything else, which " +
      "reaches him only on a turn he started. Give it on every turn he did not start." },
    about: { type: "string", description: "The goal, decision, blocker or question the message is about, in a few words; needed with why " +
      "on a turn he did not start." },
    reply_to: { type: "string", description: "Leave it out when you answer the owner's latest message. Set it only on a wake-up (a job " +
      "report or a check-in), on the one message that brings the result an owner message asked for when newer messages came after it: its [message id]." },
  },
  required: ["text"],
};

/** The cases that reach the owner on a turn he did not start: every `TELL_WHY` but "update". */
const TELL_CASES: readonly TellWhy[] = TELL_WHY.filter(why => why !== "update");
export interface TellInput { text?: unknown; why?: unknown; about?: unknown; reply_to?: unknown }
/**
 * What the check reads of the chat: whether the owner started the running turn or his newest message has no answer yet (the message being
 * sent is left out), and the ids of his messages a `reply_to` may name.
 */
export interface TellTurn { owner: boolean; ownerIds: ReadonlySet<string>; byOwner?: boolean; tells?: number; ownerText?: string; resent?: ReadonlySet<string>; done?: readonly string[]; startedAt?: number; asked?: ReadonlySet<string>; looked?: boolean;
  others?: readonly OtherAsk[]; lastSent?: SentTell; dropped?: readonly DroppedTodo[]; plan?: readonly PlanItem[] }
/**
 * A For you todo the chat added, then removed or checked itself with no answer from the owner: an ask it took back. `swappedFor` holds the
 * todos the same call added. A call in the running step has no result yet, so `swappedAfter` holds the highest todo number the chat had
 * seen, and each todo that call adds gets a higher one.
 */
export interface DroppedTodo { id: string; text: string; choices?: readonly string[]; at: number; swappedFor?: readonly string[]; swappedAfter?: number }
/** The last tell_owner the running turn sent: when its step ran and its why. */
export interface SentTell { at: number; why?: string }
/** An open For you todo that another of the owner's chats added: a question already waiting for him. */
export interface OtherAsk { chat: string; id: string; text: string; at: string }
/** The open owner todos on the chat's board that it added before the running turn started: a decision already waiting for him. */
export function askedTodos(todos: readonly { id: string; done?: boolean; at?: string; from?: string }[], startedAt: number | undefined): Set<string> {
  return new Set(startedAt === undefined ? [] : todos.filter(todo => !todo.done && todo.from !== "owner" && todo.at !== undefined && Date.parse(todo.at) < startedAt).map(todo => todo.id));
}
/** The words of an `about` that tell two of them apart: lowercased, three letters or more. */
const aboutWords = (about: string): Set<string> => new Set(about.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 3));
/** The earlier `done` about this one repeats: every word of the shorter one is in the other, with at least two words. */
const repeatOf = (about: string, done: readonly string[]): string | undefined => {
  const words = aboutWords(about);
  return done.find(earlier => {
    const before = aboutWords(earlier);
    const [small, large] = words.size <= before.size ? [words, before] : [before, words];
    return small.size >= 2 && [...small].every(word => large.has(word));
  });
};
/**
 * Words too common to tell two incidents apart, left out of `incidentWords`. On 10-21 the prod crawler restart reached the owner three times in
 * 7 min: Crawler VP put it on For you as t56 at 06:01:53Z, and launch main bro (06:02:09Z) and metal-management (06:08:09Z) asked him again.
 */
const COMMON_WORDS = new Set(("the and for with that this from have has had are was were been but not you your our its his him she they them their there here " +
  "what when where which who why how can may will would should could does did into over under about after before since until than then also just " +
  "only now still again more most some any all each every one two three out off yet very much many other same such own too get got let").split(" "));
const incidentWords = (text: string): Set<string> => new Set([...aboutWords(text)].filter(word => !COMMON_WORDS.has(word)));
/**
 * The other chat's open todo an ask repeats: added in the last ASK_WINDOW_MS and sharing SAME_ASK_WORDS incident words with the text and about.
 * A replay of this check over the 10-13 to 10-21 transcripts of the owner's 16 chats (1,133 calls sent on turns he did not start, 58 of them
 * decision or blocker, 331 todos) refuses the two restart asks of 10-21, each sharing 7 words with t56, and no other call, for any window from
 * 1 h to 48 h. At 5 words the 24 h window also refuses a needed line (slack green guy's Chrome add-on sign-in ask of 10-20 03:36Z), and with
 * no window 6 words refuses 2 more. The window is d11's 24 h. Evidence: ~/work/same-incident-ask/replay.md.
 */
const ASK_WINDOW_MS = 24 * 3_600_000;
const SAME_ASK_WORDS = 6;
const sameAsk = (text: string, others: readonly OtherAsk[], now: number): OtherAsk | undefined => {
  const words = incidentWords(text);
  return others.find(ask => now - Date.parse(ask.at) <= ASK_WINDOW_MS && [...incidentWords(ask.text)].filter(word => words.has(word)).length >= SAME_ASK_WORDS);
};
/**
 * The other chat's open todo whose words hold every incident word of the `about`, with at least SAME_ABOUT_WORDS of them. On 10-22 AI harness
 * asked the owner the us-metal02 agent slot count at 13:22Z and again at 13:23Z, about "agent slots on us-metal02", while metal-management's
 * t8 "Keep us-metal02's agent slots at 12, or go back to the 32 set in Settings" waited; the texts shared only 3 incident words with t8.
 * measured: over the 2,714 tell_owner lines sent in the owner's chats from 10-09 to 10-23 (245 labelled), with each other chat's open todos of
 * the last 24 h at the time, 2 or 3 words refuse those 2 lines and no other, and 4 words refuse none.
 * Evidence: ~/work/tell-owner-noise-p942/replay.md.
 */
const SAME_ABOUT_WORDS = 3;
const sameAbout = (about: string, others: readonly OtherAsk[], now: number): OtherAsk | undefined => {
  const words = incidentWords(about);
  return words.size < SAME_ABOUT_WORDS ? undefined : others.find(ask => now - Date.parse(ask.at) <= ASK_WINDOW_MS && [...words].every(word => incidentWords(ask.text).has(word)));
};
/**
 * The device or account the owner must act on that a text names: "mac" for a Mac or MacBook, an M1 or M2 Air, or a handle with four letters
 * in a row and a digit, such as krenerd77, fhnyq29tw5 or us-metal02.
 */
const thingsOf = (text: string): Set<string> => {
  const lower = text.toLowerCase();
  const things = new Set([...lower.matchAll(/\bm\d+ (?:air|pro|mini)\b/g), ...lower.matchAll(/(?<![\w@.-])(?=[\w-]*[a-z]{4})(?=[\w-]*\d)[a-z][\w-]{4,}/g)].map(match => match[0]));
  if (/\bmac(?:book)?s?\b/.test(lower)) things.add("mac");
  return things;
};
/** Words that say a device or account is out of reach until he acts: offline, asleep, locked, paused, declined, expired, signed out. */
const THING_DOWN = /\b(?:offline|asleep|sleeping|slept|locked|paused|declined|expired|logged out|signed out|unreachable|disconnected)\b/gi;
const downWords = (text: string): Set<string> => new Set([...text.matchAll(THING_DOWN)].map(match => match[0].toLowerCase()));
/**
 * The other chat's open todo that names the same device or account as the text and says it is down the same way. On 10-24 at 03:39Z SEO guy
 * asked "Please open your MacBook and keep it awake on the network" while sep launch!! t30 ("Your MacBook Pro has been offline on Tailscale")
 * and CI and RepoOps t67 ("Your Mac has been offline since 19:08 KST") waited, and the texts shared only 2 and 3 incident words with them.
 * measured: over the 2,742 tell_owner lines sent in the owner's chats from 10-09 to 10-24 04:46Z, with each other chat's open todos of the last
 * 24 h at the time, this matches 2 lines and no other: that one and CI and RepoOps' own Mac offline ask of 10-23 22:58Z, sent while t30 had
 * waited 9 h. Evidence: ~/work/same-action-ask/replay.md.
 */
const sameThing = (text: string, others: readonly OtherAsk[], now: number): OtherAsk | undefined => {
  const things = thingsOf(text), down = downWords(text);
  return down.size === 0 ? undefined : others.find(ask => now - Date.parse(ask.at) <= ASK_WINDOW_MS
    && [...thingsOf(ask.text)].some(thing => things.has(thing)) && [...downWords(ask.text)].some(word => down.has(word)));
};
/**
 * Words that send the owner to another chat's list for an ask, like "answer it once on metal-management's list" or "sign it back in from the
 * Railway Breach thread's list (t10)", both of 10-22: that chat already asks him, so this message asks nothing new.
 * measured: on the same replay these words catch those 2 lines and no other sent line.
 */
const OTHER_LIST = /\b(?:thread|chat)['’]s (?:list|for you|todos?)\b|\bon [\w-]+(?: [\w-]+){0,3}['’]s list\b/i;
const SAME_ASK_MARK = "Not sent, another chat already asks him this on For you";
const REPEAT_MARK = "Not sent, you already told him this goal is done";
const REASK_MARK = "Not sent, this decision already waits for him on For you";
const INCIDENT_MARK = "Not sent, a blocker says what he must do";
/** Words of a blocker that asks the owner for something: a question, you or your, please, or a Korean ask. */
const ASKS_HIM = /\?|\byou\b|\byour\b|\bplease\b|주세요|골라|할까요|정해|해줘|하세요|부탁/i;
/**
 * A promise to report back, which asks nothing of him: on 10-22 at 08:21Z metal-management sent a prod Postgres outage a job was already fixing
 * as a blocker, and its only "you" was in "I'll tell you when census and the API are writing again".
 * measured: of the 35 blockers sent on turns he did not start in the replay (12 labelled needed), leaving these words out changes only that one.
 */
const TELLS_HIM_LATER = /\b(?:tell|let|keep|update|ping|show) you\b(?: know| posted)?/gi;
const asksHim = (text: string): boolean => ASKS_HIM.test(text.replace(TELLS_HIM_LATER, ""));
const PROGRESS_MARK = "Not sent, it reports work still going";
/**
 * Words that say the work goes on and its result comes later: a number still being counted, a plan to tell him once something ends, a clock
 * that starts now, a count of open steps. On 10-22 (temp) mcp release sent "I'll ask you to walk the prod deploy with it after that" at
 * 05:49Z, Crawler VP an answer whose second half was "still being counted" 28 min before the final one at 06:30Z, and AI harness its "down to
 * 11 open steps" at 07:05Z. Of the 170 lines d11 labelled from 10-19 to 10-22 these words catch 4 of the 5 progress relays (the fifth, a 10-19
 * blocker, falls to ASKS_HIM) and none of the 141 needed ones; on the owner's own turns, never held, they mark 9 of 387 sent lines. A page
 * still being written is the same: AI harness sent "I'm putting the bugs and fix options on one page for our talk" at 15:44Z on 10-22, an hour
 * before the page. measured: over the 2,714 lines sent from 10-09 to 10-23 those words match that line and no other
 * (~/work/tell-owner-noise-p942/replay.md). A fix still underway is the same: AI harness sent "the fix is underway (p932)" with the cause of the
 * Usage chart hang at 04:46Z on 10-23. measured: a replay of the 2,714 lines sent from 10-09 to 10-23 refuses that line and no other one more
 * (~/work/progress-relay-watch/replay-new.json).
 */
const PROGRESS = /\bstill being \w+ed\b|\binterim\b|\b(?:I['’]ll|I will|we['’]ll|we will)\b[^.?!]*\b(?:after that|later|once)\b|\b(?:starts|started|begins) now\b|\bstepping up\b|\b\d+ (?:open|remaining) (?:steps|items|jobs|tasks)\b|\b(?:steps|items|jobs|tasks) (?:left|remain(?:ing)?)\b|\b(?:I['’]m|I am|we['’]re|we are) (?:putting|writing|drafting|preparing|pulling)\b[^.?!]*\b(?:page|doc|write-?up|report|together)\b|\b(?:fix|fixes|work|change|changes|rebuild|rewrite) (?:is|are) (?:now )?(?:underway|under way|in progress)\b/i;
/**
 * A done that names a step (p57) on staging and says nothing of prod: the step is finished but its goal waits on prod, so the result is not in.
 * On 10-23 at 10:17Z a chat sent "Google search is upgraded on staging (p57)" while its goal p18 ("works through api.virev.ai on prod") stayed
 * open, and d11 labelled it progress. measured: a step done under an open goal alone also marks 27 needed lines of 2,671 sent from 10-09 to
 * 10-23, while these words on turns he did not start mark that line and no other (~/work/progress-relay-watch/staging-step.md).
 */
const STAGING_STEP = /\bon staging\b/i;
const stagingStep = (text: string, about: string): boolean => STAGING_STEP.test(text) && /\bp\d+\b/.test(`${text} ${about}`) && !/\bprod(?:uction)?\b/i.test(text);
/**
 * The step a done names and the goal over it that still misses its target, when every step the text and about name is such a step: any step
 * but a check-in's goal gap (`duty` "checkin/..."), under an open goal whose number is not there yet.
 * On 10-23 at 13:53Z a chat sent the cause of its unindexed blog pages (p90, d2) while his visits goal p56 read 141.7 of 10,000, and at 17:40Z
 * AI harness sent the clean test of p910 (d10) while p706 read 59.6 of 100% duties green; d11 labelled both progress on a goal still going.
 * On 10-24 at 21:29Z, on a wake from its job, AI harness sent the p954 done (heavy checks off the Mac), a step with no duty he never asked for,
 * while its goal p700 read 1 of 0 to fix; d11 labelled it an unasked result.
 * measured: over the 2,754 lines sent from 10-09 to 10-24 22:40Z (291 labelled), with each chat's board of 10-24 22:40Z, this marks 5 noise
 * lines (p90, p910, p358, p954, p9) and 12 needed ones, mostly a step he asked for under a wider goal, which go out on their second call; it
 * refuses 13 lines the duty-only check sent (2 noise, 11 needed, 0 unlabelled) and lets out none that check refused.
 * Evidence: ~/work/tell-owner-open-goal-done/replay.md.
 */
const GOAL_GAP = /^checkin\//;
/**
 * A percentile the text shares with a found step's or goal's metric is no step id: on 10-24 at 00:54Z CI and RepoOps sent the p358 runner
 * wait fix (d1) while p1 read about 46 of 10 min, and its "at p90" named the done step p90 of that board too, so the check let it out.
 * measured: the replay of the 2,733 lines sent from 10-09 to 10-23 20:30Z refuses the same 1,618 lines as before, none more
 * (~/work/tell-owner-duty-fix-leak/replay.md).
 */
const metricIds = (found: readonly { step: PlanItem; goal: PlanItem }[]): Set<string> =>
  new Set(found.flatMap(({ step, goal }) => `${step.target?.metric ?? ""} ${goal.target!.metric}`.match(/\bp\d+\b/g) ?? []));
export function openGoalDone(text: string, plan: readonly PlanItem[]): { step: PlanItem; goal: PlanItem } | undefined {
  const ids = new Set(text.match(/\bp\d+\b/g) ?? []);
  const found: { step: PlanItem; goal: PlanItem }[] = [];
  const walk = (items: readonly PlanItem[], goals: readonly PlanItem[]): void => {
    for (const item of items) {
      const goal = goals.findLast(above => above.target);
      if (ids.has(item.id) && goal && !GOAL_GAP.test(item.duty ?? "") && goal.status !== "done" && goal.status !== "dropped"
        && goal.target!.current !== undefined && !targetMet(goal.target!)) found.push({ step: item, goal });
      walk(item.children, [...goals, item]);
    }
  };
  walk(plan, []);
  const echoed = metricIds(found);
  const named = [...ids].filter(id => !echoed.has(id) || found.some(({ step }) => step.id === id));
  return found.length && found.length === named.length ? found[0] : undefined;
}
const NEEDLESS_OK_MARK = "Not sent, no owner rule keeps this for him";
/**
 * An ok asked for work the chat may do itself: a restart or a run of its own (`should I restart p5`, `want me to run`), a step handed to a job
 * (`can my job`, `can a job`), or work it says no outsider sees. A text that names one of his rules, an exception, or an outside send
 * (`OWNER_KEEPS`) still goes out, since rule 8 and his own rules keep those for him. On 10-20 to 10-22 d11 labelled 5 such asks noise: a DM
 * between two of our spare accounts, a Tailwind exclude for his Mac's VS Code (c69), a restart of a removed job, another chat's stalled box
 * swaps and a Codex fallback (c30).
 * measured: a replay over the 887 tell_owner calls of the owner's chats from 10-19 to 10-22 (787 sent, 232 labelled) refuses all 5, none of
 * the 189 lines labelled needed and none of the 555 unlabelled ones; the one needed line the ask words catch, a c146 exception for two prod box commands, goes out on
 * OWNER_KEEPS. Evidence: ~/work/needless-ask-check/. A product prod deploy or promote is a step walked with him (c154, 10-22), so an ask for its
 * go also goes out on OWNER_KEEPS; d11 relabelled the billing fix ask on t29 of 10-23 03:12Z needed for it.
 */
const NEEDLESS_OK = /\b(?:can|could|should|shall|may) (?:a|my|one of my|the) jobs?\b|\b(?:(?:should|can|could|shall|may) I|(?:do you )?want me to) (?:re(?:start|run|try|spawn|launch)|resume|run|start|take over|kick off|spin up)\b|\b(?:nobody|no one) outside\b/i;
const OWNER_KEEPS = /\bc\d{1,3}\b|\b(?:prod|production)\b[^.?!]*\b(?:deploy|promote|release)|\bpromote\b|\byour rule\b|\bjust this once\b|\bexception\b|\be-?mail\b|\bticket\b|\bsupport\b|\bcustomer|\bpublish|\b5180\b|\bvariant\b|\bboard layout\b/i;
/**
 * Words that swap a todo for a new one with the same question: on 10-22 at 17:22Z metal-management removed t8, added t10 and sent "t8 is
 * replaced by t10, the same agent-slot question with new numbers", a decision already on For you.
 * measured: on the same replay these words catch that line, no other line on a turn he did not start, and one on his own turns, which are
 * never held.
 */
const REPLACED = /\bt\d+\b[^.?!]*\b(?:replaced|swapped|superseded)\b|\b(?:replaces|supersedes)\b[^.?!]*\bt\d+\b/i;
/**
 * The todo an ask names that the chat put in place of one it took back in the last ASK_WINDOW_MS (`droppedTodos`, `swappedFor`): the same
 * question asked again. On 10-23 at 13:37Z metal-management removed t10, the second version of its us-metal02 agent-slot ask after t8, added
 * t11 in the same call and sent "I'd raise it from 12 to 20 at once, so pick on t11". REPLACED refused it on the words "t11 replaces t10" in
 * its about; the chat resent it 13 s later because "the pick moved from 12 to 20", and the owner's labeller marked it noise.
 * measured: over the 3,106 tell_owner calls of the owner's 15 chats from 10-09 to 10-23 16:36Z (2,676 sent, 255 labelled, 202 needed), the
 * chats took back 93 todos unanswered, 18 of them in a call that added another, and asks that name a todo swapped in this way are those 3
 * calls and no other. Evidence: ~/work/tell-owner-todo-swap-p970/replay.md.
 */
const swappedIn = (text: string, dropped: readonly DroppedTodo[], now: number): { todo: DroppedTodo; into: string } | undefined => {
  const named = new Set(todoIds(text));
  for (const todo of [...dropped].reverse()) {
    const into = now - todo.at > ASK_WINDOW_MS ? undefined
      : todo.swappedFor?.find(id => named.has(id)) ?? [...named].find(id => todo.swappedAfter !== undefined && Number(id.slice(1)) > todo.swappedAfter);
    if (into) return { todo, into };
  }
  return undefined;
};
const SPLIT_MARK = "Not sent, it splits one answer into two messages";
/**
 * How soon after an answer or done a second one reads as its tail. On 10-22 a chat sent "I could not substantiate the requested 50% cut" at
 * 08:35:41Z and the review page it came from 3.8 s later as its own message; the closest second answer labelled needed came 51.8 s after one.
 * measured: on the same replay, 3 answers or dones followed one in the same turn in a later step, at 3.8 s (that line), 37.5 s (unlabelled) and
 * 51.8 s (needed), so 30 s refuses only that line. Two calls in one step are already refused as one (tells).
 */
const SPLIT_MS = 30_000;
const ENDS: readonly unknown[] = ["answer", "done"];
const WITHDRAW_MARK = "Not sent, it takes back your own ask";
/**
 * Words that take back an ask the chat put on For you itself: skip or scratch a todo or idea, or a todo taken off his list. Removing the todo
 * already took it off his list, so the message asks nothing. On 10-22 Ops guy sent "Skip t9, I removed it", AI harness "Scratch the Codex
 * idea" and launch main bro "You can skip the push on t14, I took it off your list".
 * measured: on the same replay these words catch those 3 lines, none of the 189 needed ones, and no other line on a turn he did not start.
 */
const WITHDRAW = /\b(?:skip|scratch|ignore|disregard|forget|drop|cancel|withdraw)\b[^.?!]*\b(?:t\d+|idea|ask|todo|request|question)\b|\b(?:removed|took|taken|pulled) (?:it|t\d+|that|this) (?:off|from)\b|\boff your list\b/i;
/**
 * The todo a text names that the chat took back unanswered in the last ASK_WINDOW_MS (`droppedTodos`): a message about an ask already off his
 * list. On 10-25 at 10:35:31Z a chat checked its own t15 ("Can I ship the small prod Vent update now to fix them?") with no answer from him
 * and sent "the small prod Vent update on t15 isn't needed" 3 s later, in words WITHDRAW does not catch.
 * measured: over the 2,771 tell_owner lines sent in the owner's chats from 10-09 to 10-25 (309 labelled, 245 needed, 64 noise), lines on turns
 * he did not start that name such a todo are 5, all labelled noise, and the older checks already refused 4 of them.
 * Evidence: ~/work/d11-after-fix-noise/replay.md.
 */
const takenBack = (text: string, dropped: readonly DroppedTodo[], now: number): DroppedTodo | undefined => {
  const named = new Set(todoIds(text));
  return dropped.findLast(todo => named.has(todo.id) && now - todo.at <= ASK_WINDOW_MS);
};
const EMPTY_ASK_MARK = "Not sent, this decision asks him nothing";
/**
 * Words of a decision that ask him to choose: a todo id, a pick, a choice, an ok or a recommendation. On 10-25 at 06:49:24Z a chat sent the
 * finding behind its new t68 ("the fast CI disk fills about 06:00 KST 10-29") as a decision with no ask in it, and the ask itself 16 s later.
 * measured: on the replay above, decisions sent on turns he did not start with none of these words and no ASKS_HIM word are 4 lines, all
 * labelled noise, and the older checks sent 2 of them.
 */
const CHOICE_WORDS = /\bt\d+\b|\b(?:pick|picks|choose|choice|approve|decide|answer|ok|okay|recommend|which|should|want|let me know)\b|\bI['’]d\b|추천|선택/i;
const UNLOOKED_MARK = "Not sent, you have not opened a screenshot of this screen in this turn";
/**
 * A 5180 demo link (localhost or the box's 15180 copy) or a screenshot image in a tell_owner text: a UI result handed to the owner to look at.
 * On 10-19 frontend bro sent "The new onboarding is on your Mac's 5180 too. http://localhost:5180/configure?..." at 07:18:44Z after only an
 * ls of the variant folder, two minutes after it filed c118, and the owner answered "and it's ugly as fuck ... consistent with our actual apps"
 * at 07:29:01Z. Of the 78 tell_owner texts in that chat that carried such a link or shot, 50 went with no image opened in their turn, and 13 of
 * the 25 after c118.
 */
const UI_HANDOFF = /\b(?:localhost|127\.0\.0\.1|[\w-]+(?:\.[\w-]+)+):1?5180\b|!\[[^\]]*\]\([^)\s]+\.(?:png|jpe?g|webp|gif)\)/iu;
const WIKI_LINK_MARK = "Not sent, a wiki: link in it opens no page";
/** Every `wiki:` link a text holds as written, with trailing sentence punctuation left out (markdown.ts reads bare targets the same way). */
const WIKI_TOKEN = /(?<![\w-])wiki:[^\s<>()[\]`"'*]+/g;
export const wikiLinks = (text: string): string[] =>
  [...text.matchAll(WIKI_TOKEN)].map(match => "wiki:" + match[0].slice(5).replace(/[.,;:!?]+$/, "")).filter(link => link !== "wiki:");
/**
 * Whether a wiki page exists, read from the wiki's content folder when this box holds the wiki role in hosts.json, the folder the wiki serves
 * pages from. Null on any other box, where the folder can lag the wiki's, so no link is checked there.
 */
export function localWikiPages(file = process.env.SIEUN_PI_HOSTS ?? join(homedir(), ".config/sieun-pi/hosts.json")): ((path: string) => boolean) | null {
  const short = (name: string) => name.split(".")[0]!.toLowerCase();
  try {
    const hosts = (JSON.parse(readFileSync(file, "utf8")) as { hosts?: { hostname?: string; roles?: { wiki?: unknown } }[] }).hosts ?? [];
    if (!hosts.some(host => host.roles?.wiki && typeof host.hostname === "string" && short(host.hostname) === short(hostname()))) return null;
  } catch { return null; }
  const content = join(homedir(), WIKI_CONTENT_HOME.slice(2));
  return path => existsSync(join(content, path));
}
/** Each `wiki:` link in the text that opens no page, with why: no page path in it, or no such page on the wiki. */
export function brokenWikiLinks(text: string, pageExists: ((path: string) => boolean) | null): string[] {
  return wikiLinks(text).flatMap(link => {
    const path = wikiLinkPath(link.slice(5));
    if (path === null) return [`${link} (no page path in it)`];
    return pageExists && !pageExists(path) ? [`${link} (no page ${path} on the wiki)`] : [];
  });
}
/**
 * The todos the chat_board calls in `messages` added and then removed or checked, with when, leaving out each one the owner answered. A call
 * counts once its result shows the board applied it, and an added todo takes its id from that result. The owner's answer reaches the chat as
 * a [board] note that quotes the todo as the board does, at most 80 characters. A call in the last message, the running step, has no result
 * yet, so one that adds a todo counts as applied.
 */
export function droppedTodos(messages: readonly ThreadMessage[]): DroppedTodo[] {
  const calls = new Map<string, { at: number; ops: unknown[] }>();
  const todos = new Map<string, { id: string; text: string; choices?: readonly string[] }>();
  const answered = new Set<string>();
  const dropped: DroppedTodo[] = [];
  const quoted = (text: string) => `"${text.length > 80 ? text.slice(0, 79) + "…" : text}"`;
  const strings = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
  let top = 0;
  const apply = (ops: unknown[], at: number, ids: string[], swap: Pick<DroppedTodo, "swappedFor" | "swappedAfter">) => {
    for (const op of ops as { op?: unknown; id?: unknown; text?: unknown; choices?: unknown; done?: unknown }[]) {
      if (op?.op === "todo_add" && typeof op.text === "string" && ids.length) {
        const id = ids.shift()!;
        const choices = strings(op.choices);
        todos.set(id, { id, text: op.text, ...(choices ? { choices } : {}) });
      }
      const todo = typeof op?.id === "string" ? todos.get(op.id) : undefined;
      if (!todo) continue;
      if (op.op === "todo_update" && typeof op.text === "string") todo.text = op.text;
      if (op.op === "todo_update" && strings(op.choices)) todo.choices = strings(op.choices)!;
      if ((op.op === "todo_remove" || op.op === "todo_update" && op.done === true) && !answered.has(todo.id)) {
        dropped.push({ ...todo, at, ...swap });
        todos.delete(todo.id);
      }
    }
  };
  for (const message of messages) {
    if (message.role === "assistant") for (const part of message.content) {
      if (part.type !== "toolCall" || part.name !== CHAT_BOARD_TOOL || typeof message.timestamp !== "number") continue;
      let ops: unknown = part.arguments?.ops;
      if (typeof ops === "string") try { ops = JSON.parse(ops); } catch { ops = []; }
      if (Array.isArray(ops)) calls.set(part.id, { at: message.timestamp, ops });
      if (Array.isArray(ops)) for (const op of ops as { id?: unknown }[]) if (typeof op?.id === "string" && /^t\d+$/.test(op.id)) top = Math.max(top, Number(op.id.slice(1)));
    }
    if (message.role === "user") {
      const text = messageText(message);
      if (text.startsWith("[board]")) for (const todo of todos.values()) if (text.includes(quoted(todo.text))) answered.add(todo.id);
    }
    if (message.role !== "toolResult" || message.toolName !== CHAT_BOARD_TOOL || !calls.has(message.toolCallId)) continue;
    const result = messageText(message);
    if (!/\bBoard rev \d+/.test(result)) continue;
    const { at, ops } = calls.get(message.toolCallId)!;
    calls.delete(message.toolCallId);
    const ids = [...result.matchAll(/\bAdded a todo (t\d+) /g)].map(match => match[1]!);
    for (const id of ids) top = Math.max(top, Number(id.slice(1)));
    apply(ops, at, ids, ids.length ? { swappedFor: [...ids] } : {});
  }
  const last = messages.at(-1);
  if (last?.role === "assistant") for (const part of last.content) {
    const call = part.type === "toolCall" ? calls.get(part.id) : undefined;
    if (call && (call.ops as { op?: unknown }[]).some(op => op?.op === "todo_add")) apply(call.ops, call.at, [], { swappedAfter: top });
  }
  return dropped;
}

/** The todo ids a text names, like t4. */
const todoIds = (text: string): string[] => [...text.matchAll(/\bt(\d+)\b/g)].map(match => `t${match[1]}`);

export function tellTurn(messages: readonly ThreadMessage[]): TellTurn {
  const ownerIds = new Set<string>();
  let ownerText = "";
  const told = new Map<string, string>();
  const doneAbout = new Map<string, string>();
  const calls = new Map<string, SentTell>();
  const sent: SentTell[] = [];
  const resent = new Set<string>();
  let done: string[] = [];
  let looked = false;
  for (const message of messages) {
    if (message.role === "user" && !serverNote(messageText(message).trim())) { ownerIds.add(ownerMessageId(message.timestamp)); ownerText = messageText(message); done = []; }
    if (message.role === "assistant") for (const part of message.content) {
      if (part.type === "toolCall" && part.name === TELL_OWNER_TOOL && typeof part.arguments?.text === "string") told.set(part.id, part.arguments.text.trim());
      if (part.type === "toolCall" && part.name === TELL_OWNER_TOOL && typeof message.timestamp === "number") calls.set(part.id, { at: message.timestamp, ...(typeof part.arguments?.why === "string" ? { why: part.arguments.why } : {}) });
      if (part.type === "toolCall" && part.name === TELL_OWNER_TOOL && part.arguments?.why === "done" && typeof part.arguments?.about === "string") doneAbout.set(part.id, part.arguments.about);
    }
    if (message.role === "user" || message.role === "custom") looked = false;
    if (message.role === "toolResult" && message.content.some(part => part.type === "image")) looked = true;
    if (message.role === "toolResult" && message.toolName === TELL_OWNER_TOOL && [SHOP_TALK_MARK, LONG_REPLY_MARK, REPEAT_MARK, REASK_MARK, UNLOOKED_MARK, INCIDENT_MARK, SAME_ASK_MARK, PROGRESS_MARK, NEEDLESS_OK_MARK, WITHDRAW_MARK, WIKI_LINK_MARK, SPLIT_MARK, EMPTY_ASK_MARK].some(mark => messageText(message).startsWith(mark))) {
      const text = told.get(message.toolCallId);
      if (text) resent.add(text);
    }
    if (message.role === "toolResult" && message.toolName === TELL_OWNER_TOOL && messageText(message) === TELL_OWNER_DONE && calls.has(message.toolCallId)) sent.push(calls.get(message.toolCallId)!);
    if (message.role === "toolResult" && message.toolName === TELL_OWNER_TOOL && messageText(message) === TELL_OWNER_DONE && doneAbout.has(message.toolCallId)) {
      done.push(doneAbout.get(message.toolCallId)!);
    }
  }
  const before = messages.at(-1)?.role === "assistant" ? messages.slice(0, -1) : messages;
  const lines = chatLines(before);
  const unanswered = lines.findLastIndex(line => line.kind === "user") > lines.findLastIndex(line => line.kind === "agent");
  const byOwner = turnStarter(messages.filter(message => !(message.role === "user" && revival(messageText(message).trim())))) === "owner";
  const last = messages.at(-1);
  const tells = last?.role === "assistant" ? last.content.filter(part => part.type === "toolCall" && part.name === TELL_OWNER_TOOL).length : 0;
  // The turn starts at the first wake after the last settled step: a message steered in mid-turn is no new turn, since on 10-21 at 09:47:43Z a
  // job's message arrived 1 s after mac-management added t8, and t8 read as added in an earlier turn, so its question was refused once.
  const settledAt = before.findLastIndex(message => message.role === "assistant" && (message as { stopReason?: string }).stopReason !== "toolUse");
  const startedAt = before.slice(settledAt + 1).find(message => message.role === "user" || message.role === "custom")?.timestamp
    ?? before.findLast(message => message.role === "user" || message.role === "custom")?.timestamp;
  const lastSent = typeof startedAt === "number" ? sent.findLast(tell => tell.at >= startedAt) : undefined;
  const dropped = droppedTodos(messages);
  return { owner: unanswered || byOwner, ownerIds, byOwner, tells, ownerText, resent, done, looked, ...(typeof startedAt === "number" ? { startedAt } : {}), ...(lastSent ? { lastSent } : {}),
    ...(dropped.length ? { dropped } : {}) };
}

/**
 * What `tell_owner` answers. On a turn the owner started, or with a `reply_to` that names one of his messages, any text reaches him as its own
 * bubble; a server restart of a failed turn keeps that turn's starter. On any other turn it reaches him only when `why` names a case (done, decision, blocker, answer) and `about` names that goal,
 * decision, blocker or question; else it is held, the feed shows it in the turn's notes, and the answer says how to send it if it is one
 * (c117; on 10-19 469 of 597 messages in a day came on turns the owner did not start, and the brief's rule since c104 had not held them).
 * A text it would send with shop talk (`shopTalk`: a UTC time, git's land or roll out, a commit id) is refused once with what to say instead,
 * and the very same text sent again goes out, so the check is a soft cap (c98). A text with a sentence over 35 words or over 80 words in all
 * (`longReply`, c18, c104) is refused once the same way, with where the rest goes. A text that
 * hands him a 5180 link or a screenshot (`UI_HANDOFF`) when no tool result showed the chat an image since the turn's last owner message or
 * report is refused once the same way, so the chat opens the shots and compares them with the accepted Staging app first (c118). A decision or
 * blocker that asks what another chat's open For you todo already asks (`sameAsk`, `turn.others`) is refused once the same way, and so is
 * a text that reports work still going (`PROGRESS`), a text that takes back the chat's own ask (`WITHDRAW`), and a decision or blocker that
 * asks an ok for work no owner rule keeps for him (`NEEDLESS_OK`). So is an answer or done that comes within `SPLIT_MS` of one the turn
 * already sent (`lastSent`), a decision or blocker whose about another chat's open todo holds (`sameAbout`), that sends him to another chat's
 * list (`OTHER_LIST`) or that swaps a todo for a new one (`REPLACED`, `swappedIn`), a blocker whose only "you" promises to tell him later, a
 * done for a step under a goal that misses its target (`openGoalDone`, `plan`), a decision with no question, pick or todo in it (`CHOICE_WORDS`),
 * and a text that names a todo the chat took back unanswered (`takenBack`, `dropped`). A text it would send with a `wiki:` link that opens no page (`brokenWikiLinks`)
 * is refused once the same way, with the form that works, since on 10-22 two links went out as `wiki:https://...:5176/page/...` and the owner
 * answered "often links to wrong page." on 10-23.
 */
export function tellOwner(input: TellInput, turn: TellTurn, now = Date.now(), pageExists = localWikiPages()): { kind: "sent" | "refused" | "held"; text: string } {
  const told = typeof input.text === "string" ? input.text.trim() : "";
  if (!told) return { kind: "refused", text: "nothing to tell: give text" };
  if (turn.byOwner === false && (turn.tells ?? 0) > 1) return { kind: "refused", text: `${turn.tells} tell_owner calls in one step on a turn ` +
    "the owner did not start, so none was sent. Send them as one message in one call now, the answer or each finished item in a sentence or two." };
  const named = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
  const answers = named(input.reply_to) && turn.ownerIds.has(input.reply_to.trim());
  const declared = TELL_CASES.includes(input.why as TellWhy) && named(input.about);
  const repeat = !turn.owner && input.why === "done" && named(input.about) && !turn.resent?.has(told) ? repeatOf(input.about, turn.done ?? []) : undefined;
  const reask = !turn.owner && !turn.resent?.has(told) ? todoIds(`${told} ${typeof input.about === "string" ? input.about : ""}`).find(id => turn.asked?.has(id)) : undefined;
  if (!turn.owner && input.why === "blocker" && !turn.resent?.has(told) && !asksHim(told)) return { kind: "refused", text: `${INCIDENT_MARK}, ` +
    "and this one asks nothing of him. An incident or delay that a job or another chat already handles is update, so put it on the board. If " +
    "only he can clear it, say what he must do and send it again; if he must see it now as it is, send the very same text again (c117)." };
  if (!turn.owner && input.why === "decision" && !turn.resent?.has(told) && !asksHim(told) && !CHOICE_WORDS.test(told)) return { kind: "refused",
    text: `${EMPTY_ASK_MARK}, no question, pick or todo in it. A finding behind a decision is detail, so put it in the todo or on the board ` +
      "and send one message with the question and your pick. If he must see it now as it is, send the very same text again and it goes out (c117)." };
  if (!turn.owner && (answers || declared) && !turn.resent?.has(told) && PROGRESS.test(told)) return { kind: "refused", text: `${PROGRESS_MARK} ("${PROGRESS.exec(told)![0]}"). ` +
    "Progress on work that is not finished is update, so put it on the board and tell him once the result is in, in one message. If he must " +
    "see this now as it is, send the very same text again and it goes out (c117)." };
  if (!turn.owner && input.why === "done" && declared && !turn.resent?.has(told) && stagingStep(told, input.about as string)) return { kind: "refused",
    text: `${PROGRESS_MARK}, a step on staging while its goal waits on prod. Put it in the step's note on the board and tell him once the goal ` +
      "is done, in one message. If this step finishes what he asked for, send the very same text again and it goes out (c117)." };
  const step = !turn.owner && input.why === "done" && declared && !answers && !turn.resent?.has(told) && turn.plan ? openGoalDone(`${told} ${input.about as string}`, turn.plan) : undefined;
  if (step) return { kind: "refused", text: `${PROGRESS_MARK}, ${step.step.id} is a step under goal ${step.goal.id}, which reads ` +
    `${step.goal.target!.current} of ${step.goal.target!.target}. A step done while his goal misses its target is update, like a fix your duty run ` +
    "started or a result he never asked for, so put it in the step's note and tell him once the goal is done, in one message. If this step " +
    "finishes what he asked for, send the very same text again and it goes out (c117)." };
  const about = typeof input.about === "string" ? input.about : "";
  const fresh = !turn.owner && !turn.resent?.has(told);
  const ask = fresh && (input.why === "decision" || input.why === "blocker");
  if (fresh && (answers || declared) && ENDS.includes(input.why) && turn.lastSent && ENDS.includes(turn.lastSent.why) && now - turn.lastSent.at <= SPLIT_MS)
    return { kind: "refused", text: `${SPLIT_MARK}, ${Math.round((now - turn.lastSent.at) / 1000)} s after your last one. Its rest is detail, ` +
      "so put it on the board or the wiki page and end the turn, or send one message with the takeaway and the page link. If it is a second " +
      "point he must see, send the very same text again and it goes out (c117)." };
  const other = ask ? sameAsk(`${told} ${about}`, turn.others ?? [], now) ?? sameAbout(about, turn.others ?? [], now)
    ?? sameThing(`${told} ${about}`, turn.others ?? [], now) : undefined;
  if (ask && !other && OTHER_LIST.test(told)) return { kind: "refused", text: `${SAME_ASK_MARK}, since this sends him to another chat's list ` +
    `("${OTHER_LIST.exec(told)![0]}"). Do not ask him twice. Wait on that todo, and if you know something it lacks, send it to that chat with ` +
    "agent_message. If yours is a different question he must answer too, send the very same text again and it goes out (c117)." };
  const swap = ask ? swappedIn(`${told} ${about}`, turn.dropped ?? [], now) : undefined;
  if (swap || ask && REPLACED.test(`${told} ${about}`)) return { kind: "refused", text: `${REASK_MARK}, as the todo you swapped in ` +
    `(${swap ? `${swap.into} for ${swap.todo.id} "${swap.todo.text.slice(0, 80)}", which he never answered` : `"${REPLACED.exec(`${told} ${about}`)![0]}"`}). ` +
    "He reads the new todo with its pick, numbers and choices on For you, and a changed pick or new numbers on the same question ask him " +
    "nothing new, so end the turn. Only for a different question he must answer now, send the very same text again and it goes out (c117)." };
  if (other) return { kind: "refused", text: `${SAME_ASK_MARK}, as ${other.id} of chat ${other.chat} ("${other.text.slice(0, 120)}"). Do ` +
    `not ask him twice. Wait on that todo, and if you know something it lacks, send it to that chat with agent_message so it adds it to ${other.id}. ` +
    "If yours is a different question he must answer too, send the very same text again and it goes out (c117)." };
  if (reask) return { kind: "refused", text: `${REASK_MARK} as ${reask}, which you added in an earlier turn. He reads it there, so a re-ask ` +
    `of an open todo stays on For you: put new facts, its cause, a new number, more urgency or a changed pick in ${reask} with chat_board ` +
    "todo_update and end the turn. Send the very same text again only when it corrects a fact he would answer wrong without it, and then it " +
    "goes out (c117)." };
  if (repeat) return { kind: "refused", text: `${REPEAT_MARK} ("${repeat}") since his last message. Send nothing unless this brings something ` +
    "new he must see or act on; if it does, send the very same text again and it goes out (c117)." };
  if (!turn.owner && (answers || declared) && !turn.resent?.has(told) && WITHDRAW.test(told)) return { kind: "refused", text: `${WITHDRAW_MARK} ` +
    `("${WITHDRAW.exec(told)![0]}"). The todo you removed is already off his list, so this asks nothing. Put the reason in that step's note on ` +
    "the board and end the turn. If he must see it now as it is, send the very same text again and it goes out (c117)." };
  const back = !turn.owner && (answers || declared) && !turn.resent?.has(told) ? takenBack(`${told} ${about}`, turn.dropped ?? [], now) : undefined;
  if (back) return { kind: "refused", text: `${WITHDRAW_MARK} (${back.id} "${back.text.slice(0, 80)}", which you took off his list with no ` +
    "answer from him). He no longer sees that ask, so a message about it asks nothing. Put the reason in that step's note on the board and end " +
    "the turn. If he must see it now as it is, send the very same text again and it goes out (c117)." };
  if (!turn.owner && (input.why === "decision" || input.why === "blocker") && !turn.resent?.has(told) && NEEDLESS_OK.test(told) && !OWNER_KEEPS.test(told)) return {
    kind: "refused", text: `${NEEDLESS_OK_MARK} ("${NEEDLESS_OK.exec(told)![0]}"). Rule 7 and c47 say act on work no owner rule keeps for him, ` +
      "such as a restart of your own job, a stalled step you can take over or a fix in his dev setup (c69), so do it, put it on the board, and " +
      "tell him after only when it finishes a goal he asked for. Drop it if one of his rules forbids it, like a model fallback (c30). Only rule 8's " +
      "list (an outside send, a 5180 design into the app, an accepted variant, the board layout, a thread host move) and an exception to his own " +
      "rule wait for him; if this is one, send the very same text again and it goes out (c117)." };
  if (turn.owner || answers || declared) {
    const broken = turn.resent?.has(told) ? [] : brokenWikiLinks(told, pageExists);
    if (broken.length) return { kind: "refused", text: `${WIKI_LINK_MARK}: ${broken.join(", ")}. Write each as wiki:<path under the wiki's ` +
      "content folder>, such as wiki:sessions/2026/10/23/0132-harness-load-discussion/prime-under-load.html, for a page that is there, and call " +
      "tell_owner again. Sending the very same text again sends it as it is." };
    const talk = turn.resent?.has(told) ? [] : shopTalk(told, turn.ownerText);
    if (talk.length) return { kind: "refused", text: `${SHOP_TALK_MARK} ${talk.join(", ")}. Write it the way a person texts in Slack, with what ` +
      "he would see or can do now in plain words, and call tell_owner again. Sending the very same text again sends it as it is (c18, c98)." };
    const long = turn.resent?.has(told) ? [] : longReply(told);
    if (long.length) return { kind: "refused", text: `${LONG_REPLY_MARK}, with ${long.join(" and ")}. Text him like a Slack DM, one point in ` +
      "one or two short sentences of one fact each. Send what matters most and put the rest on the board or a wiki page with its link, " +
      "never more clauses in one sentence. Sending the very same text again sends it as it is (c18, c104, c98)." };
    if (turn.looked === false && !turn.resent?.has(told) && UI_HANDOFF.test(told)) return { kind: "refused", text: `${UNLOOKED_MARK}. ` +
      "Before you hand him a 5180 link or screenshots, open each screenshot of what it shows with attach_image and compare it with the " +
      "accepted Staging app it should match, its page frame, title, filter row, row icons and spacing. A screen that looks unlike the accepted " +
      "apps goes back to the job, not to him. If you compared them in this turn, send the very same text again and it goes out (c118, c98)." };
    return { kind: "sent", text: TELL_OWNER_DONE };
  }
if (!named(input.why)) return { kind: "refused", text: "why is required on a turn the owner did not start. Call tell_owner again " +
    "with why (done, decision, blocker, answer or update) and about, or update the board and end the turn if it is only an update." };
  return { kind: "held", text: `${TELL_OWNER_HELD}. The owner did not start this turn, so a message reaches him only with why set to done, ` +
    "decision, blocker or answer and about naming that goal, decision, blocker or question. A finished goal he asked for, or a plan change " +
    "he would act on (a land order, a move), is done or decision, never update. If it is one of those, call tell_owner again with both; if " +
    "not, update the board and end the turn." };
}

const PY_STRING = /(?:[rbfuRBFU]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;
const CALL = /(?<!\w)bash\s*\(/g;

function unquote(literal: string): string {
  const body = literal.replace(/^[rbfuRBFU]{0,2}/, "");
  const triple = body.startsWith('"""') || body.startsWith("'''");
  return triple ? body.slice(3, -3) : body.slice(1, -1);
}

/** The text between the parenthesis at `openParen` and its match, with string literals skipped. */
function argumentText(code: string, openParen: number): string {
  let depth = 0;
  const limit = Math.min(code.length, openParen + 4000);
  for (let i = openParen; i < limit; i++) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      const delimiter = code.slice(i, i + 3) === ch.repeat(3) ? ch.repeat(3) : ch;
      i += delimiter.length;
      while (i < code.length && !code.startsWith(delimiter, i)) i += code[i] === "\\" ? 2 : 1;
      i += delimiter.length - 1;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return code.slice(openParen + 1, i);
  }
  return code.slice(openParen + 1, limit);
}

/** The command with quoted text blanked, so `rg "a|b"` passes while `cat x | sh` and `ls; rm x` do not. */
function unquotedShell(command: string): string {
  return command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, text => " ".repeat(text.length));
}
function shellReason(command: string | null, how: string): string | null {
  if (command !== null) {
    const trimmed = command.trim();
    const allowed = ALLOWED_SHELL.some(prefix => trimmed === prefix || trimmed.startsWith(prefix + " "));
    if (allowed && !/[;&|<>`\n]|\$\(/.test(unquotedShell(trimmed))) return null;
  }
  return `[soft cap] This ran, but the chat brief keeps a chat's own shell to quick look-ups (${SHELL_LIST}; no pipes, redirects or chaining) ` +
    `(${how}). Give the next real task to a job with rlm.spawn.`;
}
/**
 * The note for an ipython cell that goes past a chat's look-up shell, or null. The cell runs either way (owner 10-18: every arbitrary limit is
 * a soft cap). Calls are found on the code with its string literals and comments blanked, so a job brief that mentions bash( does not trip it.
 * A computed shell command counts as past it. subprocess and os.system are not inspected; the brief asks a chat not to use them.
 */
export function judgeChatCode(code: string): string | null {
  const lines = code.split("\n");
  let first = 0;
  while (first < lines.length && lines[first]!.trim() === "") first++;
  if (/^\s*%%(bash|sh|zsh|shell)\b/.test(lines[first] ?? "")) return shellReason(null, "a shell cell");
  for (const line of lines) {
    const bang = /^\s*!(?![=!])(.+)$/.exec(line);
    if (bang) { const reason = shellReason(bang[1]!.trim(), "a ! line"); if (reason) return reason; }
  }
  const blanked = code.replace(new RegExp(`${PY_STRING.source}|#[^\n]*`, "g"), text => " ".repeat(text.length));
  CALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CALL.exec(blanked)) !== null) {
    const args = argumentText(code, match.index + match[0].length - 1);
    const head = args.replace(/^\s*(?:command\s*=\s*)?/, "");
    PY_STRING.lastIndex = 0;
    const literal = PY_STRING.exec(head);
    const reason = shellReason(literal && literal.index === 0 ? unquote(literal[0]) : null, literal ? "bash()" : "a computed bash() command");
    if (reason) return reason;
  }
  return null;
}

export interface GuardInput { toolName: string; input: Record<string, unknown>; depth: number; marked: boolean }

/** The note a chat's tool call gets appended to its result: only in a marked root session (depth 0); the call always runs. */
export function chatShellNote({ toolName, input, depth, marked }: GuardInput): string | undefined {
  if (depth !== 0 || !marked) return undefined;
  if (toolName === "ipython" && typeof input.code === "string") return judgeChatCode(input.code) ?? undefined;
  if (toolName === "bash" && typeof input.command === "string") return shellReason(input.command, "the bash tool") ?? undefined;
  return undefined;
}

/**
 * The top of a session's parentSession chain, from `sessionFile` up: its id, its name, whether it is a chat and its header's start time. One header line per level, then
 * one scan of the top file. The name is the last session_info, or for a chat the last before the chat_mode entry (a chat is named at create,
 * before its first session_start writes the entry), where the scan stops. Null when a file is missing or has no header.
 */
export async function topSession(sessionFile: string): Promise<{ id: string; name: string; chat: boolean; at: number } | null> {
  let file = sessionFile;
  for (let level = 0; level < 16; level++) {
    const header = await fileHeader(file);
    if (!header) return null;
    if (typeof header.parentSession === "string") { file = header.parentSession; continue; }
    const lines = fileLines(file);
    let name = "";
    try {
      for await (const line of lines) {
        if (line.startsWith('{"type":"session_info"')) {
          try { const entry = JSON.parse(line) as { name?: unknown }; if (typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim(); } catch { continue; }
        } else if (line.includes(`"customType":"${CHAT_MODE_ENTRY}"`)) {
          try { if (hasChatMarker([JSON.parse(line)])) return { id: header.id, name, chat: true, at: header.at }; } catch { continue; }
        }
      }
      return { id: header.id, name, chat: false, at: header.at };
    } catch { return null; }
  }
  return null;
}

async function fileHeader(sessionFile: string): Promise<{ id: string; parentSession?: unknown; at: number } | null> {
  const lines = fileLines(sessionFile);
  try {
    for await (const line of lines) {
      const header = JSON.parse(line) as { type?: unknown; id?: unknown; parentSession?: unknown; timestamp?: unknown };
      return header.type === "session" && typeof header.id === "string" ? { id: header.id, parentSession: header.parentSession, at: Date.parse(String(header.timestamp ?? "")) || 0 } : null;
    }
    return null;
  } catch { return null; }
}

const JOB_CALL = /\brlm(?:\.spawn|\.create_session)?\s*\(/g;
const blankStrings = (code: string): string => code.replace(new RegExp(`${PY_STRING.source}|#[^\n]*`, "g"), text => " ".repeat(text.length));
/** Each `rlm(...)`, `rlm.spawn(...)` or `rlm.create_session(...)` in an ipython cell that gives `name=` as a plain string literal; a computed name (an f-string with a field, a variable) is not found. */
export function jobNameLiterals(code: string): { call: "rlm" | "rlm.spawn" | "rlm.create_session"; name: string }[] {
  const blanked = blankStrings(code);
  const names: { call: "rlm" | "rlm.spawn" | "rlm.create_session"; name: string }[] = [];
  JOB_CALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JOB_CALL.exec(blanked)) !== null) {
    const args = argumentText(code, match.index + match[0].length - 1);
    const keyword = /\bname\s*=/.exec(blankStrings(args));
    if (!keyword) continue;
    PY_STRING.lastIndex = 0;
    const rest = args.slice(keyword.index + keyword[0].length).trimStart();
    const literal = PY_STRING.exec(rest);
    if (!literal || literal.index !== 0 || (/^[rbuRBU]*[fF]/.test(literal[0]) && literal[0].includes("{"))) continue;
    const name = unquote(literal[0]).trim();
    if (name) names.push({ call: match[0].replace(/\s*\($/, "") as "rlm" | "rlm.spawn" | "rlm.create_session", name });
  }
  return names;
}
/** The session names an ipython cell gives `rlm.create_session(..., name="...")` as plain string literals. */
export const createSessionNames = (code: string): string[] => jobNameLiterals(code).filter(entry => entry.call === "rlm.create_session").map(entry => entry.name);
