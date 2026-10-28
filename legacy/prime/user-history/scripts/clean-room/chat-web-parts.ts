import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { family, ownJob } from "./answer-data.ts";
import { rawEntries } from "./detached-report.ts";
import { readSession, readSessionFile, type RunState, type Scenario, type SessionEvent, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for c78 outside the 5180 demo (owner, 10-15: "PLEASE FOR THE LOVE OF GOD USE CONSISTENT COMPONENTS", and 10-22: "in
 * general i hate to see agent inventing the design system from scratch whenever making new view"). Until 10-28 a job got the rule in its
 * [corrections] block only when its brief named 5180, 5174, virev-demo or $lib/ui, so a job building a page of sieun-pi's chat web client
 * got nothing unless its chat wrote "(c78)" itself. A fresh chat gets an ordinary ask for a filter row with tabs and a search box on that
 * client's Agents page. It passes once a brief of the chat or its jobs names the client's lib/ui, or a job's [corrections] block carries the
 * c78 chat web line, and fails when a job started with neither. The run ends at its first verdict, so teardown stops the builders before
 * they write much. The criteria live in ~/.prime/agent/clean-room/c78-chat-web-parts/criteria.md.
 */
export const TASK = "the agents page in the new chat app needs a filter row on top. tabs for running, idle and done, plus a search box. keep it looking like the rest of the app";
const SPAWN = /rlm\.(?:spawn|create_session)\s*\(/;
/** A brief that names the chat web client's shared parts. */
export const NAMES_PARTS = /(?:web\/src\/|\$)lib\/ui\b|lib\/ui\/README/i;
/** The c78 chat web line the chat service puts in a job's [corrections] block (chat-corrections.ts CHAT_WEB_RULE_LINE). */
export const PARTS_LINE = /^- c78 .*apps\/chat\/web\/src\/lib\/ui/m;

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > length ? flat.slice(0, length - 1) + "\u2026" : flat; };
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";

export function judge(run: string, state: RunState, now = Date.now()): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const ended = now >= (state.until ?? Infinity);
  const members = family(run, chat);
  const sessions = members.map(({ id, file }) => ({ id, file, events: (file ? readSessionFile(file) : readSession(id, [chat])).filter(event => event.at >= state.windowStart) }));
  const all = sessions.flatMap(session => session.events.map(event => ({ session: session.id, event }))).sort((a, b) => a.event.at - b.event.at);
  const calls = all.filter((entry): entry is { session: string; event: Extract<SessionEvent, { kind: "call" }> } => entry.event.kind === "call");
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });

  const briefs = calls.filter(({ event }) => SPAWN.test(event.input)).map(({ session, event }) => ({ session, at: event.at, text: event.input }));
  const naming = briefs.filter(brief => NAMES_PARTS.test(brief.text));
  const jobs = sessions.filter(session => session.id !== chat && session.file);
  const blocks = jobs.map(job => ({ id: job.id, texts: rawEntries(job.file).map(entry => entry.text).filter(text => text.includes("[corrections]")) }));
  const lined = blocks.filter(job => job.texts.some(text => PARTS_LINE.test(text)));
  const started = blocks.filter(job => job.texts.length > 0);
  const met = naming.length > 0 || lined.length > 0;
  add("a", met ? true : started.length || ended ? false : null, met
    ? [...naming.slice(0, 1).map(brief => `${brief.session.slice(0, 8)} at ${iso(brief.at)} names lib/ui: "${clip(brief.text, 400)}"`),
      ...lined.slice(0, 1).map(job => `job ${job.id.slice(0, 8)}'s [corrections] block carries the c78 chat web line`)].join("; ")
    : started.length ? `${started.length} jobs started, and neither their briefs nor their [corrections] blocks name apps/chat/web/src/lib/ui; first brief: "${clip(briefs[0]?.text ?? "", 400)}"`
      : `${briefs.length} briefs so far and no job has started`);

  const head = sessions.find(session => session.id === chat);
  const typed = (head?.events ?? []).filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") &&
    !state.seeds.some(seed => event.text.includes(seed.slice(0, 60))) && !event.text.includes("<skill") && event.text.trim() !== TASK);
  const asked = new Map<string, number>();
  for (const event of head?.events ?? []) if (event.kind === "sent" && !asked.has(event.to)) asked.set(event.to, event.at);
  const outside = (head?.events ?? []).filter(event => event.kind === "text" && event.role === "custom" && (event.relation === "parent" || event.relation === "sibling") &&
    !ownJob(state.chat.name, event) && !(event.fromId && (asked.get(event.fromId) ?? Infinity) < event.at));
  add("b", typed.length === 0 && outside.length === 0, typed.length || outside.length
    ? [...typed, ...outside].map(event => `at ${iso(event.at)}: "${clip(event.kind === "text" ? event.text : "", 160)}"`).join("; ")
    : "only the owner-style message, server notes, the chat's own jobs and replies to its own asks reached the chat");

  const turns = all.filter(({ event }) => event.kind === "assistant" || event.kind === "call");
  add("c", turns.length ? true : ended ? false : null, turns.length
    ? `${turns.length} model turns and calls in ${new Set(turns.map(turn => turn.session)).size} sessions; first at ${iso(turns[0]!.event.at)}`
    : "no session of the chat took a model turn in the window");

  const of = (id: string) => checks.find(check => check.id === id)!.ok;
  const verdict: Verdict = of("b") === false || of("c") === false ? "void"
    : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(now)}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the session files of the chat and its ${sessions.length - 1} jobs and subagents.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
    "## Every brief", "", ...briefs.map(brief => `- ${brief.session.slice(0, 8)} at ${iso(brief.at)}: "${clip(brief.text, 600)}"`), "",
    "## Every job's [corrections] block", "", ...blocks.map(job => `- ${job.id.slice(0, 8)}: ${job.texts.length ? `"${clip(job.texts.at(-1)!, 900)}"` : "none yet"}`), "",
  ].join("\n");
  return { verdict, text };
}

export const chatWebParts: Scenario = {
  name: "chat-web-parts",
  headMessage: () => TASK,
  fixtures: [],
  endsAtVerdict: true,
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
