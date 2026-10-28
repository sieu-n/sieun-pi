import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Kill } from "./lost-brief.ts";
import { nobodySteppedIn } from "./resume-model.ts";
import { readSessionFile, type RunState, type Scenario, type Verdict } from "./session-read.ts";

/**
 * The clean-room scenario w81-brief-keeper B (10-28): the brief keeper's restart of a child that never became a session starts the root job on
 * the model and thinking level the child would have inherited. Since sieun-pi 74114236 the spawn record of a spawn that names neither holds the
 * model the daemon resolved and the chat's thinking level, and the keeper's restart (chat-backend.ts, dutyJobs.start with recordModel) passes
 * them; before it such a record held none and the restart ran on the daemon's default. The path is reached by an injected fault:
 * `clean-room.ts kill-worker`, started before setup, SIGKILLs the chat's own worker the moment the chat's first spawn record appears, as the
 * lost-brief scenario does. The chat runs on openai-codex/gpt-6.1-sol at high and spawns its job with no model or thinking. The criteria live in
 * the run folder's criteria.md.
 */
export const MODEL = { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" };
export const TASK = "have one job count the .ts files under legacy/prime/user-history/src of ~/src/sieun-pi and tell me how many there are. " +
  "start it with rlm.spawn and pass no model and no thinking, so it runs on what it inherits from you";
const HOME = homedir();
const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(HOME, ".prime/agent/browser-chat");
const SESSIONS = join(HOME, ".prime/agent/sessions");
const iso = (at: number): string => new Date(at).toISOString();
const clip = (text: string, length = 200): string => (text.length > length ? text.slice(0, length - 1) + "\u2026" : text).replace(/\s+/g, " ");
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const RESTARTED = /briefs: child .* \((sub-[\w]+)\) never became a session .*; started root job ([0-9a-f-]{36}) of its chat/;
const SENT = /briefs: child .* \((sub-[\w]+)\)/;

/** The spawn calls in the chat's session file: each rlm.spawn call's code, and whether it passes a model or a thinking level. */
function spawnCalls(chat: string): { at: number; named: boolean; code: string }[] {
  return readSessionFile(join(SESSIONS, `${chat}.jsonl`)).flatMap(event => event.kind === "call" && /\brlm\.spawn\s*\(/.test(event.input)
    ? [{ at: event.at, named: /\b(?:model|thinking)\s*=/.test(event.input), code: event.input }] : []);
}

/** A root session file's model and thinking lines and its assistant messages' models and stops. */
function rootFile(file: string): { models: string[]; levels: string[]; turns: { at: number; model: string; stop: string }[] } {
  const out = { models: [] as string[], levels: [] as string[], turns: [] as { at: number; model: string; stop: string }[] };
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (entry.type === "model_change") out.models.push(`${String(entry.provider)}/${String(entry.modelId)}`);
    if (entry.type === "thinking_level_change") out.levels.push(String(entry.thinkingLevel));
    const message = entry.type === "message" ? (entry.message ?? {}) as { role?: string; provider?: unknown; model?: unknown; stopReason?: unknown } : undefined;
    if (message?.role === "assistant") out.turns.push({ at: Date.parse(String(entry.timestamp ?? "")) || 0, model: `${String(message.provider)}/${String(message.model)}`, stop: String(message.stopReason ?? "") });
  }
  return out;
}

function judge(run: string, state: RunState): { verdict: Verdict; text: string } {
  const chat = state.chat.id;
  const want = `${MODEL.provider}/${MODEL.modelId}`;
  const checks: { id: string; ok: boolean | null; detail: string }[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
  const killFile = join(run, "kill.json");
  const kill = existsSync(killFile) ? JSON.parse(readFileSync(killFile, "utf8")) as Kill & { record: Kill["record"] & { model?: string; thinking?: string } } : null;

  // a: the injected fault, once: a SIGKILL of the chat's own worker before the child's first prompt reached its file or the worker's journal.
  add("a", kill ? kill.record.root === chat && !kill.fileStarted && !kill.journalRan : null, kill
    ? `injected fault: ${iso(kill.at)} SIGKILL to worker ${kill.workerId} (pid ${kill.pid}) of the chat, ${Math.round((kill.at - kill.record.at) / 100) / 10} s after job "${kill.record.name}" (${kill.record.id}) was spawned; ` +
      `its file had ${kill.fileStarted ? "a" : "no"} first prompt and the journal ${kill.journalRan ? "had" : "had no"} agent_start for it`
    : "no kill yet");

  // b: the chat spawned the job with no model and no thinking.
  const calls = spawnCalls(chat);
  add("b", calls.length ? calls.every(call => !call.named) : null, calls.length
    ? calls.map(call => `${iso(call.at)} ${call.named ? "names a model or thinking" : "names no model or thinking"}: ${clip(call.code, 160)}`).join("; ") : "no rlm.spawn call in the chat yet");

  // c: the spawn record holds the model the daemon resolved and the chat's thinking level.
  add("c", kill ? kill.record.model === want && kill.record.thinking === MODEL.thinkingLevel : null, kill
    ? `spawn record ${kill.record.kind}-${kill.record.id}: model ${kill.record.model ?? "none"}, thinking ${kill.record.thinking ?? "none"} (the chat runs on ${want} at ${MODEL.thinkingLevel})` : "no record yet");

  // d: the keeper restarted the child as a root job of the chat, not a send to an existing session.
  const log = existsSync(join(run, "service.log")) ? readFileSync(join(run, "service.log"), "utf8").split("\n") : [];
  const id = kill?.record.id ?? "\u0000";
  const restarted = log.map(line => RESTARTED.exec(line)).find(match => match?.[1] === id);
  const other = log.filter(line => SENT.exec(line)?.[1] === id && !RESTARTED.test(line));
  const root = restarted?.[2];
  add("d", root ? true : null, root ? `service.log: ${clip(log.find(line => line.includes(root))!, 260)}`
    : other.length ? `path not reached: the keeper did not restart the child: ${other.map(line => clip(line, 200)).join(" | ")}` : "no keeper line for the child yet");

  // e: the restarted root runs on the model and thinking the child would have inherited, and got a model reply.
  const read = root ? rootFile(join(SESSIONS, `${root}.jsonl`)) : undefined;
  const replied = read ? read.turns.some(turn => turn.stop !== "error" && turn.stop !== "aborted") : false;
  const wrong = read ? read.turns.filter(turn => turn.model !== want) : [];
  add("e", !read || !replied ? null : read.models[0] === want && read.levels[0] === MODEL.thinkingLevel && read.models.every(model => model === want) &&
    read.levels.every(level => level === MODEL.thinkingLevel) && !wrong.length, !read ? "no restarted root yet"
    : `root ${root}: model_change ${read.models.join(", ") || "none"}; thinking_level_change ${read.levels.join(", ") || "none"}; ${read.turns.length} assistant messages, ` +
      `${wrong.length ? `${wrong.length} not on ${want}` : `all on ${want}`}${replied ? "" : ", none with a model reply yet"}`);

  // f: nobody stepped in.
  const stepped = nobodySteppedIn(run, state);
  add("f", stepped.ok, stepped.detail);

  const ended = state.until !== undefined && Date.now() >= state.until;
  const noTurn = !!read && !replied && ended;
  const verdict: Verdict = stepped.ok === false || noTurn ? "void" : checks.some(check => check.ok === null) ? "open"
    : checks.some(check => check.ok === false) ? "fail" : "pass";
  const text = [
    `# Clean-room run ${run.split("/").at(-1)}: ${verdict}`, "",
    `Reached by an injected fault: \`clean-room.ts kill-worker\` SIGKILLed the chat's own worker after its first spawn record (criterion a).`, "",
    `The chat "${state.chat.name}" (${chat}) ran on ${state.release} from ${iso(state.windowStart)} to ${iso(Date.now())}. Judged by \`clean-room.ts evaluate\`.`,
    `Criteria: ${join(run, "criteria.md")}. Evidence: ${killFile}, the chat's session file, the service.log lines of the run, and the restarted root's session file.`, "",
    ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), ...noTurn ? ["", "Void: the restarted root got no model reply by the window end."] : [], "",
  ].join("\n");
  return { verdict, text };
}

export const lostBriefModel: Scenario = {
  name: "lost-brief-model",
  model: MODEL,
  headMessage: () => TASK,
  fixtures: [],
  endsAtVerdict: true,
  jobEvidence: true,
  setupNotes: state => [
    `# Run setup: ${state.chat.name}`, "",
    `The chat ${state.chat.id} was opened through POST api/threads in ${state.sandbox} on ${state.release} on ${MODEL.provider}/${MODEL.modelId} at ${MODEL.thinkingLevel}, with one owner-style first message.`,
    "`clean-room.ts kill-worker`, started before setup, SIGKILLs the chat's Prime worker the moment the chat's first spawn record appears in spawn-briefs/, and writes kill.json. This is the trial's one injected fault.", "",
    "## The message", "", `> ${TASK}`, "",
  ].join("\n"),
  evaluate: (run, state) => judge(run, state),
  baseline: () => { throw new Error("this scenario has no baseline"); },
};
