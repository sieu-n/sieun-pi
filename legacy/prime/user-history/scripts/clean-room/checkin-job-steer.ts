import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSession, sessionFile, type RunState, type Scenario, type SessionEvent, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for a check-in job's message to a job of its chat (scripts/job-steer.ts, Chats.steerJob). On 10-16 at 07:5xZ the
 * slack green guy check-in got 404 for "blog reader demo" while the daemon's list timed out, and after the fix the job, a finished subagent
 * the daemon no longer listed, still could not be prompted. A fresh chat gets one ordinary owner-style message with a number to reach; the
 * criteria live in the run folder's criteria.md, written before the run.
 */
export const TASK = "find which of our tiktok shop listings lost the most views this week and keep a page with the top 10 updated. measure each " +
  "one's drop from real data, i want all 10 measured by tomorrow";
const RELAY_WAIT_MS = 5 * 60_000;
/** A call that runs the script, not one that reads its source. */
const RUN_STEER = /node[^"]*scripts\/job-steer\.ts \S/;

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 300): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
const blockText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(block => typeof block === "object" && block && "text" in block && typeof block.text === "string" ? block.text : "").join("\n") : "";

/** One job-steer call a check-in job made, with the printed result when its tool result shows one. */
interface SteerCall { job: string; at: number; result: string }
/** Every job-steer.ts call in a session file, matched to its tool result by call id. */
export function steerCalls(file: string): SteerCall[] {
  const calls = new Map<string, { at: number; result: string }>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: { timestamp?: string; type?: string; message?: { role?: string; content?: unknown; toolCallId?: string } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    const message = entry.message;
    if (entry.type !== "message" || !message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content as { type?: string; id?: string; arguments?: unknown }[]) {
        if (block.type === "toolCall" && block.id && RUN_STEER.test(JSON.stringify(block.arguments ?? {}))) calls.set(block.id, { at: Date.parse(entry.timestamp ?? "") || 0, result: "" });
      }
    }
    if (message.role === "toolResult" && message.toolCallId && calls.has(message.toolCallId)) calls.get(message.toolCallId)!.result = blockText(message.content);
  }
  return [...calls.values()].map(call => ({ job: "", ...call }));
}
const STEERED = /(steered|restarted) (.+?) \(session ([\w-]+)\)/g;
const RELAYED = /sent (.+?) the message through its chat \(session ([\w-]+)\)/g;
const FAILED = /job-steer: (\d{3})[^\n]*/g;

export const checkinJobSteer: Scenario = {
  name: "checkin-job-steer",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    `Its check-in runs every ${state.everyMs / 60_000} min on the server's clock. Nobody touches the chat, its jobs or its board.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

interface Check { id: string; ok: boolean | null; detail: string }
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const runsFile = join(run, "runs.jsonl");
  const runs = existsSync(runsFile) ? readFileSync(runsFile, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as { duty: string; at: number; job?: { id: string; name: string } }) : [];
  const dutyJobs = new Map(runs.flatMap(entry => entry.duty === "checkin" && entry.job && entry.at >= state.windowStart ? [[entry.job.id, entry.job.name] as const] : []));
  const agentsDir = join(run, "agents");
  for (const file of existsSync(agentsDir) ? readdirSync(agentsDir) : []) {
    for (const agent of JSON.parse(readFileSync(join(agentsDir, file), "utf8")) as { sessionId?: string; name: string }[]) {
      if (agent.sessionId && /^check-in /.test(agent.name)) dutyJobs.set(agent.sessionId, agent.name);
    }
  }
  const chatEvents = readSession(state.chat.id);
  const calls = [...dutyJobs].flatMap(([id, name]) => { const file = sessionFile(id, [state.chat.id]); return file ? steerCalls(file).map(call => ({ ...call, job: name })) : []; })
    .filter(call => call.at >= state.windowStart).sort((a, b) => a.at - b.at);
  const checks: Check[] = [];
  checks.push({ id: "a", ok: calls.length ? true : null, detail: `${dutyJobs.size} check-in jobs, ${calls.length} job-steer calls${calls.length ? `: ${calls.map(call => `${call.job} at ${iso(call.at)}`).join("; ")}` : ""}` });

  const failures = calls.flatMap(call => [...call.result.matchAll(FAILED)].map(match => `${call.job} at ${iso(call.at)}: "${clip(match[0], 200)}"`));
  const targets = calls.flatMap(call => [
    ...[...call.result.matchAll(STEERED)].map(match => ({ call, name: match[2]!, session: match[3]!, relay: false })),
    ...[...call.result.matchAll(RELAYED)].map(match => ({ call, name: match[1]!, session: match[2]!, relay: true })),
  ]);
  const silent = calls.filter(call => !/job-steer: \d{3}/.test(call.result) && !targets.some(target => target.call === call));
  checks.push({ id: "b", ok: calls.length ? failures.length === 0 && targets.length > 0 : null, detail: [`${targets.length} delivered (${targets.filter(target => target.relay).length} through the chat)`,
    failures.length ? `failed: ${failures.join("; ")}` : "none failed", silent.length ? `${silent.length} calls printed no result` : ""].filter(Boolean).join("; ") });

  const reached: string[] = [];
  const missed: string[] = [];
  const acted: string[] = [];
  const idle: string[] = [];
  for (const target of targets) {
    const events: SessionEvent[] = target.relay ? chatEvents : readSession(target.session, [state.chat.id]);
    const got = events.find(event => event.kind === "text" && event.at >= target.call.at - 60_000 && event.at <= target.call.at + RELAY_WAIT_MS && event.text.includes("[check-in]"));
    (got ? reached : missed).push(`${target.name} (${target.session.slice(0, 8)}) ${got ? `got it at ${iso(got.at)}` : "got no [check-in] message within 5 min"}`);
    if (!got) continue;
    const after = target.relay
      ? events.find(event => event.kind === "sent" && event.at >= got.at && event.toName.trim().toLowerCase() === target.name.trim().toLowerCase())
      : events.find(event => (event.kind === "assistant" || event.kind === "call") && event.at >= got.at);
    (after ? acted : idle).push(`${target.name} ${after ? `${target.relay ? "got it from the chat" : "took a turn"} at ${iso(after.at)}` : "did nothing after it yet"}`);
  }
  checks.push({ id: "c", ok: targets.length ? missed.length === 0 : null, detail: [...reached, ...missed].join("; ") || "no delivered message yet" });
  checks.push({ id: "d", ok: targets.length ? (idle.length === 0 ? true : null) : null, detail: [...acted, ...idle].join("; ") || "no delivered message yet" });

  const outside: string[] = [];
  const family = new Set([state.chat.id, ...dutyJobs.keys()]);
  for (const event of chatEvents) {
    if (event.kind !== "text" || event.at < state.windowStart) continue;
    if (event.role === "user" && event.text.trim() !== TASK && !event.text.trimStart().startsWith("[")) outside.push(`a typed message at ${iso(event.at)}: "${clip(event.text, 120)}"`);
    if (event.customType === "agent_message" && event.fromId && !family.has(event.fromId) && event.relation !== "child" && event.relation !== "parent") outside.push(`${event.from ?? event.fromId} at ${iso(event.at)}: "${clip(event.text, 120)}"`);
  }
  checks.push({ id: "e", ok: outside.length === 0, detail: outside.length ? outside.join("; ") : "no typed message after the first and no message from outside the chat's own sessions" });

  const voided = checks.find(check => check.id === "e")!.ok === false;
  const verdict: Verdict = voided ? "void" : checks.some(check => check.ok === false) ? "fail" : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${state.chat.id}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}, check-in every ${state.everyMs / 60_000} min, with one owner-style message. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: ${run}/agents and runs.jsonl, and the session files of the check-in jobs and the jobs they messaged.`, "",
    "## Verdict per criterion", "", ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}
