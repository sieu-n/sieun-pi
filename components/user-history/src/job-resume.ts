import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clockTime } from "./checkin-settings.ts";
import { spawnRecord } from "./spawn-record.ts";
import { isThinkingLevel, type PlanItem, type ThinkingLevel } from "./shared/types.ts";
import { fileLines } from "./file-lines.ts";

/**
 * What a fresh job needs to pick up the work of a job the chat ended while it waited on a board step: the job's brief, its last report to the
 * chat, and the wait (each step's waitFor or waitUntil).
 */
export interface JobResume {
  chat: string; childId: string; job: string; steps: string[]; event: string; brief: string; report: string; endedAt: number;
  /** The model and thinking level the job ran on (`jobModel`, `sessionModel`), which its fresh job starts on; absent in files saved before 10-23. */
  model?: JobModel;
  /** The fresh job the cleanup started from this state (`resumeBrief`); absent when none started or the file is older. */
  resumed?: { id: string; name: string };
}

/**
 * The model a job was started on: chat-2572 10-22 spawned "mcp metadata access" on openai-codex/gpt-6-astra at thinking high, and the cleanup's
 * fresh job "mcp metadata access resumed 00:11" (01a1642b) started on the daemon default anthropic/claude-opus-5-5 and stopped on the Claude limit.
 */
export interface JobModel { provider: string; modelId: string; thinkingLevel?: ThinkingLevel }

/** `<data dir>/job-resumes/<chat>/<child id>.json`, one file per ended job. */
export interface JobResumes {
  /** Writes the saved state and returns its path. */
  save(resume: JobResume): Promise<string>;
  read(path: string): Promise<JobResume>;
  /** Every saved state of the chat, with its path; a file that does not parse is left out. */
  list(chat: string): Promise<{ path: string; resume: JobResume }[]>;
}
export function jobResumes(dir: string): JobResumes {
  return {
    async save(resume) {
      const folder = join(dir, resume.chat);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const path = join(folder, `${resume.childId}.json`);
      await writeFile(path + ".tmp", JSON.stringify(resume, null, 1), { mode: 0o600 });
      await rename(path + ".tmp", path);
      return path;
    },
    async read(path) { return JSON.parse(await readFile(path, "utf8")) as JobResume; },
    async list(chat) {
      const folder = join(dir, chat);
      const names = (await readdir(folder).catch(() => [] as string[])).filter(name => name.endsWith(".json"));
      const read = await Promise.all(names.map(async name => {
        const path = join(folder, name);
        const resume = parseJobResume(await readFile(path, "utf8").then(text => JSON.parse(text) as unknown).catch(() => null));
        return resume ? [{ path, resume }] : [];
      }));
      return read.flat();
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");

/**
 * A saved state file's content, parsed at the boundary; null when it is not one. us-metal02 10-23: one file under job-resumes held
 * `{"check-in stuck root cause": ..., ...}` with no steps, and the first job sweep of fbd5a0a0 threw on it and stopped the service 4 times.
 */
export function parseJobResume(value: unknown): JobResume | null {
  if (!isRecord(value) || typeof value.chat !== "string" || typeof value.childId !== "string" || typeof value.job !== "string" || !strings(value.steps) ||
    typeof value.endedAt !== "number" || !Number.isFinite(value.endedAt)) return null;
  const model = isRecord(value.model) && typeof value.model.provider === "string" && typeof value.model.modelId === "string"
    ? { provider: value.model.provider, modelId: value.model.modelId, ...isThinkingLevel(value.model.thinkingLevel) ? { thinkingLevel: value.model.thinkingLevel } : {} } : undefined;
  const resumed = isRecord(value.resumed) && typeof value.resumed.id === "string" && typeof value.resumed.name === "string" ? { id: value.resumed.id, name: value.resumed.name } : undefined;
  return { chat: value.chat, childId: value.childId, job: value.job, steps: value.steps, event: typeof value.event === "string" ? value.event : "",
    brief: typeof value.brief === "string" ? value.brief : "", report: typeof value.report === "string" ? value.report : "", endedAt: value.endedAt,
    ...model ? { model } : {}, ...resumed ? { resumed } : {} };
}

/** Entries a session file's head holds before its first message: the header, model_change, thinking_level_change and a few more. */
const HEAD_LINES = 12;

/**
 * The model and thinking level a session file starts on: its first model_change and thinking_level_change, which Prime writes at the create
 * from the spawn's or create_session's model and thinking. Undefined when the file has no model_change in its head.
 */
export async function sessionModel(file: string): Promise<JobModel | undefined> {
  let model: { provider: string; modelId: string } | undefined;
  let thinkingLevel: ThinkingLevel | undefined;
  let read = 0;
  try {
    for await (const line of fileLines(file)) {
      if (++read > HEAD_LINES) break;
      if (!line.startsWith('{"type":"model_change"') && !line.startsWith('{"type":"thinking_level_change"')) continue;
      const entry: unknown = JSON.parse(line);
      if (!isRecord(entry)) continue;
      if (entry.type === "model_change" && !model && typeof entry.provider === "string" && typeof entry.modelId === "string") model = { provider: entry.provider, modelId: entry.modelId };
      if (entry.type === "thinking_level_change" && thinkingLevel === undefined && isThinkingLevel(entry.thinkingLevel)) thinkingLevel = entry.thinkingLevel;
      if (model && thinkingLevel !== undefined) break;
    }
  } catch { /* unreadable: what was read */ }
  return model ? { ...model, ...thinkingLevel !== undefined ? { thinkingLevel } : {} } : undefined;
}

/** A subagent's session file: the one its rlm-subagent.json names, else the one session file in its folder; undefined when neither. */
export async function childSessionFile(childDir: string, spawn?: unknown): Promise<string | undefined> {
  const record = spawn !== undefined ? spawn : await readFile(join(childDir, "rlm-subagent.json"), "utf8").then(text => JSON.parse(text) as unknown, () => null);
  if (isRecord(record) && typeof record.sessionFile === "string") return record.sessionFile;
  const names = (await readdir(childDir).catch(() => [] as string[])).filter(name => name.endsWith(".jsonl") && name !== "semantic-edges.jsonl");
  return names.length === 1 ? join(childDir, names[0]!) : undefined;
}

/**
 * Whether a subagent sent its parent a message after its last message from that parent, read from its own session file: the parent's
 * messages are `agent_message` custom messages with `fromRelationship: "parent"`, and its sends are toolResult `sentAgentMessages` with
 * `receiverRole: "parent"`. This is the daemon's `repliedSinceTask`, which a row of a session the daemon no longer holds leaves out: clean-room
 * w81 run4 on 10-26, where the idle unload stopped "test file count" at 04:30Z, and the service restarts of 04:40Z and 05:04Z left its
 * detached chat with no record of the reply. Undefined when the file names no message from the parent or cannot be read.
 */
export async function sessionReplied(file: string): Promise<boolean | undefined> {
  let replied: boolean | undefined;
  try {
    for await (const line of fileLines(file)) {
      const task = line.startsWith('{"type":"custom_message","customType":"agent_message"');
      if (!task && !line.includes('"sentAgentMessages"')) continue;
      const entry: unknown = JSON.parse(line);
      if (!isRecord(entry)) continue;
      if (task) { if (isRecord(entry.details) && entry.details.fromRelationship === "parent") replied = false; continue; }
      const message = isRecord(entry.message) ? entry.message : undefined;
      const sent = message?.role === "toolResult" && isRecord(message.details) && Array.isArray(message.details.sentAgentMessages) ? message.details.sentAgentMessages : [];
      if (replied !== undefined && sent.some(item => isRecord(item) && item.receiverRole === "parent")) replied = true;
    }
  } catch { return undefined; }
  return replied;
}

/**
 * A subagent's model and thinking level: the model its handle asked for (`rlm-subagent.json` `model`), else its session file's, with the
 * thinking level from its session file, since rlm-subagent.json keeps none. Undefined when neither names a model.
 */
export async function jobModel(childDir: string): Promise<JobModel | undefined> {
  const spawn: unknown = await readFile(join(childDir, "rlm-subagent.json"), "utf8").then(text => JSON.parse(text), () => null);
  const asked = isRecord(spawn) && isRecord(spawn.model) && typeof spawn.model.provider === "string" && typeof spawn.model.modelId === "string"
    ? { provider: spawn.model.provider, modelId: spawn.model.modelId } : undefined;
  const file = await childSessionFile(childDir, spawn);
  const ran = file !== undefined ? await sessionModel(file) : undefined;
  const model = asked ?? ran;
  if (!model) return undefined;
  const thinkingLevel = ran?.thinkingLevel;
  return { provider: model.provider, modelId: model.modelId, ...thinkingLevel !== undefined ? { thinkingLevel } : {} };
}

/**
 * A job's brief: the prompt the daemon stored at the spawn (`rlm-subagent.json`, which keeps prompts of 4,096 characters or fewer), else the task
 * its session file in its folder `childDir` opens with: the first `agent_message` custom message, a `[task from parent]` (frontend bro 10-14:
 * connections multiple accounts had a longer brief, no user message, and the cleanup kept it as "its brief could not be read"), or a first
 * user message. Undefined when none can be read.
 */
export async function jobBrief(childDir: string): Promise<string | undefined> {
  const spawn = await spawnRecord(childDir);
  if (spawn) return spawn.prompt;
  const names = await readdir(childDir).catch(() => [] as string[]);
  for (const name of names.filter(name => name.endsWith(".jsonl") && name !== "semantic-edges.jsonl")) {
    const brief = await sessionBrief(join(childDir, name));
    if (brief !== undefined) return brief;
  }
  return undefined;
}

/** The task a session file opens with: its first `agent_message` custom message (a `[task from parent]`) or its first user message (a root's prompt). */
export async function sessionBrief(file: string): Promise<string | undefined> {
  const lines = fileLines(file);
  try {
    for await (const line of lines) {
      const task = line.startsWith('{"type":"custom_message","customType":"agent_message"');
      if (!task && !line.includes('"role":"user"')) continue;
      const entry = JSON.parse(line) as { content?: unknown; message?: { role?: string; content?: unknown } };
      if (!task && entry.message?.role !== "user") continue;
      const text = contentText(task ? entry.content : entry.message!.content);
      if (text !== undefined) return text.replace(/^\[task from parent\]\s*/, "");
    }
  } catch { return undefined; }
  return undefined;
}
const contentText = (content: unknown): string | undefined => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => typeof part === "object" && part && "text" in part ? String(part.text) : "").join("") : undefined;

/** What a step holds, as one line: `p12 waits for "the r14 sha"`, `p12 waits until 2026-10-14T12:00:00Z`, or `p12 is doing` for a step with no wait. */
export function waitText(item: PlanItem): string {
  const waits = [item.waitFor !== undefined ? `for "${item.waitFor}"` : "", item.waitUntil !== undefined ? `until ${item.waitUntil}` : ""].filter(Boolean);
  return waits.length ? `${item.id} waits ${waits.join(" and ")}` : `${item.id} is ${item.status}`;
}

/** The name of the fresh job the cleanup starts in place of a job it ended (`resumeBrief`). */
export const resumeJobName = (job: string, at: number): string => `${job} resumed ${clockTime(at)}`;
/**
 * The brief of the fresh root job the cleanup starts at once in place of a job it ended while that job waited on open steps, so the steps keep
 * a live owner. launch main bro 10-20: the cleanup ended "g2g accounts setup" at 09:26Z with p105 and p98 waiting on promote 16 and 17, and the
 * steps had no owner until the d9 run started a job by hand at 09:41Z, since the next check-in waited on provider rate limits.
 */
export function resumeBrief(resume: JobResume, path: string, chat: string, now: number): string {
  const steps = resume.steps.join(", ");
  return `${resume.brief}\n\n(The chat service started this job at ${clockTime(now)} in place of "${resume.job}", which it ended while that job sat ` +
    `quiet with ${steps} open: ${resume.event}. Its last report and the waits are saved in ${path}; read that first. ${steps} ${resume.steps.length === 1 ? "is" : "are"} ` +
    `yours now. Check whether each wait has happened and do the next action. If it has not, push whatever moves it, then sleep on ` +
    `board.wake(run=...) or board.wake(at=...) and end your turn; never end a turn with a step open and no wake set. You are a root job of the chat ` +
    `${chat}, so wherever this brief says to send to your parent, send to the chat with agent_message.send(report, receiver_role="sibling", receiver_name="${chat}").)`;
}
/** The note line a step gets when the cleanup starts a fresh job for it (`resumeBrief`). */
export const resumedNote = (job: string, at: number): string => `Resumed: the chat service started job ${job} at ${clockTime(at)} from the saved state, and the step is its.`;
/** The note line a step gets when the cleanup finds a live session that carries the job it ended, so it starts no copy. */
export const keptCopyNote = (job: string, at: number): string => `Kept: job ${job} still carries this work at ${clockTime(at)}, so the chat service started no copy, and the step is its.`;
/** The job a session carries, its name less every " resumed HH:MM" the cleanup added (`resumeJobName`). */
export const jobBase = (name: string): string => name.replace(/(?:\s+resumed \d\d:\d\d)+$/, "").trim();

/**
 * The fresh job a saved state started (`resumed`, which the cleanup writes once that job starts), when a step it took now names another
 * worker and no step names it any more, with those steps and their workers. A state with no `resumed`, such as every file saved before
 * fbd5a0a0, names no fresh job, so it never counts as replaced: only the board's current owners decide. chat-2572 10-23: the chat gave p5, p8
 * and p10 to new workers after the resumed roots 01a16497, 01a16443 and 01a1642b stopped on the Claude limit, and the resume pass kept
 * continuing the old roots each time pi-pool admitted them (00:47Z to 00:51Z), so each wrote a failed turn and the chat got "ended (error)
 * with no report" for work it had moved.
 */
export function replacedJob(resume: JobResume, plan: readonly PlanItem[]): { id: string; name: string; steps: { id: string; job: string; sessionId?: string }[] } | undefined {
  if (!resume.resumed) return undefined;
  const { id, name } = resume.resumed;
  const items: PlanItem[] = [];
  const walk = (list: readonly PlanItem[]): void => { for (const item of list) { items.push(item); walk(item.children ?? []); } };
  walk(plan);
  if (items.some(item => item.job === name || item.sessionId === id)) return undefined;
  const steps = items.flatMap(item => resume.steps.includes(item.id) && item.job !== undefined && item.job !== resume.job && item.job !== name
    ? [{ id: item.id, job: item.job, ...item.sessionId !== undefined ? { sessionId: item.sessionId } : {} }] : []);
  return steps.length ? { id, name, steps } : undefined;
}

const SAVED = "Saved state: ";
/** The line the cleanup puts first in a step's note when it ends the step's job, naming the saved state's path. */
export const savedStateNote = (job: string, endedAt: number, path: string): string =>
  `${SAVED}job ${job} ended at ${clockTime(endedAt)} while it was quiet; its brief, last report and wait are in ${path}.`;
/** The saved state path a step's note names (`savedStateNote`), or undefined. */
export function savedStatePath(item: Pick<PlanItem, "note">): string | undefined {
  const line = item.note?.split("\n").find(text => text.startsWith(SAVED));
  return line === undefined ? undefined : / are in (\S+\.json)\.$/.exec(line)?.[1];
}
