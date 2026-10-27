import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatBoard, PlanItem } from "../../src/shared/types.ts";
import { readSession, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for an ordinary day after the 10-18 bloat cut (owner: "is sieun-pi bloated?", "Push hard on removing junk"). A fresh
 * chat gets one owner-style task that needs a job, a board step and a question to the owner, and the judge checks that each of those works
 * with nobody stepping in. The criteria live in the run folder's criteria.md.
 */
export const TASK = "look at what our sieun-pi duties did over the last 3 days, which ones keep failing or flagging, and make me a page with " +
  "the list and how often each one failed. if you think any should be turned off ask me first";
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const steps = (items: readonly PlanItem[]): PlanItem[] => items.flatMap(item => [item, ...steps(item.children)]);

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const events = readSession(chat).filter(event => event.at >= state.windowStart);
  const boardFile = join(DATA, "boards", `${chat}.json`);
  const board = existsSync(boardFile) ? JSON.parse(readFileSync(boardFile, "utf8")) as ChatBoard : undefined;
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });

  const reports = events.filter(event => event.kind === "text" && event.role === "custom" && event.relation === "child");
  add("a", reports.length ? true : null, reports.length && reports[0]!.kind === "text"
    ? `${reports.length} job messages; first at ${iso(reports[0]!.at)} from ${reports[0]!.from ?? "?"}: "${clip(reports[0]!.text)}"` : "no job has messaged the chat yet");

  const owned = steps(board?.plan ?? []).filter(step => step.job || step.sessionId);
  const done = owned.filter(step => step.status === "done");
  add("b", done.length ? true : null, owned.length
    ? owned.map(step => `"${clip(step.text, 80)}" ${step.status} (job ${step.job ?? step.sessionId})`).join("; ") : "no board step names a job yet");

  const asks = (board?.todos ?? []).filter(todo => (todo as { from?: string }).from === "agent" && Date.parse((todo as { at?: string }).at ?? "") >= state.windowStart);
  add("c", asks.length ? true : null, asks.length ? asks.map(todo => `"${clip(todo.text, 160)}"`).join("; ") : "no For you todo from the chat yet");

  const told = events.filter(event => event.kind === "call" && event.tool === "tell_owner").length;
  add("d", told ? true : null, `${told} tell_owner calls`);

  const typed = events.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill"));
  const outside = events.filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling"));
  add("e", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map(event => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 120)}"`).join("; ")
    : "only the owner-style message, server notes and the chat's own jobs reached the chat");

  const verdict: Verdict = checks.find(check => check.id === "e")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the chat's session file and its board file.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}

export const everydayTask: Scenario = {
  name: "everyday-task",
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
