import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Projector } from "../../src/chat-projection.ts";
import { historyMessages, readBranchPage } from "../../src/session-tail.ts";
import { chatLines, ownerTyped, unreadCount, type ChatLine } from "../../src/shared/chat-feed.ts";
import { isPromptCustom } from "../../src/shared/turns.ts";
import type { ChatBoard, ThreadMessage } from "../../src/shared/types.ts";
import { ownJob } from "./answer-data.ts";
import { sentences, words } from "./dry-message.ts";
import { readSession, sessionFile, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c117 after the owner gave it again on 10-27 18:43Z in api portal vp ("이딴거 마구 쳐 보내지마"). From 13:07Z that
 * chat ended about 11 turns he did not start with a status recap that reminded him of todo t4, and each one lit the chat as unread. sieun-pi's
 * fix tells a chat to end such a turn with no text or a few words on what it changed, and counts only the lines sent to him as unread. A fresh
 * chat gets one owner-style task that runs for hours on its own wakes and job reports and holds a question for him that he never answers. The
 * criteria live in the run folder's criteria.md.
 */
export const TASK = "keep an eye on the sieun-pi duty runs on this box for the next 2 hours. every 30 min check which duties flagged or " +
  "failed since the last check and keep a page with the running list. if you think one should be turned off or changed, ask me first";
/** The turns he did not start that must end after the first question for the run to show the behavior: 11 did on 10-27. */
export const MIN_QUIET_TURNS = 3;
/** The few words a quiet turn may end with: one sentence within c104's sentence size. */
export const MAX_WORDS = 25;
const TODO_ID = /\bt\d{1,4}\b/;
const TODO_IDS = /\bt\d{1,4}\b/g;
const FOR_YOU = /\bfor you\b|\bstill (?:open|waiting|need)|\bwaiting (?:on|for) (?:you|your)\b|\byour (?:call|pick|answer|decision)\b/i;
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 160): string => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > length ? flat.slice(0, length - 1) + "\u2026" : flat; };
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";

async function messagesOf(file: string): Promise<ThreadMessage[]> {
  const pages: unknown[][] = [];
  let from = null;
  for (;;) {
    const page = await readBranchPage(file, from, { messages: 2000, bytes: 16 * 1024 * 1024 });
    if (!page) break;
    pages.unshift(page.entries);
    if (!page.before) break;
    from = page.before;
  }
  return new Projector({ put: () => "x", link: () => {} } as never).messages(historyMessages(pages.flat() as never));
}

/** What a quiet turn's closing text does wrong: a recap longer than a few words, or a reminder of a question he has not answered. */
export function noteFaults(text: string): string[] {
  const parts = sentences(text);
  return [
    ...(parts.length > 1 ? [`${parts.length} sentences`] : []),
    ...parts.filter(part => words(part) > MAX_WORDS).map(part => `a sentence of ${words(part)} words`),
    ...(TODO_ID.test(text) || FOR_YOU.test(text) ? ["a reminder of an open question"] : []),
  ];
}

export async function judgeLines(lines: readonly ChatLine[], messages: readonly ThreadMessage[], asked: number | undefined): Promise<{ id: string; ok: boolean | null; detail: string }[]> {
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
  if (asked === undefined) {
    for (const id of ["a", "b", "c", "d"]) add(id, null, "the chat has not put a question on For you yet");
    return checks;
  }
  const ends = messages.filter(message => message.role === "assistant" && (message as { stopReason?: string }).stopReason === "stop" && (message.timestamp ?? 0) > asked);
  add("a", ends.length >= MIN_QUIET_TURNS ? true : null, `${ends.length} turns ended after the first question at ${iso(asked)}`);
  // Criterion b covers turns the owner did not start: a note counts when the last message that started a turn before it is not one he typed
  // (run2's judge also scored his first turn at 01:59:44Z). It judges what his page shows of each closing text, and names what the chat wrote.
  const starts = messages.filter(message => message.role === "user" || (message.role === "custom" && isPromptCustom(message as never)));
  const quiet = (at: number): boolean => { const start = starts.filter(message => (message.timestamp ?? 0) <= at).at(-1); return !start || !ownerTyped(start); };
  const notes = lines.filter((line): line is Extract<ChatLine, { kind: "notes" }> => line.kind === "notes" && line.at > asked && !/-t\d+$/.test(line.id) && quiet(line.at));
  const bad = notes.flatMap(line => { const found = noteFaults(line.text); return found.length ? [`at ${iso(line.at)} (${found.join(", ")}): "${clip(line.text)}"`] : []; });
  const written = notes.filter(line => line.full && noteFaults(line.full).length).length;
  add("b", ends.length < MIN_QUIET_TURNS && !bad.length ? null : !bad.length, bad.length ? bad.join("; ")
    : `${notes.length} closing texts after the question show one sentence of at most ${MAX_WORDS} words with no reminder; the chat wrote ${written} of them longer or with a reminder, which the page trimmed`);
  const sent = lines.filter((line): line is Extract<ChatLine, { kind: "agent" }> => line.kind === "agent" && line.at > asked);
  // A new question names its own new todo (run1's t3 at 01:08Z), so only a todo id an earlier message already named, or For you wording, reminds.
  const named = new Set<string>();
  const reasks = sent.filter(line => {
    const ids = line.text.match(TODO_IDS) ?? [];
    const again = ids.some(id => named.has(id)) || FOR_YOU.test(line.text);
    ids.forEach(id => named.add(id));
    return again;
  });
  add("c", !reasks.length, reasks.length ? reasks.map(line => `at ${iso(line.at)}: "${clip(line.text)}"`).join("; ")
    : `${sent.length} messages sent to him after the question, none a reminder of it`);
  const unread = unreadCount(messages, asked);
  add("d", unread === sent.length, `unread after the question reads ${unread}, and ${sent.length} messages were sent to him`);
  return checks;
}

async function judge(run: string, state: RunState): Promise<{ verdict: Verdict; text: string }> {
  const chat = state.chat.id;
  const file = sessionFile(chat);
  // Whole, since the first owner-style message lands just before windowStart and makes the first turn his (run2 read it as a quiet turn).
  const messages = file ? await messagesOf(file) : [];
  const boardFile = join(DATA, "boards", `${chat}.json`);
  const board = existsSync(boardFile) ? JSON.parse(readFileSync(boardFile, "utf8")) as ChatBoard : undefined;
  const asks = (board?.todos ?? []).filter(todo => (todo as { from?: string }).from === "agent").map(todo => Date.parse((todo as { at?: string }).at ?? ""))
    .filter(at => Number.isFinite(at) && at >= state.windowStart);
  // The board's todo time, else the session's own chat_board result, since teardown removes the todos and the archive holds no board.
  const added = messages.filter(message => message.role === "toolResult" && (message as { toolName?: string }).toolName === "chat_board" &&
    /Added a todo t\d+/.test(JSON.stringify(message.content))).map(message => message.timestamp ?? 0);
  const first = [...asks, ...added];
  const checks = await judgeLines(chatLines(messages), messages, first.length ? Math.min(...first) : undefined);
  const events = readSession(chat).filter(event => event.at >= state.windowStart);
  const typed = events.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !event.text.trimStart().startsWith("<") && !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))));
  // The chat's own duty jobs, the check-in among them, write to it as siblings (run1 read "check-in duty watch 07 54" as stepping in).
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
    `Criteria: ${join(run, "criteria.md")}. Evidence: the chat's session file, read the way the owner's feed shows it, and its board file.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}

export const quietWakes: Scenario = {
  name: "quiet-wakes",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
