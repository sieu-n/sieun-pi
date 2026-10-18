import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_IN_PREFIX, JOB_NOTICE_PREFIX } from "../../src/shared/chat-feed.ts";
import { readSession, readSessionFile, sessionFiles, type RunState, type Scenario, type SessionEvent, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for a job that ends its turn on a board.wake. Ops guy 10-18: crawler prod alerts was told "ended, and these open
 * steps name it" at 01:14Z and 01:17Z while its subagents slept on board.wakes for their CI runs, and the AI harness chat got "ended with no
 * report" lines and check-in nudges for jobs asleep on their run wakes. A fresh chat gets one ordinary task a job does by waiting. The run
 * passes when a job sets a board.wake and ends its turn, and no stopped notice or nudge reaches the chat or the job until the wake fires and
 * the job reports, with nobody stepping in. The criteria live in the run folder's criteria.md.
 */
export const TASK = "have a job note how much free disk space this mac has now, check again 25 minutes later, and tell me how much it changed";
const WAKE_CALL = /\bboard\.wake\s*\(/;
const STOPPED = /\bended\b|\bopen steps? names?\b|\bwas cancelled\b|\bfailed\b|\bsent no report\b/;
const PUSHED = /^(?:\[check-in\] )?The check-in (?:is checking on you|restarted you)/;

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 300): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
interface Check { id: string; ok: boolean | null; detail: string }
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
interface Agent { sessionId?: string; name: string; state: string; wait?: string }

/** Each job session under the chat: its id, its file, the name its messages to the chat carry, and its events. */
function jobsOf(chat: string): { id: string; name: string; events: SessionEvent[] }[] {
  return sessionFiles(chat).filter(file => !file.endsWith(`${chat}.jsonl`) && /\/[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/.test(file)).map(file => {
    const id = file.split("/").at(-1)!.replace(/\.jsonl$/, "");
    const meta = join(file, "..", "rlm-subagent.json");
    const name = existsSync(meta) ? String((JSON.parse(readFileSync(meta, "utf8")) as { sessionName?: unknown }).sessionName ?? "") : "";
    return { id, name, events: readSessionFile(file) };
  });
}

/** The job rows the collector saved while a job waited, with their wait words. */
function waitRows(run: string, id: string, from: number, to: number): { at: number; wait?: string }[] {
  const dir = join(run, "agents");
  return (existsSync(dir) ? readdirSync(dir).sort() : []).flatMap(file => {
    const at = Number(file.replace(".json", ""));
    if (!(at >= from && at <= to)) return [];
    const agent = (JSON.parse(readFileSync(join(dir, file), "utf8")) as Agent[]).find(row => row.sessionId === id);
    return agent ? [{ at, ...(agent.wait ? { wait: agent.wait } : {}) }] : [];
  });
}

export const wakeLive: Scenario = {
  name: "wake-live",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    `Its check-in runs every ${state.everyMs / 60_000} min, so check-ins fall inside the job's wait.`, "",
    "## The message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const events = readSession(chat).filter(event => event.at >= state.windowStart);
  const checks: Check[] = [];
  const waits = jobsOf(chat).flatMap(job => {
    const call = job.events.find(event => event.kind === "call" && WAKE_CALL.test(event.input));
    if (!call) return [];
    const fired = job.events.find(event => event.kind === "text" && event.at > call.at && /(?:^|\n)\[wake\] /.test(event.text));
    const between = job.events.filter(event => event.at > call.at + 60_000 && (!fired || event.at < fired.at) && (event.kind === "assistant" || event.kind === "call"));
    const report = fired ? events.find(event => event.kind === "text" && event.customType === "agent_message" && event.fromId === job.id && event.at > fired.at) : undefined;
    return [{ job, set: call.at, fired: fired?.at, ended: between.length === 0, report }];
  });
  const wait = waits[0];
  checks.push({ id: "a", ok: wait ? wait.ended : null,
    detail: wait ? `job ${wait.job.name || wait.job.id} called board.wake at ${iso(wait.set)}; ${wait.ended ? "it did nothing more until the wake" : "it kept working after the call"}` : "no job has called board.wake yet" });
  checks.push({ id: "b", ok: wait?.fired !== undefined ? true : null, detail: wait?.fired !== undefined ? `the wake reached the job at ${iso(wait.fired)}` : "the wake has not fired yet" });
  checks.push({ id: "c", ok: wait?.report ? true : null,
    detail: wait?.report ? `the job reported at ${iso(wait.report.at)}: "${clip(wait.report.kind === "text" ? wait.report.text : "", 240)}"` : "no report after the wake yet" });

  const until = wait?.report?.at ?? Date.now();
  const told = wait ? events.filter(event => event.kind === "text" && event.role === "user" && event.at > wait.set && event.at <= until &&
    ((event.text.startsWith(JOB_NOTICE_PREFIX) && event.text.includes(wait.job.name) && STOPPED.test(event.text)) ||
      (event.text.startsWith(CHECK_IN_PREFIX) && event.text.includes(wait.job.name) && /\b(nudged|restarted)\b/.test(event.text)))) : [];
  const pushed = wait ? wait.job.events.filter(event => event.kind === "text" && event.role === "user" && event.at > wait.set && event.at <= until && PUSHED.test(event.text)) : [];
  checks.push({ id: "d", ok: !wait ? null : told.length || pushed.length ? false : wait.report ? true : null,
    detail: `${told.length} stopped notices or nudge lines to the chat and ${pushed.length} check-in pushes to the job between the wake call and the report` +
      [...told, ...pushed].map(event => `\n    - ${iso(event.at)} "${clip(event.kind === "text" ? event.text : "", 240)}"`).join("") });

  const rows = wait ? waitRows(run, wait.job.id, wait.set + 60_000, wait.fired ?? Date.now()) : [];
  checks.push({ id: "e", ok: !rows.length ? null : rows.some(row => row.wait),
    detail: `${rows.length} saved job rows while it waited; ${rows.filter(row => row.wait).length} showed the wait${rows.find(row => row.wait) ? `, such as "${rows.find(row => row.wait)!.wait}"` : ""}` });

  // The chat's check-in duty jobs run on the server's clock and are part of the system, not someone stepping in.
  const runsFile = join(run, "runs.jsonl");
  const duty = (existsSync(runsFile) ? readFileSync(runsFile, "utf8").split("\n").filter(line => line.trim()) : [])
    .flatMap(line => { const job = (JSON.parse(line) as { job?: { id?: string } }).job; return job?.id ? [job.id] : []; });
  const tree = new Set([chat, ...jobsOf(chat).map(job => job.id), ...duty]);
  const seeds = new Set(state.seeds);
  const owner = events.filter(event => event.kind === "text" && event.role === "user" && !seeds.has(event.text.trim()) && !event.text.startsWith("[")).map(event => event.kind === "text" ? event.text : "");
  const outside = events.filter(event => event.kind === "text" && event.customType === "agent_message" && event.fromId !== undefined && !tree.has(event.fromId));
  checks.push({ id: "f", ok: owner.length === 0 && outside.length === 0,
    detail: `${owner.length} user messages beyond the seed${owner.length ? `: ${owner.map(text => clip(text, 120)).join("; ")}` : ""}; ${outside.length} agent messages from outside the chat's tree` });

  const verdict: Verdict = checks.some(check => check.id === "f" && check.ok === false) ? "void" : checks.some(check => check.ok === false) ? "fail" : checks.every(check => check.ok === true) ? "pass" : "open";
  const text = [`# wake-live ${verdict}: ${state.chat.name}`, "", `Chat ${chat} on ${state.release}, judged ${iso(Date.now())}.`, "",
    ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), ""].join("\n");
  return { verdict, text };
}
