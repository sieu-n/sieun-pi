/**
 * The crash rig: runs crash-worker.ts in a child process, kills it with SIGKILL at a chosen event, reads the file
 * read-only, then resumes it in a new process and checks the run finished once with nothing lost or doubled.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { CHILD_TASK, INPUT, type EntrySummary } from "./crash-scenario.ts";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "crash-worker.ts");
const PI_STACK = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type KillPoint = "root-partial" | "child-partial" | "root-slot-wait";

export interface Event { event: string; at: number; [key: string]: unknown }
export interface ConversationDump { id: number; owner: { conversationId: number; taskId: number } | null; entries: EntrySummary[]; live: unknown }

export interface WorkerRun { code: number | null; signal: NodeJS.Signals | null; events: Event[]; stderr: string; startedAt: number; endedAt: number }

/** Runs one worker phase. With `killOn`, sends SIGKILL `killDelayMs` after that event. */
export function runWorker(phase: "start" | "inspect" | "resume", file: string, mode: "faux" | "real", env: NodeJS.ProcessEnv, killOn?: KillPoint, killDelayMs = 0): Promise<WorkerRun> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", WORKER, phase, file, mode], { cwd: PI_STACK, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const events: Event[] = [];
    let stderr = "";
    child.stderr.on("data", chunk => (stderr += String(chunk)));
    createInterface({ input: child.stdout }).on("line", line => {
      let event: Event;
      try {
        event = JSON.parse(line) as Event;
      } catch {
        stderr += `${line}\n`;
        return;
      }
      events.push(event);
      if (killOn && event.event === killOn) setTimeout(() => child.kill("SIGKILL"), killDelayMs);
    });
    child.on("close", (code, signal) => resolve({ code, signal, events, stderr, startedAt, endedAt: Date.now() }));
  });
}

export interface CrashResult {
  killPoint: KillPoint;
  start: WorkerRun;
  killedAt: number | undefined;
  before: ConversationDump[];
  resume: WorkerRun;
  after: ConversationDump[];
  settled: { status: string } | undefined;
  /** From the resume process's start until the input settled. */
  resumeMs: number | undefined;
}

const dumpOf = (run: WorkerRun): ConversationDump[] => (run.events.find(e => e.event === "dump")?.conversations as ConversationDump[] | undefined) ?? [];

export async function crashAndResume(file: string, mode: "faux" | "real", env: NodeJS.ProcessEnv, killPoint: KillPoint, killDelayMs = 0): Promise<CrashResult> {
  const start = await runWorker("start", file, mode, env, killPoint, killDelayMs);
  const inspect = await runWorker("inspect", file, mode, env);
  const resume = await runWorker("resume", file, mode, env);
  const settledEvent = resume.events.find(e => e.event === "settled");
  return {
    killPoint,
    start,
    killedAt: start.signal === "SIGKILL" ? start.endedAt : undefined,
    before: dumpOf(inspect),
    resume,
    after: dumpOf(resume),
    settled: settledEvent?.settled as { status: string } | undefined,
    resumeMs: settledEvent?.ms as number | undefined,
  };
}

const userEntries = (c: ConversationDump | undefined) => (c?.entries ?? []).filter(e => e.kind === "pi.user");

/** What a crash must never break. Returns the problems found, empty when the run is whole. */
export function problems(result: CrashResult): string[] {
  const out: string[] = [];
  if (result.start.signal !== "SIGKILL") out.push(`the start process was not killed (code ${result.start.code}, events ${result.start.events.map(e => e.event).join(",")})`);
  if (result.settled?.status !== "done") out.push(`the input settled ${result.settled?.status ?? "never"}: ${result.resume.stderr.slice(-2000)}`);
  const rootBefore = result.before.find(c => c.owner === null);
  const root = result.after.find(c => c.owner === null);
  if (userEntries(rootBefore).length !== 1) out.push(`the root had ${userEntries(rootBefore).length} user entries before resume`);
  const users = userEntries(root);
  if (users.length !== 1 || users[0]?.text !== INPUT) out.push(`the root has ${users.length} user entries after resume`);
  const children = result.after.filter(c => c.owner !== null);
  if (children.length !== 1) out.push(`${children.length} child conversations`);
  const child = children[0];
  const childUsers = userEntries(child);
  if (childUsers.length !== 1 || childUsers[0]?.text !== CHILD_TASK) out.push(`the child has ${childUsers.length} user entries`);
  const childAnswers = (child?.entries ?? []).filter(e => e.kind === "pi.assistant" && e.stopReason === "stop");
  if (childAnswers.length !== 1) out.push(`the child has ${childAnswers.length} final answers`);
  const results = (root?.entries ?? []).filter(e => e.kind === "pi.tool-result" && e.toolName === "subagent");
  if (results.length !== 1 || results[0]?.isError) out.push(`the root has ${results.length} subagent results (error ${results[0]?.isError})`);
  else if (results[0]!.text !== childAnswers[0]?.text) out.push("the subagent result is not the child's answer");
  const answers = (root?.entries ?? []).filter(e => e.kind === "pi.assistant" && e.stopReason === "stop");
  if (answers.length !== 1) out.push(`the root has ${answers.length} final answers`);
  return out;
}

/** One line per conversation: its entries as kind/stopReason, for the report. */
export function shape(dump: ConversationDump[]): string[] {
  return dump.map(c => `${c.owner === null ? "root" : `child of task ${c.owner.taskId}`} #${c.id}: ${c.entries.map(e => e.kind.replace("pi.", "") + (e.stopReason ? `(${e.stopReason})` : "") + (e.isError ? "(error)" : "")).join(" ")}`);
}
