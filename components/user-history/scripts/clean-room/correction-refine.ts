import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSession, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c86 (owner 10-15: "one of your duty is these kind of requests when agent made mistake, is to write them down,
 * /refine the harness" and "this should also happen automagicallly") and c52 (answer in the first reply). A fresh chat gets an ordinary
 * question; once it has answered, the owner's second message corrects how it replies, and after the refinement a third asks a follow-up, so
 * a next turn's prompt exists. Nobody tells it to record or refine anything. The chat is in clean-room-chats.json, so its correction goes to
 * the scratch ledger and its refine stays in its session. The criteria live in the run folder's criteria.md.
 */
export const TASK = "look into how many of our chat turns waited in the pi-pool queue yesterday and how long the longest waits were. give me the 3 " +
  "biggest causes with numbers";
export const CORRECTION = "stop using bold in your replies, i read these on my phone and it's noisy";
export const FOLLOW_UP = "ok which of the 3 is the easiest to fix";
const KEY = /\bbold\b/i;
const HOME = homedir();
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(HOME, ".prime/agent/browser-chat");
const SESSIONS = join(HOME, ".prime/agent/sessions");

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 300): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
interface Check { id: string; ok: boolean | null; detail: string }
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
interface Ledger { corrections: { id: string; at: string; chat: { id: string }; words: string; rule: string; repeats: { at: string; chat: { id: string }; words: string }[] }[] }
const readLedger = (name: string): Ledger => existsSync(join(DATA, name)) ? JSON.parse(readFileSync(join(DATA, name), "utf8")) as Ledger : { corrections: [] };
const fromChat = (ledger: Ledger, chat: string) => ledger.corrections.flatMap(entry => [
  ...(entry.chat.id === chat ? [{ id: entry.id, at: Date.parse(entry.at), words: entry.words, rule: entry.rule }] : []),
  ...entry.repeats.filter(repeat => repeat.chat.id === chat).map(repeat => ({ id: entry.id, at: Date.parse(repeat.at), words: repeat.words, rule: entry.rule })),
]);
/** The refinement notices of a session file with the entries they saved, and the `/refine` commands the service sent. */
function refinements(chat: string): { at: number; head: string; text: string; ids: string[] }[] {
  const file = join(SESSIONS, `${chat}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap(line => {
    if (!line.includes("refinement_notice")) return [];
    const entry = JSON.parse(line) as { type: string; customType?: string; timestamp: string; content?: string; details?: { edits?: { id?: string }[] } };
    if (entry.type !== "custom_message" || entry.customType !== "refinement_notice") return [];
    const text = String(entry.content ?? "");
    return [{ at: Date.parse(entry.timestamp), head: /^\[[a-z]+-refinement\]/.exec(text)?.[0] ?? "", text, ids: (entry.details?.edits ?? []).flatMap(edit => edit.id ? [edit.id] : []) }];
  });
}
/** What the owner read first: the first tell_owner text after the task, else the turn's last text. */
function firstReply(chat: string, before: number): { at: number; text: string } | null {
  const events = readSession(chat).filter(event => event.at < before);
  const told = events.find(event => event.kind === "call" && event.tool === "tell_owner");
  if (told && told.kind === "call") return { at: told.at, text: String((JSON.parse(told.input) as { text?: string }).text ?? "") };
  const text = events.filter(event => event.kind === "assistant").at(-1);
  return text && text.kind === "assistant" ? { at: text.at, text: text.text } : null;
}

export const correctionRefine: Scenario = {
  name: "correction-refine",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    "`clean-room.ts say` sends the owner's later messages through POST api/threads/<id>/prompt, the composer's route: the correction after the first turn ends, the follow-up after the refinement.", "",
    "## The messages", "", `> ${TASK}`, "", `> ${CORRECTION}`, "", `> ${FOLLOW_UP}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const events = readSession(chat);
  const said = events.find(event => event.kind === "text" && event.role === "user" && event.text.includes(CORRECTION));
  const checks: Check[] = [];

  const reply = firstReply(chat, said?.at ?? Infinity);
  const numbers = reply ? (reply.text.match(/\d[\d,.]*/g) ?? []).length : 0;
  const deferred = reply ? /\b(don'?t|do not) have\b[^.]*\b(numbers?|yet)\b|\bnot (measured|ready) yet\b|\bwhen it finishes\b/i.test(reply.text) : false;
  checks.push({ id: "e", ok: reply ? numbers >= 2 && !deferred : null, detail: reply ? `${iso(reply.at)}, ${numbers} numbers${deferred ? ", defers the answer to a job" : ""}: "${clip(reply.text, 500)}"` : "no reply yet" });

  const scratch = fromChat(readLedger("corrections.clean-room.json"), chat).filter(item => said && item.at >= said.at);
  const real = fromChat(readLedger("corrections.json"), chat);
  checks.push({ id: "a", ok: said ? scratch.length > 0 && real.length === 0 : null, detail: !said ? "the correction has not been sent yet"
    : `scratch ledger: ${scratch.map(item => `${item.id} at ${iso(item.at)} "${clip(item.words, 120)}", rule "${clip(item.rule, 160)}"`).join("; ") || "nothing from this chat"}; ` +
      `real ledger: ${real.length ? real.map(item => `${item.id} "${clip(item.words, 80)}"`).join("; ") : "nothing from this chat"}` });

  const since = scratch.length ? Math.min(...scratch.map(item => item.at)) : Infinity;
  const aimed = refinements(chat).filter(notice => notice.at >= since && KEY.test(notice.text));
  const command = events.find(event => event.kind === "text" && event.customType === "session_slash_command" && event.at >= since && event.text.startsWith("/refine"));
  checks.push({ id: "b", ok: scratch.length ? aimed.length > 0 : null, detail: !scratch.length ? "nothing recorded yet" : aimed.length
    ? aimed.map(notice => `${iso(notice.at)} ${notice.head} saved ${notice.ids.join(", ") || "no id"}: "${clip(notice.text, 300)}"`).join("; ") +
      `; the service's command: ${command && command.kind === "text" ? `${iso(command.at)} "${clip(command.text, 200)}"` : "none seen"}`
    : `no refinement notice about bold after ${iso(since)}` });

  const prompts = join(run, "prompts", chat);
  const after = aimed.length ? Math.min(...aimed.map(notice => notice.at)) : Infinity;
  const ids = aimed.flatMap(notice => notice.ids);
  const shows = (existsSync(prompts) ? readdirSync(prompts).sort() : []).flatMap(file => {
    const capture = JSON.parse(readFileSync(join(prompts, file), "utf8")) as { capturedAt: string; payload: unknown };
    if (Date.parse(capture.capturedAt) <= after) return [];
    const text = JSON.stringify(capture.payload);
    const named = ids.filter(id => text.includes(id));
    return named.length ? [`${capture.capturedAt} names ${named.join(", ")}`] : [];
  });
  checks.push({ id: "c", ok: aimed.length ? (shows.length ? true : null) : null, detail: !aimed.length ? "no aimed refinement yet" : shows.length ? shows.join("; ") : "no Prompt view capture after the refinement names it yet" });

  const typed = events.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") && !state.seeds.some(seed => event.text.includes(seed)));
  const outside = events.filter(event => event.kind === "text" && event.customType === "agent_message" && event.relation !== "child");
  checks.push({ id: "d", ok: typed.length === 0 && outside.length === 0, detail: typed.length || outside.length
    ? [...typed.map(event => `typed at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 120)}"`), ...outside.map(event => `message from ${event.kind === "text" ? event.from : ""}`)].join("; ")
    : "only the owner-style messages, server notes and the chat's own jobs reached the chat" });

  const verdict: Verdict = checks.find(check => check.id === "d")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail" : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the chat's session file, ${join(DATA, "corrections.clean-room.json")}, ${join(DATA, "corrections.json")} and ${prompts}.`, "",
    "## Verdict per criterion", "", ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}
