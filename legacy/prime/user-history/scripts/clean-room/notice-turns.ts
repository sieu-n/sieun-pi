import { homedir } from "node:os";
import { join } from "node:path";
import { chatLines, serverNote, unreadCount, type ChatLine } from "../../src/shared/chat-feed.ts";
import { messageText } from "../../src/shared/turns.ts";
import type { ThreadMessage } from "../../src/shared/types.ts";
import { ownJob } from "./answer-data.ts";
import { messagesOf, noteFaults } from "./quiet-wakes.ts";
import { readSession, sessionFile, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c117's server-notice route (d10 p1260, 10-29). The check-in's hand-off to a chat whose job pi-pool held went with
 * no server prefix, so the feed, the tell_owner check, the unread count, Slack and d11 read each turn it started as the owner's: on 10-23 at
 * 13:04Z AI harness developer environment VP closed one with two status recaps that reached him as replies. A fresh chat gets an ordinary
 * owner-style task, and right after setup the run puts the Step owners duty on it (scripts/duties/step-owners.ts, every 15 min), whose
 * precheck sends the chat the same kind of notice with no prefix through the service's own duty path (`DutyHost.tell`, `Chats.notice`).
 * The criteria live in the run folder's criteria.md.
 */
export const TASK = "can you keep an eye on the sieun-pi duty runs on this box for the next 90 min? every 30 min note which duties flagged " +
  "or failed since the last look, on a page with the running list. if one looks broken, ask me before you change it";
/** The notices a run needs before it is judged: the 10-23 case was one, and 3 show the chat does not drift back on later ones. */
export const MIN_NOTICES = 3;
export const NOTICE = /^(?:\[[^\]]*\]\s*)?The Step owners run of /;
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 160): string => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > length ? flat.slice(0, length - 1) + "\u2026" : flat; };
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
export type Check = { id: string; ok: boolean | null; detail: string };

type UserMessage = Extract<ThreadMessage, { role: "user" }>;
const isNotice = (message: ThreadMessage): message is UserMessage => message.role === "user" && NOTICE.test(messageText(message).trim());

/**
 * Criteria a to d on the chat's transcript, read the way the owner's page reads it (chatLines, unreadCount). The owner writes only the first
 * message, so every line the chat sends him after the first notice must be a tell_owner message, and the unread count must equal their number.
 */
export function judgeNotices(messages: readonly ThreadMessage[]): Check[] {
  const checks: Check[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
  const notices = messages.filter(isNotice);
  const first = notices[0]?.timestamp;
  const bare = notices.filter(message => serverNote(messageText(message).trim()) === undefined);
  add("a", notices.length < MIN_NOTICES && !bare.length ? null : !bare.length, bare.length
    ? bare.map(message => `at ${iso(message.timestamp)} with no server prefix: "${clip(messageText(message), 100)}"`).join("; ")
    : `${notices.length} Step owners notices reached the chat, each as a server note (${[...new Set(notices.map(message => serverNote(messageText(message).trim())))].join(", ")})`);
  if (first === undefined) {
    for (const id of ["b", "c", "d"]) add(id, null, "no Step owners notice has reached the chat yet");
    return checks;
  }
  const lines = chatLines(messages);
  const after = lines.filter(line => line.at >= first);
  const replies = after.filter((line): line is Extract<ChatLine, { kind: "agent" }> => line.kind === "agent" && !line.told);
  add("b", notices.length < MIN_NOTICES && !replies.length ? null : !replies.length, replies.length
    ? replies.map(line => `at ${iso(line.at)} as a reply: "${clip(line.text)}"`).join("; ")
    : `no closing text after the first notice at ${iso(first)} showed as a reply to the owner`);
  const notes = after.filter((line): line is Extract<ChatLine, { kind: "notes" }> => line.kind === "notes" && !/-t\d+$/.test(line.id));
  const bad = notes.flatMap(line => { const found = noteFaults(line.text); return found.length ? [`at ${iso(line.at)} (${found.join(", ")}): "${clip(line.text)}"`] : []; });
  add("c", notices.length < MIN_NOTICES && !bad.length ? null : !bad.length, bad.length ? bad.join("; ")
    : `${notes.length} closing texts after the first notice show one sentence of at most 25 words with no reminder; ${notes.filter(line => line.full).length} were trimmed by the page`);
  const told = after.filter(line => line.kind === "agent" && line.told).length;
  const unread = unreadCount(messages, first - 1);
  add("d", notices.length < MIN_NOTICES && unread === told ? null : unread === told, `unread from the first notice reads ${unread}, and ${told} tell_owner messages were sent to him`);
  return checks;
}

async function judge(run: string, state: RunState): Promise<{ verdict: Verdict; text: string }> {
  const chat = state.chat.id;
  const file = sessionFile(chat);
  const messages = file ? await messagesOf(file) : [];
  const checks = judgeNotices(messages);
  const events = readSession(chat).filter(event => event.at >= state.windowStart);
  const typed = events.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !event.text.trimStart().startsWith("<") && !NOTICE.test(event.text.trim()) && !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))));
  const outside = events.filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling") &&
    !ownJob(state.chat.name, event));
  checks.push({ id: "e", ok: typed.length === 0 && outside.length === 0, detail: typed.length || outside.length
    ? [...typed, ...outside].map(event => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 120)}"`).join("; ")
    : "only the owner-style message, server notes and the chat's own jobs reached the chat" });
  const verdict: Verdict = checks.find(check => check.id === "e")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the chat's session file, read the way the owner's feed shows it, and ${join(DATA, "service.log")}.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}

export const noticeTurns: Scenario = {
  name: "notice-turns",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    "Right after setup the run adds the Step owners duty (scripts/duties/step-owners.ts, every 15 min) to the chat with scripts/duties/add.ts.", "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
