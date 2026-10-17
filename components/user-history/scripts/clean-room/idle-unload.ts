import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSession, readSessionFile, sessionFiles, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for the idle unload of subagents (src/idle-unload.ts). At 21:33Z on 10-17, 57 idle subagents stayed resident with a
 * Python kernel each inside trees that still ran, because Prime's child passivation sweep timed out and the unload stopped only roots. A fresh
 * chat gets one ordinary task that a job does. The run passes when every job of the chat and then the chat itself stop holding a worker on
 * their own once idle, with nobody stepping in. The criteria live in the run folder's criteria.md.
 */
export const TASK = "have a job count how many SKILL.md files the skills folder has and how many of those skills also have a references folder. give me both numbers";
const HOME = homedir();
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(HOME, ".prime/agent/browser-chat");
const DAEMON_LOG = join(HOME, ".prime/agent/logs/daemon.sock.bab13329.log");
/** One sweep minute of the unload plus one of the daemon's list refresh, on top of idleEvictionMinutes. */
const SLACK_MS = 3 * 60_000;

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 300): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
interface Check { id: string; ok: boolean | null; detail: string }
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";

interface Row { sessionId: string; sessionName?: string; activeSessionId?: string; parentSessionId?: string; lifecycle?: string }
function daemonRows(): Row[] {
  const out = execFileSync("prime-agent", ["sessions", "--all", "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return (JSON.parse(out) as { sessions: Row[] }).sessions;
}
function idleMinutes(): number | "off" {
  try {
    const value = (JSON.parse(readFileSync(join(HOME, ".prime/agent/settings.json"), "utf8")) as { idleEvictionMinutes?: unknown }).idleEvictionMinutes;
    return typeof value === "number" ? value : "off";
  } catch { return "off"; }
}
/** Timestamped lines of a log after `since`, by the ISO time each line starts with or carries in brackets. */
function linesAfter(file: string, since: number): { at: number; line: string }[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap(line => {
    const at = Date.parse(/^\[?(\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(line)?.[1] ?? "");
    return at >= since ? [{ at, line }] : [];
  });
}

export const idleUnload: Scenario = {
  name: "idle-unload",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`, "",
    "## The message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

function judge(_run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const checks: Check[] = [];
  const events = readSession(chat);
  const files = sessionFiles(chat).filter(file => !file.endsWith(`${chat}.jsonl`));
  const jobs = files.map(file => {
    const own = readSessionFile(file);
    return { id: file.split("/").at(-1)!.replace(/\.jsonl$/, ""), file, last: Math.max(0, ...own.map(event => event.at)), reported: own.some(event => event.kind === "call" && /receiver_role\s*=\s*['"]parent/.test(event.input)) };
  });
  const answer = events.filter(event => event.kind === "assistant" && /\d/.test(event.text)).at(-1);
  checks.push({ id: "a", ok: jobs.some(job => job.reported) && answer ? true : null,
    detail: `${jobs.length} job sessions, ${jobs.filter(job => job.reported).length} reported to the chat; the chat's last answer with a number: ${answer ? `${iso(answer.at)} "${clip(answer.text, 300)}"` : "none yet"}` });

  const minutes = idleMinutes();
  const rows = daemonRows();
  const byId = new Map(rows.map(row => [row.sessionId, row] as const));
  const passivated = linesAfter(DAEMON_LOG, state.windowStart).filter(entry => /Passivated idle child|Evicted idle worker/.test(entry.line));
  const unloads = linesAfter(join(DATA, "service.log"), state.windowStart).filter(entry => entry.line.includes("idle unload: stopped"));
  const names = new Map(jobs.map(job => [job.id, byId.get(job.id)?.sessionName ?? ""] as const));
  const jobLines = jobs.map(job => {
    const row = byId.get(job.id);
    const name = names.get(job.id) ?? "";
    const evidence = [...passivated.filter(entry => entry.line.includes(job.id)), ...unloads.filter(entry => name && entry.line.includes(name) && entry.at >= job.last)].sort((x, y) => x.at - y.at)[0];
    const resident = row?.activeSessionId !== undefined;
    const late = evidence && minutes !== "off" ? evidence.at - job.last > minutes * 60_000 + SLACK_MS : false;
    return { ok: resident ? null : !late, text: `${name || job.id}: last event ${iso(job.last)}, ${resident ? "still resident" : `not resident (${row?.lifecycle ?? "not listed"})`}` +
      `${evidence ? `; ${clip(evidence.line, 200)} after ${Math.round((evidence.at - job.last) / 60_000)} min` : "; no unload line, so the chat's job cleanup deleted it or Prime evicted its tree"}` };
  });
  checks.push({ id: "b", ok: jobs.length === 0 ? null : jobLines.some(line => line.ok === false) ? false : jobLines.every(line => line.ok === true) ? true : null,
    detail: `idleEvictionMinutes ${minutes}; ${jobLines.map(line => line.text).join("; ") || "no job yet"}` });

  const chatRow = byId.get(chat);
  const lastChat = Math.max(0, ...events.map(event => event.at));
  checks.push({ id: "c", ok: chatRow?.activeSessionId === undefined ? true : null,
    detail: `the chat's last event ${iso(lastChat)}; its session is ${chatRow?.activeSessionId === undefined ? `not resident (${chatRow?.lifecycle ?? "not listed"})` : "still resident"}` });

  const tree = new Set([chat, ...jobs.map(job => job.id)]);
  const seeds = new Set(state.seeds);
  const owner = events.filter(event => event.kind === "text" && event.role === "user" && event.at >= state.windowStart && !seeds.has(event.text.trim()) && !event.text.startsWith("[")).map(event => event.kind === "text" ? event.text : "");
  const outside = [chat, ...jobs.map(job => job.id)].flatMap(id => (id === chat ? events : readSessionFile(jobs.find(job => job.id === id)!.file))
    .filter(event => event.kind === "text" && event.customType === "agent_message" && event.fromId !== undefined && !tree.has(event.fromId)).map(event => `${event.kind === "text" ? event.from : ""} to ${id}`));
  checks.push({ id: "d", ok: owner.length === 0 && outside.length === 0,
    detail: `${owner.length} user messages beyond the seed${owner.length ? `: ${owner.map(text => clip(text, 120)).join("; ")}` : ""}; ${outside.length} agent messages from outside the chat's tree${outside.length ? `: ${outside.join("; ")}` : ""}` });

  const verdict: Verdict = checks.some(check => check.id === "d" && check.ok === false) ? "void" : checks.some(check => check.ok === false) ? "fail" : checks.every(check => check.ok === true) ? "pass" : "open";
  const text = [`# idle-unload ${verdict}: ${state.chat.name}`, "", `Chat ${chat} on ${state.release}, judged ${iso(Date.now())}.`, "",
    ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), ""].join("\n");
  return { verdict, text };
}
