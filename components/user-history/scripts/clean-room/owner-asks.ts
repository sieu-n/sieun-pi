import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chatEntries } from "./chat-tools-reopen.ts";
import type { RunState, Scenario, Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c96 and c97 (owner 10-18: "i feel like Ai chat isn't asking me for much clarifications. like after request it's
 * TOTALLY OK OR ACTUALLY DESIRABLE to relay the question to me as a chat message + For you", "also you can print diagrams, kinda long messages,
 * split 2+ messages like actual person", and "also is this a hard cap (code-level) or something? if so strip all these"). A fresh chat gets a
 * vague request in the owner's style. Once it has asked, `clean-room.ts say` sends FOLLOW_UP, which asks for a diagram and a long list in
 * separate messages. The criteria live in the run folder's criteria.md.
 */
export const TASK = "make me a page about where our CI time goes, something i can share w the team";
export const FOLLOW_UP = "ok go with your picks. send me a diagram of the flow first, then a separate msg with the full list of what eats the time, " +
  "start it with \"Steps:\" and go long, like 100+ words";
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const LABEL = /^\s*[\p{L}\p{N}][^\s:]*(?:\s+[^\s:]+){0,2}:/u;
const MERMAID = /```mermaid\n/;

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const wordCount = (text: string): number => text.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";

interface Told { at: number; line: number; text: string; ok: boolean | null; error: string }

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const entries = chatEntries(chat).filter(entry => entry.at >= state.windowStart);
  const told: Told[] = [];
  for (const entry of entries) {
    if (entry.role !== "assistant") continue;
    const raw = readFileSync(join(homedir(), ".prime/agent/sessions", `${chat}.jsonl`), "utf8").split("\n")[entry.line] ?? "";
    let content: { type?: string; id?: string; name?: string; arguments?: { text?: unknown } }[] = [];
    try { content = (JSON.parse(raw) as { message?: { content?: typeof content } }).message?.content ?? []; } catch { continue; }
    for (const part of content) {
      if (part.type !== "toolCall" || part.name !== "tell_owner") continue;
      const result = entries.find(other => other.result?.id === part.id);
      told.push({ at: entry.at, line: entry.line, text: typeof part.arguments?.text === "string" ? part.arguments.text : "",
        ok: result ? !result.result!.error : null, error: result?.result?.error ? clip(result.text) : "" });
    }
  }
  const followAt = entries.find(entry => entry.role === "user" && entry.text.includes(FOLLOW_UP))?.at;
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });

  const before = told.filter(said => followAt === undefined || said.at < followAt);
  const asked = before.filter(said => said.ok && said.text.includes("?"));
  add("a", asked.length ? true : followAt !== undefined ? false : null, asked.length
    ? `asked at ${iso(asked[0]!.at)}: "${clip(asked[0]!.text, 300)}"` : `no question in ${before.length} tell_owner calls before the follow-up`);

  const boardFile = join(DATA, "boards", `${chat}.json`);
  const todos = existsSync(boardFile) ? ((JSON.parse(readFileSync(boardFile, "utf8")) as { todos?: { text: string; from?: string; at?: string; choices?: string[] }[] }).todos ?? []) : [];
  const asks = todos.filter(todo => todo.from === "agent" && Date.parse(todo.at ?? "") >= state.windowStart && (followAt === undefined || Date.parse(todo.at ?? "") < followAt));
  add("b", asks.length ? true : followAt !== undefined ? false : null, asks.length
    ? asks.map(todo => `"${clip(todo.text, 160)}"${todo.choices?.length ? ` with choices ${todo.choices.map(choice => `"${choice}"`).join(" / ")}` : ""}`).join("; ")
    : "no For you todo from the chat before the follow-up");

  const after = followAt === undefined ? [] : told.filter(said => said.at >= followAt);
  const diagram = after.find(said => said.ok && MERMAID.test(said.text));
  add("c", diagram ? true : null, diagram ? `${iso(diagram.at)}: "${clip(diagram.text, 200)}"` : followAt === undefined ? "the follow-up is not sent yet" : "no accepted tell_owner with a mermaid block yet");

  const byMessage = new Map<number, Told[]>();
  for (const said of told.filter(said => said.ok)) {
    const turn = entries.filter(entry => entry.role === "user" && entry.at <= said.at).at(-1)?.at ?? 0;
    byMessage.set(turn, [...byMessage.get(turn) ?? [], said]);
  }
  const split = [...byMessage.entries()].find(([, list]) => list.length >= 2);
  add("d", split ? true : null, split ? `${split[1].length} accepted tell_owner calls answer the owner message at ${iso(split[0])}` : "no owner message got 2 accepted tell_owner calls yet");

  const labeled = told.find(said => said.ok && LABEL.test(said.text) && wordCount(said.text) >= 100);
  add("e", labeled ? true : null, labeled ? `${iso(labeled.at)}, ${wordCount(labeled.text)} words: "${clip(labeled.text, 200)}"` : "no accepted reply with a label opener and 100 words yet");

  const refused = told.filter(said => said.ok === false);
  add("f", refused.length ? false : told.length ? true : null, refused.length ? refused.map(said => `${iso(said.at)} refused: ${said.error}`).join("; ") : `${told.length} tell_owner calls, none refused`);

  const typed = entries.filter(entry => entry.role === "user" && !entry.text.trimStart().startsWith("[") && !state.seeds.some(seed => entry.text.includes(seed.slice(0, 60))) && !entry.text.includes("<skill"));
  const outside = entries.filter(entry => entry.customType === "agent_message" && /from (?:sibling|parent)/.test(entry.text));
  add("g", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed.map(entry => `typed at ${iso(entry.at)}: "${clip(entry.text, 120)}"`), ...outside.map(entry => `message at ${iso(entry.at)}: "${clip(entry.text, 120)}"`)].join("; ")
    : "only the two owner-style messages, server notes and the chat's own jobs reached the chat");

  const verdict: Verdict = checks.find(check => check.id === "g")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail" : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the chat's session file and its board file.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}

export const ownerAsks: Scenario = {
  name: "owner-asks",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one vague owner-style first message and no seeded board, todo or fixture.`,
    "Once it has asked, `clean-room.ts say` sends the follow-up.", "",
    "## The first message", "", `> ${TASK}`, "", "## The follow-up", "", `> ${FOLLOW_UP}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
