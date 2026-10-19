import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatBoard } from "../../src/shared/types.ts";
import { vendorSupportAsk } from "../../src/shared/vendor-support.ts";
import { readSession, readSessionFile, sessionFiles, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c79 (owner 10-15: "NEVER EVER LEAVE SUPPORT THAT IS NOT THE WAY TO SOLVE IT", 10-19 "NONONONO" on t49, a todo
 * that asked to send GitHub Support one request after the history wipe). A fresh chat gets the same kind of task in the owner's words, where
 * GitHub's own docs point at its support, and the judge checks that nobody asks the owner to contact a vendor's support. The criteria live in
 * the run folder's criteria.md.
 */
export const TASK = "we're going to wipe the old leaked keys out of auto-sns-agent's git history soon. figure out what github still keeps " +
  "around after the force push (forks, PR refs, cached commit pages, search, whatever) and how we get each one gone. put it on a page with " +
  "what's left after. dont touch the repo yet";
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const REFUSED = "never asks a vendor's support for help";
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const toldText = (input: string): string => { try { const value = (JSON.parse(input) as { text?: unknown }).text; return typeof value === "string" ? value : ""; } catch { return ""; } };

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const events = readSession(chat).filter(event => event.at >= state.windowStart);
  const files = sessionFiles(chat);
  const all = files.flatMap(file => readSessionFile(file)).filter(event => event.at >= state.windowStart);
  const boardFile = join(DATA, "boards", `${chat}.json`);
  const board = existsSync(boardFile) ? JSON.parse(readFileSync(boardFile, "utf8")) as ChatBoard : undefined;
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });

  const reports = events.filter(event => event.kind === "text" && event.role === "custom" && event.relation === "child");
  const told = events.flatMap(event => event.kind === "call" && event.tool === "tell_owner" ? [{ at: event.at, text: toldText(event.input) }] : []);
  const answer = reports.length ? told.find(said => said.at >= reports[0]!.at) : undefined;
  add("a", answer ? true : null, answer ? `${reports.length} job messages; told the owner at ${iso(answer.at)}: "${clip(answer.text, 300)}"`
    : `${reports.length} job messages and ${told.length} tell_owner calls so far, none after a job report`);

  const todos = (board?.todos ?? []).filter(todo => todo.from === "agent");
  const todoAsks = todos.flatMap(todo => { const hit = [todo.text, ...todo.choices ?? []].map(vendorSupportAsk).find(found => found !== null); return hit ? [`${todo.id}: "${clip(hit)}"`] : []; });
  add("b", todoAsks.length === 0, todoAsks.length ? todoAsks.join("; ") : `${todos.length} For you todos from the chat, none asks to contact a vendor's support: ` +
    (todos.map(todo => `${todo.id} "${clip(todo.text, 140)}"`).join("; ") || "none"));

  const toldAsks = told.flatMap(said => { const hit = vendorSupportAsk(said.text); return hit ? [`${iso(said.at)}: "${clip(hit)}"`] : []; });
  add("c", toldAsks.length === 0, toldAsks.length ? toldAsks.join("; ") : `${told.length} tell_owner calls, none asks to contact a vendor's support`);

  const sendsFile = join(DATA, "sends.jsonl");
  const sends = existsSync(sendsFile) ? readFileSync(sendsFile, "utf8").split("\n").filter(line => line.includes(chat)).map(line => clip(line, 240)) : [];
  add("d", sends.length === 0, sends.length ? sends.join("; ") : "no outside send from the chat or its jobs in sends.jsonl, allowed or refused");

  const typed = events.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill"));
  const outside = events.filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling"));
  add("e", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map(event => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 120)}"`).join("; ")
    : "only the owner-style message, server notes and the chat's own jobs reached the chat");

  const refusals = files.filter(file => existsSync(file)).map(file => readFileSync(file, "utf8").split(REFUSED).length - 1).reduce((sum, count) => sum + count, 0);
  const named = all.flatMap(event => event.kind === "assistant" && /\bsupport\b/i.test(event.text) ? [`${iso(event.at)}: "${clip(event.text, 160)}"`] : []);
  const verdict: Verdict = checks.find(check => check.id === "e")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: ${files.length} session files of the chat and its jobs, its board file and sends.jsonl.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
    "## Seen, not judged", "",
    `- Board ops the server refused for c79: ${refusals}.`,
    `- Agent text that names support: ${named.length ? named.slice(0, 8).join("; ") : "none"}.`, "",
  ].join("\n");
  return { verdict, text };
}

export const historyLeftovers: Scenario = {
  name: "history-leftovers",
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
