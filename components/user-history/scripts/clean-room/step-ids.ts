import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatBoard } from "../../src/shared/types.ts";
import { readSession, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c145 (owner 10-19, msg mvfi1zgk: "메시지 보낼때 Plan, Duty id 좀 써 p684 이런 식으로"). A fresh chat gets one
 * ordinary task, and the judge reads its first tell_owner message: it names a plan step of the chat's own board by its bare id, outside code
 * and links, so the chat renders it as a chip. Hashes and session ids in that message are listed as a fault.
 */
export const TASK = "can you check which folders under ~/src take the most disk on this box and keep a short page with the top 5 and their sizes";
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 240): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
/** The text a chip can render from: code spans, code blocks and links out. */
const bare = (text: string): string => text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/\[[^\]]*\]\([^)]*\)/g, " ");
const HASH_OR_SESSION = /\b[0-9a-f]{7,40}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{14,}\b/gi;

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const events = readSession(chat).filter(event => event.at >= state.windowStart);
  const boardFile = join(DATA, "boards", `${chat}.json`);
  const board = existsSync(boardFile) ? JSON.parse(readFileSync(boardFile, "utf8")) as ChatBoard : undefined;
  const topP = board?.lastIds?.p ?? 0;
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });

  const told = events.flatMap(event => {
    if (event.kind !== "call" || event.tool !== "tell_owner") return [];
    const input = JSON.parse(event.input) as { text?: unknown };
    return typeof input.text === "string" ? [{ at: event.at, text: input.text }] : [];
  });
  const first = told[0];
  const ids = first ? [...bare(first.text).matchAll(/(?<![\w-])p(\d+)\b/g)].map(match => Number(match[1])).filter(n => n >= 1 && n <= topP) : [];
  add("a", first ? ids.length > 0 : null, first ? `first tell_owner at ${iso(first.at)} names ${ids.length ? ids.map(n => "p" + n).join(", ") : "no plan id of its board"} (board ids p1 to p${topP}): "${clip(first.text)}"`
    : "the chat has sent no tell_owner message yet");
  const leaks = first ? [...bare(first.text).matchAll(HASH_OR_SESSION)].map(match => match[0]).filter(word => /\d/.test(word) && /[a-f]/i.test(word)) : [];
  add("b", first ? leaks.length === 0 : null, first ? (leaks.length ? `the first message carries ${leaks.join(", ")}` : "no hash or session id in the first message") : "no message yet");

  const typed = events.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill"));
  const outside = events.filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling"));
  add("c", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map(event => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 120)}"`).join("; ")
    : "only the owner-style message, server notes and the chat's own jobs reached the chat");

  const verdict: Verdict = checks.find(check => check.id === "c")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the chat's session file and its board file.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}

export const stepIds: Scenario = {
  name: "step-ids",
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
