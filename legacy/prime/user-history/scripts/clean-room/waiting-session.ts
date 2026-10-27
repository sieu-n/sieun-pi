import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nobodySteppedIn } from "./resume-model.ts";
import type { RunState, Scenario, Verdict } from "./session-read.ts";

/**
 * The clean-room scenario w81-waiting-session (chat-2572 c84, 10-26): a job that waits on its own board.wake stays the same session, on the
 * model and thinking level its spawn asked for, through an idle unload and the wake. Since sieun-pi 84fff13d the cleanup never replaces a
 * waiting job. A fresh chat on gpt-6.1-sol gets one owner-style task: one job on openai-codex/gpt-6.1-sol at medium counts now and again 30
 * minutes later. The job sets its own board.wake, the idle unload stops its session while it waits, and the wake service delivers the wake;
 * nobody sends anything. The judge reads the job's spawn record and session file, the wake files and the service.log lines that name the
 * job's session, which collect keeps for this scenario (`jobEvidence`). The criteria live in the run folder's criteria.md.
 */
// Owner rule c185 allows only Claude Opus 5.5, Sonnet 5.5 and Fable 5.1, and OpenAI GPT-6.1 sol, GPT-6.1 terra and GPT-6 luna; run1 on 10-27
// used gpt-6-astra and was closed as noncompliant.
export const MODEL = { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "medium" };
export const TASK = "how many test files are in legacy/prime/user-history/test of ~/src/sieun-pi right now? have one job on openai-codex/gpt-6.1-sol " +
  "with medium thinking count them and put the number on the board, then the same job counts again 30 minutes later and puts the difference " +
  "on the board";
const HOME = homedir();
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(HOME, ".prime/agent/browser-chat");
const ARTIFACTS = join(HOME, ".prime/agent/session-artifacts");
const WAKE_TEXT = "[wake] It is ";
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 160): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const json = (file: string): Record<string, unknown> | undefined => { try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return undefined; } };
const blockText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(block => typeof block === "object" && block && "text" in block && typeof block.text === "string" ? block.text : "").join("\n") : "";

/** What the judge reads from a job's session file, line by line. */
export interface JobFile {
  id?: string;
  models: { at: number; model: string }[];
  thinking: { at: number; level: string }[];
  states: { at: number; status: string; reason?: string }[];
  assistant: { at: number; model: string; stop?: string }[];
  /** Each board.wake call the job made. */
  wakeCalls: number[];
  /** Each message the session got after its task: a user turn or a custom message, with its text. */
  inputs: { at: number; text: string }[];
}

export function readJobFile(file: string): JobFile {
  const out: JobFile = { models: [], thinking: [], states: [], assistant: [], wakeCalls: [], inputs: [] };
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const at = Date.parse(String(entry.timestamp ?? "")) || 0;
    if (entry.type === "session") out.id = String(entry.id ?? "");
    else if (entry.type === "model_change") out.models.push({ at, model: `${String(entry.provider)}/${String(entry.modelId)}` });
    else if (entry.type === "thinking_level_change") out.thinking.push({ at, level: String(entry.thinkingLevel) });
    else if (entry.type === "session_state") {
      const state = (entry.state ?? {}) as { status?: unknown; reason?: unknown };
      out.states.push({ at, status: String(state.status ?? ""), ...typeof state.reason === "string" ? { reason: state.reason } : {} });
    } else if (entry.type === "custom_message") out.inputs.push({ at, text: blockText(entry.content) });
    else if (entry.type === "message") {
      const message = (entry.message ?? {}) as { role?: string; content?: unknown; provider?: unknown; model?: unknown; stopReason?: unknown };
      if (message.role === "user") out.inputs.push({ at, text: blockText(message.content) });
      if (message.role !== "assistant") continue;
      out.assistant.push({ at, model: `${String(message.provider)}/${String(message.model)}`, ...typeof message.stopReason === "string" ? { stop: message.stopReason } : {} });
      for (const block of Array.isArray(message.content) ? message.content as Record<string, unknown>[] : []) {
        if (block.type === "toolCall" && /\bboard\.wake\s*\(/.test(JSON.stringify(block.arguments ?? {}))) out.wakeCalls.push(at);
      }
    }
  }
  return out;
}

/** The chat's job on the asked model: its child id, name, the model its spawn asked for and its session file. */
function theJob(chat: string): { child: string; name: string; asked: string; file: string }[] {
  const dir = join(ARTIFACTS, chat);
  return (existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith("sub-")) : []).flatMap(child => {
    const record = json(join(dir, child, "rlm-subagent.json"));
    if (!record) return [];
    const model = record.model as { provider?: string; modelId?: string } | undefined;
    return [{ child, name: String(record.sessionName ?? ""), asked: model ? `${model.provider}/${model.modelId}` : "none",
      file: typeof record.sessionFile === "string" ? record.sessionFile : "" }];
  });
}

/** Copies each pending wake file of `sessions` into the run folder (collect calls this each pass), since the wake service removes it at delivery. */
export function keepWakes(run: string, sessions: Iterable<string>): void {
  const dir = join(DATA, "wakes");
  if (!existsSync(dir)) return;
  const ids = [...sessions];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || !ids.some(id => name.startsWith(id))) continue;
    const out = join(run, "wakes", name);
    if (!existsSync(out)) { mkdirSync(join(run, "wakes"), { recursive: true }); copyFileSync(join(dir, name), out); }
  }
}

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const want = `${MODEL.provider}/${MODEL.modelId}`;
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
  const spawns = theJob(chat);
  const job = spawns.find(spawn => spawn.asked === want);
  const read = job ? readJobFile(job.file) : undefined;
  const session = job ? job.file.split("/").at(-1)!.replace(/\.jsonl$/, "") : "";
  const logFile = join(run, "service.log");
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(line => session && line.includes(session)) : [];
  const stamp = (line: string): number => Date.parse(line.slice(0, 24)) || 0;

  // a: the spawn asked for the model, and the session started on it.
  const first = read ? { model: read.models[0]?.model, level: read.thinking[0]?.level } : undefined;
  add("a", !job ? null : first?.model === want && first.level === MODEL.thinkingLevel, !job
    ? spawns.length ? `no job asked ${want}: ${spawns.map(spawn => `${spawn.child} "${spawn.name}" asked ${spawn.asked}`).join("; ")}` : "the chat has spawned no job yet"
    : `${job.child} "${job.name}" (session ${session}) asked ${job.asked}; its file starts on ${first?.model ?? "?"} at ${first?.level ?? "?"}`);

  // b: the job set its own board.wake for a time, and a wake file for its session was seen.
  const wakeDir = join(run, "wakes");
  const wakes = existsSync(wakeDir) ? readdirSync(wakeDir).filter(name => name.startsWith(session) && name.includes("-time-")) : [];
  const setAt = read?.wakeCalls[0];
  add("b", !read ? null : setAt !== undefined && wakes.length ? true : null, !read ? "no job yet"
    : `board.wake calls in the job's session: ${read.wakeCalls.map(iso).join(", ") || "none yet"}; wake files kept: ${wakes.join(", ") || "none yet"}`);

  // c: the session was really unloaded after the wake was set and before the wake came.
  const wakeIn = read && setAt !== undefined ? read.inputs.find(input => input.at > setAt && input.text.includes(WAKE_TEXT)) : undefined;
  const unloads = read && setAt !== undefined ? read.states.filter(entry => entry.status === "archived" && entry.reason === "idle_unload" && entry.at > setAt &&
    (wakeIn === undefined || entry.at < wakeIn.at)) : [];
  const unloadLines = log.filter(line => line.includes("idle unload"));
  add("c", !read || setAt === undefined ? null : unloads.length ? true : wakeIn ? false : null, !read || setAt === undefined ? "no wake set yet"
    : `session_state idle_unload in the job's file: ${unloads.map(entry => iso(entry.at)).join(", ") || "none"}${unloadLines.length ? `; service.log: ${unloadLines.map(line => clip(line)).join(" | ")}` : ""}`);

  // d: the wake service delivered the wake, and it was the first message the job got after the unload.
  const woke = log.filter(line => /wakes: woke \S+ for its time/.test(line));
  const unloadAt = unloads[0]?.at;
  const before = read && unloadAt !== undefined ? read.inputs.filter(input => input.at > unloadAt && (wakeIn === undefined || input.at < wakeIn.at)) : [];
  add("d", !wakeIn ? null : woke.length > 0 && before.length === 0, !wakeIn ? "the wake has not reached the job's session yet"
    : `the job got "${clip(wakeIn.text, 120)}" at ${iso(wakeIn.at)}; service.log: ${woke.map(line => clip(line)).join(" | ") || "no 'woke ... for its time' line"}` +
      (before.length ? `; before it, after the unload, the job got: ${before.map(input => `${iso(input.at)} "${clip(input.text, 80)}"`).join("; ")}` : "; nothing else reached the job in between"));

  // e: the same session before and after the wake: its file's own id, its spawn record's file, no saved state and no copy of the job.
  const after = read && wakeIn ? read.assistant.filter(turn => turn.at > wakeIn.at) : [];
  const beforeTurns = read && setAt !== undefined ? read.assistant.filter(turn => turn.at <= setAt) : [];
  const folder = join(DATA, "job-resumes", chat);
  const saved = existsSync(folder) ? readdirSync(folder).filter(name => job && name.startsWith(job.child)) : [];
  const copies = spawns.filter(spawn => job && spawn.child !== job.child && spawn.name.startsWith(job.name));
  add("e", !wakeIn || !after.length ? null : read!.id === session && beforeTurns.length > 0 && !saved.length && !copies.length, !wakeIn || !after.length
    ? "no turn after the wake yet"
    : `session ${read!.id} (file ${job!.file}) holds ${beforeTurns.length} assistant messages up to the wake call and ${after.length} after the wake; ` +
      `saved states naming the job: ${saved.join(", ") || "none"}; other jobs with its name: ${copies.map(spawn => spawn.child).join(", ") || "none"}`);

  // f: the model and thinking level before and after: every change line and every assistant message.
  const wrongModels = read ? read.models.filter(entry => entry.model !== want) : [];
  const wrongLevels = read ? read.thinking.filter(entry => entry.level !== MODEL.thinkingLevel) : [];
  const wrongTurns = read ? read.assistant.filter(turn => turn.model !== want) : [];
  add("f", !after.length ? null : !wrongModels.length && !wrongLevels.length && !wrongTurns.length, !read ? "no job yet"
    : `model_change: ${read.models.map(entry => `${iso(entry.at)} ${entry.model}`).join(", ") || "none"}; thinking_level_change: ${read.thinking.map(entry => `${iso(entry.at)} ${entry.level}`).join(", ") || "none"}; ` +
      `assistant messages: ${beforeTurns.length} before the wake call and ${after.length} after the wake, ${wrongTurns.length ? `${wrongTurns.length} not on ${want} (${wrongTurns.slice(0, 3).map(turn => `${iso(turn.at)} ${turn.model}`).join(", ")})` : `all on ${want}`}`);

  // g: nobody stepped in.
  const stepped = nobodySteppedIn(run, state);
  add("g", stepped.ok, stepped.detail);

  // Void with no model turn after the wake: the wake came, but every reply after it failed (no assistant message that did not end in an error).
  const answered = after.some(turn => turn.stop !== "error" && turn.stop !== "aborted");
  const noTurn = wakeIn !== undefined && after.length > 0 && !answered;
  const verdict: Verdict = stepped.ok === false || noTurn ? "void" : checks.some(check => check.ok === false) ? "fail"
    : checks.some(check => check.ok === null) ? "open" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: the job's rlm-subagent.json and session file, the kept wake files in ${wakeDir}, the service.log lines that name the job's session, and ${folder}.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`),
    ...noTurn ? ["", "Void: the wake reached the job, but no turn after it got a model reply."] : [], "",
  ].join("\n");
  return { verdict, text };
}

export const waitingSession: Scenario = {
  name: "waiting-session",
  model: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
  headMessage: () => TASK,
  fixtures: [],
  jobEvidence: true,
  endsAtVerdict: true,
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release}, with one owner-style first message and no seeded board, todo or fixture.`, "",
    "## The first message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
