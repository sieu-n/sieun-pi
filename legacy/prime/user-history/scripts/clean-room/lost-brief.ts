import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSession, readSessionFile, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario for the brief keeper's worker check (src/brief-keeper.ts). At 14:35:39Z on 10-15 every Prime worker got SIGTERM while
 * the supervisor ran on, and 20 children spawned in the 20 min before never got their brief, since the keeper of a7d5718 sent one only after a
 * supervisor restart. A fresh chat gets an ordinary task for a job. `clean-room.ts kill-worker` waits for the chat's first spawn record and
 * SIGKILLs the chat's own worker before the child's first prompt reaches its file or the worker's journal shows its agent start. Nobody tells
 * the chat or the job anything. The criteria live in the run folder's criteria.md.
 */
export const TASK = "have a job count the .ts files under legacy/prime/user-history/src and tell me how many there are";
const HOME = homedir();
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(HOME, ".prime/agent/browser-chat");
const WORKERS = join(HOME, ".prime/agent/daemon-workers");
const BRIEFS = join(DATA, "spawn-briefs");

const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 300): string => (text.length > length ? text.slice(0, length - 1) + "…" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
interface Check { id: string; ok: boolean | null; detail: string }
interface BriefCopy { kind: string; id: string; name: string; prompt: string; at: number; root: string; sessionDir?: string }
/** What `kill-worker` saw and did. */
export interface Kill { at: number; pid: number; workerId: string; record: BriefCopy; childFile?: string; fileStarted: boolean; journalRan: boolean; journal: string }

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** The chat's live worker file, from Prime's daemon-workers folder. */
function chatWorker(chat: string): { workerId: string; pid: number; recoveryJournalPath: string } | undefined {
  for (const daemon of existsSync(WORKERS) ? readdirSync(WORKERS) : []) {
    const dir = join(WORKERS, daemon);
    let names: string[] = [];
    try { names = readdirSync(dir).filter(name => /^[0-9a-f]{12}\.json$/.test(name)); } catch { continue; }
    for (const name of names) {
      try {
        const worker = JSON.parse(readFileSync(join(dir, name), "utf8")) as { workerId: string; pid: number; rootSessionId: string; recoveryJournalPath: string };
        if (worker.rootSessionId === chat && alive(worker.pid)) return worker;
      } catch { /* written now */ }
    }
  }
  return undefined;
}
/** A child's session file: its rlm-subagent.json's, else the one session file in its folder. */
function childFile(record: BriefCopy): string | undefined {
  if (!record.sessionDir || !existsSync(record.sessionDir)) return undefined;
  try { const spawn = JSON.parse(readFileSync(join(record.sessionDir, "rlm-subagent.json"), "utf8")) as { sessionFile?: string }; if (spawn.sessionFile) return spawn.sessionFile; } catch { /* not yet */ }
  const own = readdirSync(record.sessionDir).filter(name => name.endsWith(".jsonl") && name !== "semantic-edges.jsonl");
  return own.length === 1 ? join(record.sessionDir, own[0]!) : undefined;
}
const firstPrompt = (file: string | undefined): boolean => !!file && existsSync(file) && readSessionFile(file).some(event => event.kind === "text" && (event.role === "user" || event.customType === "agent_message"));
const sessionOf = (file: string | undefined): string => /([\w-]+)\.jsonl$/.exec(file ?? "")?.[1] ?? "";

const SESSIONS = join(HOME, ".prime/agent/sessions");
/** A root session named `name` whose file was created at or after `since`: the chat a setup made before its create call answered. */
function chatNamed(name: string, since: number): string | undefined {
  for (const file of readdirSync(SESSIONS).filter(entry => entry.endsWith(".jsonl"))) {
    const path = join(SESSIONS, file);
    if (statSync(path).birthtimeMs < since) continue;
    if (readFileSync(path, "utf8").split("\n").some(line => line.startsWith('{"type":"session_info"') && line.includes(JSON.stringify(name)))) return file.slice(0, -6);
  }
  return undefined;
}

/**
 * Polls every 50 ms for the chat's first child spawn record and SIGKILLs the chat's worker at once. Kills nothing else. The chat comes from
 * run.json, or with `name` from the newest root of that name: under load 75 on 10-17 setup's create call timed out after the chat answered.
 */
export async function killWorker(run: string, until: number, name?: string): Promise<Kill | null> {
  const stateFile = join(run, "run.json");
  const started = Date.now();
  let named: string | undefined;
  let looked = 0;
  while (Date.now() < until) {
    if (name && !named && Date.now() - looked > 1000) { looked = Date.now(); named = chatNamed(name, started); }
    const chat = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as RunState).chat.id : named;
    const names = chat && existsSync(BRIEFS) ? readdirSync(BRIEFS).filter(name => name.startsWith("child-")) : [];
    for (const name of names) {
      let record: BriefCopy;
      try { record = JSON.parse(readFileSync(join(BRIEFS, name), "utf8")) as BriefCopy; } catch { continue; }
      if (record.root !== chat) continue;
      const worker = chatWorker(chat);
      if (!worker) continue;
      const file = childFile(record);
      const session = sessionOf(file);
      const journal = readFileSync(worker.recoveryJournalPath, "utf8");
      const journalRan = !!session && journal.split("\n").some(line => line.includes(session) && /"operation":\s*"agent_start"/.test(line));
      const fileStarted = firstPrompt(file);
      process.kill(worker.pid, "SIGKILL");
      const kill: Kill = { at: Date.now(), pid: worker.pid, workerId: worker.workerId, record, ...(file ? { childFile: file } : {}), fileStarted, journalRan,
        journal: journal.split("\n").filter(line => session && line.includes(session)).join("\n") };
      writeFileSync(join(run, "kill.json"), JSON.stringify(kill, null, 1));
      return kill;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

export const lostBrief: Scenario = {
  name: "lost-brief",
  headMessage: () => TASK,
  fixtures: [],
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`,
    "`clean-room.ts kill-worker`, started before setup, SIGKILLs the chat's Prime worker the moment the chat's first spawn record appears in spawn-briefs/, and writes kill.json.", "",
    "## The message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const checks: Check[] = [];
  const killFile = join(run, "kill.json");
  const kill = existsSync(killFile) ? JSON.parse(readFileSync(killFile, "utf8")) as Kill : null;
  checks.push({ id: "a", ok: kill ? !kill.fileStarted && !kill.journalRan : null, detail: kill
    ? `${iso(kill.at)}: SIGKILL to worker ${kill.workerId} (pid ${kill.pid}) of the chat, ${Math.round((kill.at - kill.record.at) / 100) / 10} s after job "${kill.record.name}" was spawned; ` +
      `its file had ${kill.fileStarted ? "a" : "no"} first prompt and the worker's journal ${kill.journalRan ? "had" : "had no"} agent_start for it`
    : "no kill yet" });

  const file = kill ? kill.childFile ?? childFile(kill.record) : undefined;
  const events = file ? readSessionFile(file) : [];
  const head = kill ? kill.record.prompt.slice(0, 200) : "\u0000";
  const prompts = events.filter(event => event.kind === "text" && (event.role === "user" || event.customType === "agent_message"));
  const copies = prompts.filter(event => event.kind === "text" && event.text.includes(head));
  const first = prompts[0];
  const service = existsSync(join(DATA, "service.log")) ? readFileSync(join(DATA, "service.log"), "utf8").split("\n") : [];
  const sends = kill ? service.filter(line => line.includes("briefs: ") && line.includes(kill.record.id.slice(0, 12))) : [];
  checks.push({ id: "b", ok: kill ? (first ? first.kind === "text" && first.text.includes(head) && first.at > kill.at : null) : null,
    detail: !first ? "no first prompt in the job's file yet" : `first prompt at ${iso(first.at)}: "${clip(first.kind === "text" ? first.text : "", 200)}"; keeper log: ${sends.map(line => clip(line, 220)).join(" | ") || "none"}` });
  checks.push({ id: "c", ok: first ? copies.length === 1 : null, detail: `${copies.length} copies of the brief in the job's file` });

  const after = first ? events.filter(event => event.at >= first.at) : [];
  const calls = after.filter(event => event.kind === "call").length;
  const reports = after.filter(event => event.kind === "sent" && event.to === chat);
  checks.push({ id: "d", ok: first ? (calls > 0 && reports.length > 0 ? true : null) : null,
    detail: `${calls} tool calls after the brief; ${reports.length ? `reported to the chat at ${iso(reports[0]!.at)}: "${clip(reports[0]!.kind === "sent" ? reports[0]!.text : "", 300)}"` : "no report to the chat yet"}` });

  const strangers = prompts.filter(event => event.kind === "text" && !event.text.includes(head) && event.fromId !== chat);
  const chatEvents = readSession(chat);
  const typed = chatEvents.filter(event => event.kind === "text" && event.role === "user" && !event.text.trimStart().startsWith("[") && !state.seeds.some(seed => event.text.includes(seed)));
  const outside = chatEvents.filter(event => event.kind === "text" && event.customType === "agent_message" && event.relation !== "child");
  checks.push({ id: "e", ok: strangers.length === 0 && typed.length === 0 && outside.length === 0, detail: strangers.length || typed.length || outside.length
    ? [...strangers.map(event => `the job got "${clip(event.kind === "text" ? event.text : "", 120)}"`), ...typed.map(event => `the chat got typed "${clip(event.kind === "text" ? event.text : "", 120)}"`),
      ...outside.map(event => `the chat got a message from ${event.kind === "text" ? event.from : ""}`)].join("; ")
    : "only the owner-style message, the keeper's brief and the chat's own job messages reached the chat and the job" });

  const verdict: Verdict = checks.find(check => check.id === "e")!.ok === false ? "void" : checks.some(check => check.ok === false) ? "fail" : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: ${killFile}, the job's session file ${file ?? "(none yet)"}, the chat's session file and ${join(DATA, "service.log")}.`, "",
    "## Verdict per criterion", "", ...checks.map(check => `- (${check.id}) ${yes(check.ok)}: ${check.detail}`), "",
  ].join("\n");
  return { verdict, text };
}
