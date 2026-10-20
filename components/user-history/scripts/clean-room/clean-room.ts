#!/usr/bin/env node
/**
 * The clean-room check for a harness, skill or tool change (skills/board/references/clean-room.md). It makes a throwaway test chat on the live
 * chat service through the server's own routes, seeds its board from a copy of a real board, sets its check-in interval, and then only watches:
 * the server runs the chat on its own clock, `collect` saves the evidence, `evaluate` judges it against the criteria written before the run,
 * and `teardown` archives the chat and its jobs. Evaluate tears the run down on a pass, fail or void, and collect evaluates when its window ends,
 * so every run is torn down (owner 10-18: "btw when blind test done always clean up").
 *
 *   node --import tsx scripts/clean-room/clean-room.ts setup --scenario checkin-real-task --criteria <file> --cwd <repo> --name <chat name> --every-min <n> --run <dir> [--chat <id>]
 *     (setup that stopped before its window line runs again with the same --run: it finds each create's outcome and never builds the project
 *     again; --chat adopts a chat in its own folder without building anything; a scenario with a control chat also takes --control-name <name>)
 *   node --import tsx scripts/clean-room/clean-room.ts reseed --run <dir>
 *   node --import tsx scripts/clean-room/clean-room.ts say --run <dir> --message <text>
 *   node --import tsx scripts/clean-room/clean-room.ts archive --run <dir>   (chat-tools-reopen: archives the chat alone once it is idle)
 *   node --import tsx scripts/clean-room/clean-room.ts reopen-check --dir <dir> --cwd <repo> [--window-min <n>]   (the Chat reopen duty's whole run)
 *   node --import tsx scripts/clean-room/clean-room.ts kill-worker --run <dir> --until <ISO time> [--name <chat name>]   (lost-brief: start it before setup)
 *   node --import tsx scripts/clean-room/clean-room.ts cancel-job --run <dir> --until <ISO time>   (job-cancel-cleanup: stops and archives the first job whose own record names a path with files)
 *   node --import tsx scripts/clean-room/clean-room.ts stall-jobs --run <dir> --until <ISO time> [--after-min <n>]   (checkin-push-control: aborts each chat's first job once)
 *   node --import tsx scripts/clean-room/clean-room.ts kill-hooks --run <dir> --until <ISO time> --window-min <n>   (token-hook-resume: start it before setup)
 *   node --import tsx scripts/clean-room/clean-room.ts advance-release --run <dir> --until <ISO time>   (detached-report: moves the project's tools/current once)
 *   node --import tsx scripts/clean-room/clean-room.ts collect --run <dir> --until <ISO time>
 *   node --import tsx scripts/clean-room/clean-room.ts evaluate --run <dir>
 *   node --import tsx scripts/clean-room/clean-room.ts teardown --run <dir>
 *   node --import tsx scripts/clean-room/clean-room.ts baseline --scenario checkin-goal-push --before <dir> --out <file>
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chatService, restartAnswer, throughRestart } from "../../src/chat-host.ts";
import { jobRegistry } from "../../src/chat-sources.ts";
import { wikiOrigin } from "../../src/chat-wiki.ts";
import { DutyStore } from "../../src/chat-duty-store.ts";
import { CLEAN_ROOM_CHATS_FILE, CLEAN_ROOM_CORRECTIONS_FILE, parseLedger } from "../../src/chat-corrections.ts";
import { IdIndex } from "../../src/id-index.ts";
import { transactJsonFile } from "../../src/locked-json.ts";
import { adoptedWorkspace, type CreateIo, type CreateRecord, createOrAdopt, findSession, sessionFacts } from "./create-reconcile.ts";
import { emptyBoard, parseBoard } from "../../src/shared/chat-board.ts";
import type { ChatBoard } from "../../src/shared/types.ts";
import { checkinGoalPush } from "./checkin-goal-push.ts";
import { checkinJobSteer } from "./checkin-job-steer.ts";
import { checkinPushControl } from "./checkin-push-control.ts";
import { type ArchiveMark, chatEntries, chatToolsReopen, FOLLOW_UP } from "./chat-tools-reopen.ts";
import { reopenFirstMessage } from "./reopen-first-message.ts";
import { boxBrowserDefault } from "./box-browser-default.ts";
import { boxTools } from "./box-tools.ts";
import { checkinRealTask } from "./checkin-real-task.ts";
import { advanceRelease, detachedReport } from "./detached-report.ts";
import { relativeDuty } from "./relative-duty.ts";
import { correctionRefine } from "./correction-refine.ts";
import { dmReplies } from "./dm-replies.ts";
import { englishJobs } from "./english-jobs.ts";
import { everydayTask } from "./everyday-task.ts";
import { historyLeftovers } from "./history-leftovers.ts";
import { idleUnload } from "./idle-unload.ts";
import { importSpeed } from "./import-speed.ts";
import { kernelRevive } from "./kernel-revive.ts";
import { killWorker, lostBrief } from "./lost-brief.ts";
import { oldCommitTests } from "./old-commit-tests.ts";
import { cancelFile, type CancelRecord, jobCancelCleanup } from "./job-cancel-cleanup.ts";
import { jobDirs, ownedNow } from "./owned-evidence.ts";
import { ordinaryHour } from "./ordinary-hour.ts";
import { readmePreview } from "./readme-preview.ts";
import { savedLogin } from "./saved-login.ts";
import { ownerAsks } from "./owner-asks.ts";
import { plainWords } from "./plain-words.ts";
import { planAndDuties } from "./plan-and-duties.ts";
import { taskAndUpkeep } from "./task-and-upkeep.ts";
import type { RunState, Scenario } from "./session-read.ts";
import { softCaps } from "./soft-caps.ts";
import { stepIds } from "./step-ids.ts";
import { archiveTestPages } from "./wiki-pages.ts";
import { killHooks, tokenHookResume } from "./token-hook-resume.ts";
import { wakeLive } from "./wake-live.ts";

const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const RELEASES = join(homedir(), ".local/share/sieun-pi-chat");
const SCENARIOS: Record<string, Scenario> = { "checkin-goal-push": checkinGoalPush, "checkin-real-task": checkinRealTask, "checkin-push-control": checkinPushControl, "correction-refine": correctionRefine, "dm-replies": dmReplies, "english-jobs": englishJobs, "everyday-task": everydayTask, "import-speed": importSpeed,
  "checkin-job-steer": checkinJobSteer, "chat-tools-reopen": chatToolsReopen, "reopen-first-message": reopenFirstMessage, "kernel-revive": kernelRevive, "lost-brief": lostBrief, "ordinary-hour": ordinaryHour, "idle-unload": idleUnload, "owner-asks": ownerAsks, "plan-and-duties": planAndDuties, "task-and-upkeep": taskAndUpkeep, "soft-caps": softCaps, "step-ids": stepIds, "token-hook-resume": tokenHookResume, "wake-live": wakeLive, "box-browser-default": boxBrowserDefault, "box-tools": boxTools,
  "detached-report": detachedReport, "relative-duty": relativeDuty, "old-commit-tests": oldCommitTests, "readme-preview": readmePreview, "history-leftovers": historyLeftovers, "plain-words": plainWords, "saved-login": savedLogin , "job-cancel-cleanup": jobCancelCleanup };

function args(argv: readonly string[]): { command: string; flags: Record<string, string> } {
  const [command = "", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (!key.startsWith("--") || rest[i + 1] === undefined) throw new Error(`expected --flag value, got ${key}`);
    flags[key.slice(2)] = rest[++i]!;
  }
  return { command, flags };
}
const need = (flags: Record<string, string>, key: string): string => {
  const value = flags[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
};
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJson = (path: string, value: unknown): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 1)); };
const log = (run: string, line: string): void => { const text = `${new Date().toISOString()} ${line}\n`; appendFileSync(join(run, "clean-room.log"), text); process.stdout.write(text); };

/** The live chat server (src/chat-host.ts chatService): its base URL and write token. */
export interface Server { base: string; origin: string; token: string }
export async function server(): Promise<Server> {
  const service = await chatService(DATA);
  if (!service) throw new Error(`no chat service is set up in ${DATA} or in hosts.json`);
  return { base: service.base, origin: service.origin, token: service.token };
}
async function call(srv: Server, method: "GET" | "POST", route: string, body?: unknown): Promise<unknown> {
  const text = await throughRestart(async () => {
    const response = await fetch(srv.base + route, { method, headers: { "content-type": "application/json", "x-chat-token": srv.token, origin: srv.origin,
      ...(SELF ? { "x-chat-agent-session": SELF } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180_000) });
    const answer = await response.text();
    if (restartAnswer(response.status, answer)) throw new Error(`Chat service answered ${response.status}`);
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${answer.slice(0, 300)}`);
    return answer;
  });
  return text ? JSON.parse(text) : null;
}
const requestId = (): string => randomBytes(12).toString("hex");
const MODEL = { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" };

const SESSIONS = join(homedir(), ".prime/agent/sessions");

/** `<run>/setup.pending.json`: the project setup built and every create it asked for, written before each POST and kept until the window starts. */
interface Pending { sandbox: string; creates: Record<string, CreateRecord> }
const pendingFile = (run: string): string => join(run, "setup.pending.json");

/** One `POST api/threads`, the route the New chat dialog uses, with no client timeout: the server answers once its create settles. */
async function postCreate(srv: Server, record: CreateRecord): ReturnType<CreateIo["post"]> {
  let status = 0;
  let text = "";
  try {
    const response = await fetch(srv.base + "api/threads", { method: "POST", headers: { "content-type": "application/json", "x-chat-token": srv.token, origin: srv.origin,
      ...(SELF ? { "x-chat-agent-session": SELF } : {}) },
      body: JSON.stringify({ requestId: record.requestId, cwd: record.cwd, message: record.message, name: record.name, kind: record.kind, ...MODEL }) });
    status = response.status;
    text = await response.text();
  } catch (error) { return { kind: "unknown", error: error instanceof Error ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}` : String(error) }; }
  let body: { id?: unknown; error?: unknown } = {};
  try { body = JSON.parse(text) as typeof body; } catch { /* a gateway page */ }
  if (status === 200 && typeof body.id === "string") return { kind: "made", id: body.id };
  if (typeof body.error === "string") return { kind: "refused", status, error: body.error };
  return { kind: "unknown", error: `${status} ${text.slice(0, 300)}` };
}

/** Creates the test chat, its control or a fixture thread, or adopts the session an earlier try of the same create made (create-reconcile.ts). */
async function createThread(srv: Server, run: string, pending: Pending, role: string, kind: "chat" | "thread", name: string, cwd: string, message: string): Promise<{ id: string; name: string }> {
  const save = (): void => writeJson(pendingFile(run), pending);
  const record = pending.creates[role] ??= { kind, name, names: [name], cwd, message, requestId: requestId(), since: Date.now() };
  const io: CreateIo = {
    post: one => postCreate(srv, one),
    find: async one => findSession(SESSIONS, one, new Set(await new IdIndex(join(DATA, "chats.json"), "Chat index").ids())),
    archive: async id => { await call(srv, "POST", `api/threads/${id}/archive`, {}).catch((error: unknown) => { if (!/: 404 /.test(String(error))) throw error; }); },
    deliver: async (id, text, rid) => { await call(srv, "POST", `api/threads/${id}/prompt`, { message: text, images: [], mode: "steer", requestId: rid }); },
    save, log: line => log(run, line), newRequestId: requestId, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now,
  };
  const { id } = await createOrAdopt(record, io);
  return { id, name: record.name };
}
const setCheckIn = (srv: Server, chat: string, body: Record<string, unknown>) => call(srv, "POST", `api/threads/${chat}/check-in`, body);
/** This job's session id, sent as the agent that changes a check-in, so the setting names who paused it. */
const SELF = process.env.CLEAN_ROOM_SESSION ?? "";

/** Replaces a board file under the board store's lock, so no chat_board write interleaves. */
async function seedBoard(chat: string, board: ChatBoard): Promise<void> {
  const seed = structuredClone(board);
  await transactJsonFile({ path: join(DATA, "boards", `${chat}.json`), label: "Chat board", parse: value => (typeof value === "object" && value !== null ? value : {}) as ChatBoard,
    initial: () => structuredClone(seed) }, state => {
    for (const key of Object.keys(state)) delete (state as unknown as Record<string, unknown>)[key];
    Object.assign(state, structuredClone(seed));
  });
  const written = parseBoard(JSON.parse(readFileSync(join(DATA, "boards", `${chat}.json`), "utf8")));
  if (written.rev !== board.rev || written.plan.length !== board.plan.length) throw new Error(`the seeded board reads rev ${written.rev} with ${written.plan.length} goals`);
}

/** The board a scenario starts from: the `--board` copy, or an empty board for a scenario that writes its own. */
const copyOf = (path: string): ChatBoard => path ? parseBoard(readJson(path)) : emptyBoard(new Date().toISOString());

const liveRelease = (): string => { try { return readlinkSync(join(RELEASES, "current")); } catch { return "unknown"; } };

async function setup(flags: Record<string, string>): Promise<void> {
  const scenario = SCENARIOS[need(flags, "scenario")];
  if (!scenario) throw new Error(`unknown scenario; known: ${Object.keys(SCENARIOS).join(", ")}`);
  const run = need(flags, "run");
  const criteria = need(flags, "criteria");
  if (existsSync(join(run, "run.json"))) throw new Error(`${run} already holds a run`);
  mkdirSync(run, { recursive: true });
  copyFileSync(criteria, join(run, "criteria.md"));
  // A setup that stopped before its window line runs again with the same run folder: the project it built and its creates come from the
  // pending file, and nothing is built twice. --chat adopts a chat by id in the folder its session runs in and builds nothing either.
  const earlier = existsSync(pendingFile(run)) ? readJson<Pending>(pendingFile(run)) : undefined;
  const adopted = flags.chat;
  const adoptedChat = adopted ? sessionFacts(join(SESSIONS, `${adopted}.jsonl`)) : undefined;
  let sandbox: string;
  if (adopted) sandbox = adoptedWorkspace(adoptedChat, earlier?.sandbox);
  else if (earlier) {
    if (!existsSync(earlier.sandbox)) throw new Error(`${run}: the project ${earlier.sandbox} that setup built is gone; setup never builds it again, so start a new run folder`);
    sandbox = earlier.sandbox;
  } else {
    sandbox = scenario.prepare ? scenario.prepare(run) : scenario.agentsMd ? join(run, "sandbox") : need(flags, "cwd");
    if (scenario.agentsMd) { mkdirSync(sandbox, { recursive: true }); writeFileSync(join(sandbox, "AGENTS.md"), scenario.agentsMd(sandbox)); }
  }
  const pending: Pending = earlier ?? { sandbox, creates: {} };
  writeJson(pendingFile(run), pending);
  const everyMin = Number(need(flags, "every-min"));
  const srv = await server();
  const control = scenario.control && flags["control-name"] ? { ...scenario.control, name: flags["control-name"] } : scenario.control;
  if (adopted && adoptedChat) {
    const named = adoptedChat.name || need(flags, "name");
    pending.creates.chat = { kind: "chat", name: named, names: [named], cwd: sandbox, message: scenario.headMessage(named), requestId: "", since: adoptedChat.at, id: adopted, adopted: true };
  }
  const asked = pending.creates.chat?.names[0] ?? need(flags, "name");
  const [made, madeControl] = await Promise.all([createThread(srv, run, pending, "chat", "chat", asked, sandbox, scenario.headMessage(asked)),
    control ? createThread(srv, run, pending, "control", "chat", control.name, sandbox, control.message(control.name)) : Promise.resolve(undefined)]);
  const chat = made.id;
  const name = made.name;
  const headMessage = pending.creates.chat!.message;
  const controlId = madeControl?.id;
  const adoptedAt = pending.creates.chat!.adopted ? sessionFacts(join(SESSIONS, `${chat}.jsonl`))?.at ?? NaN : NaN;
  for (const id of [chat, ...(controlId ? [controlId] : [])]) await new IdIndex(join(DATA, CLEAN_ROOM_CHATS_FILE), "Clean-room chat index").add(id);
  log(run, `${pending.creates.chat!.adopted ? "adopted" : "created"} chat ${chat} "${name}" in ${sandbox}, filed in ${CLEAN_ROOM_CHATS_FILE} so its corrections go to the scratch ledger and it stays out of the owner's sidebar and For you`);
  if (control && madeControl) {
    await setCheckIn(srv, madeControl.id, { pause: "forever" });
    log(run, `created control chat ${controlId} "${madeControl.name}", filed the same way, and paused its check-in`);
  }
  const fixtures: Record<string, string> = {};
  const fixtureBriefs: string[] = [];
  let changes: string[] = [];
  const state: RunState = { scenario: scenario.name, chat: { id: chat, name }, fixtures, sandbox, everyMs: everyMin * 60_000, release: liveRelease(),
    board: flags.board ?? "", seeds: [headMessage], setupAt: Number.isNaN(adoptedAt) ? Date.now() : adoptedAt, windowStart: 0,
    ...(control && madeControl ? { control: { id: madeControl.id, name: madeControl.name } } : {}) };
  if (scenario.board) {
    await setCheckIn(srv, chat, { pause: "forever" });
    log(run, "paused its check-in while the board is seeded");
    const registry = jobRegistry(join(DATA, "chat-jobs.json"));
    for (const fixture of scenario.fixtures) {
      const logFile = join(run, `fixture-${fixture.name.replace(/\W+/g, "-")}.jsonl`);
      const brief = fixture.brief({ chat, chatName: name, logFile, sandbox });
      const { id } = await createThread(srv, run, pending, `fixture:${fixture.name}`, "thread", fixture.name, sandbox, brief);
      await registry.add([fixture.name, id], name, chat);
      fixtures[fixture.name] = id;
      fixtureBriefs.push(brief);
      log(run, `created fixture ${id} "${fixture.name}", filed under the chat in chat-jobs.json`);
    }
    const seeded = scenario.board(copyOf(flags.board ?? ""), { fixtures, sandbox });
    changes = seeded.changes;
    await seedBoard(chat, seeded.board);
    log(run, `seeded board rev ${seeded.board.rev} from ${flags.board ?? "the scenario"}`);
    state.seeds.push(...fixtureBriefs);
  }
  writeJson(join(run, "run.json"), state);
  writeFileSync(join(run, "setup.md"), scenario.setupNotes(state, changes));
  await setCheckIn(srv, chat, { everyMs: state.everyMs, ...(scenario.board ? { pause: null } : {}) });
  state.windowStart = state.setupAt;
  writeJson(join(run, "run.json"), state);
  rmSync(pendingFile(run), { force: true });
  log(run, `check-in every ${everyMin} min on ${state.release}; the measured window started at ${new Date(state.windowStart).toISOString()} and nobody steps in`);
}

/** Seeds the board again from the run's copy and opens a new window: for a setup whose seed failed, with the check-in paused around it. */
async function reseed(flags: Record<string, string>): Promise<void> {
  const run = need(flags, "run");
  const state = readJson<RunState>(join(run, "run.json"));
  const scenario = SCENARIOS[state.scenario]!;
  const srv = await server();
  await setCheckIn(srv, state.chat.id, { pause: "forever" });
  if (!scenario.board) throw new Error(`${state.scenario} seeds no board`);
  const { board } = scenario.board(copyOf(state.board), { fixtures: state.fixtures, sandbox: state.sandbox });
  await seedBoard(state.chat.id, board);
  log(run, `seeded board rev ${board.rev} again from ${state.board}`);
  await setCheckIn(srv, state.chat.id, { everyMs: state.everyMs, pause: null });
  state.windowStart = Date.now();
  writeJson(join(run, "run.json"), state);
  log(run, `check-in resumed every ${state.everyMs / 60_000} min; a new measured window starts now`);
}

/** Every session id the run knows: the chat, its fixtures, its agents, the board's step sessions and its duty jobs. */
function knownSessions(run: string, state: RunState): Set<string> {
  const ids = new Set<string>([state.chat.id, ...Object.values(state.fixtures), ...(state.control ? [state.control.id] : [])]);
  for (const agents of [join(run, "agents"), join(run, "control", "agents")]) {
    if (existsSync(agents)) for (const file of readdirSync(agents)) for (const agent of readJson<{ sessionId?: string }[]>(join(agents, file))) if (agent.sessionId) ids.add(agent.sessionId);
  }
  const runs = join(run, "runs.jsonl");
  if (existsSync(runs)) for (const line of readFileSync(runs, "utf8").split("\n")) if (line.trim()) { const id = (JSON.parse(line) as { job?: { id?: string } }).job?.id; if (id) ids.add(id); }
  const boardFile = join(DATA, "boards", `${state.chat.id}.json`);
  if (existsSync(boardFile)) {
    const visit = (items: readonly { sessionId?: string; children?: readonly unknown[] }[]): void => {
      for (const item of items) { if (item.sessionId && /^[0-9a-f-]{36}$/.test(item.sessionId)) ids.add(item.sessionId); visit((item.children ?? []) as never); }
    };
    visit(readJson<ChatBoard>(boardFile).plan as never);
  }
  return ids;
}

/** One pass of evidence: the board when its rev changed, the chat's agents, its duty runs, new Prompt view captures and its service.log lines. */
async function collectOnce(run: string, state: RunState, srv: Server, logOffset: { at: number }): Promise<void> {
  const boardFile = join(DATA, "boards", `${state.chat.id}.json`);
  if (existsSync(boardFile)) {
    const board = readJson<ChatBoard>(boardFile);
    const out = join(run, "boards", `${String(board.rev).padStart(6, "0")}.json`);
    if (!existsSync(out)) writeJson(out, board);
  }
  try {
    const { agents } = await call(srv, "GET", `api/threads/${state.chat.id}/agents`) as { agents: unknown[] };
    const text = JSON.stringify(agents);
    const dir = join(run, "agents");
    mkdirSync(dir, { recursive: true });
    const last = readdirSync(dir).sort().at(-1);
    if (!last || readFileSync(join(dir, last), "utf8") !== text) writeFileSync(join(dir, `${Date.now()}.json`), text);
  } catch (error) { log(run, `agents: ${error instanceof Error ? error.message : String(error)}`); }
  const runs = join(DATA, "duties", `${state.chat.id}.runs.jsonl`);
  if (existsSync(runs)) copyFileSync(runs, join(run, "runs.jsonl"));
  if (state.control) {
    const controlBoard = join(DATA, "boards", `${state.control.id}.json`);
    if (existsSync(controlBoard)) {
      const board = readJson<ChatBoard>(controlBoard);
      const out = join(run, "control", "boards", `${String(board.rev).padStart(6, "0")}.json`);
      if (!existsSync(out)) writeJson(out, board);
    }
    const controlRuns = join(DATA, "duties", `${state.control.id}.runs.jsonl`);
    if (existsSync(controlRuns)) copyFileSync(controlRuns, join(run, "control", "runs.jsonl"));
    writeJson(join(run, "control", "check-in-setting.json"), readJson<Record<string, unknown>>(join(DATA, "check-in-settings.json"))[state.control.id] ?? null);
    try {
      const { agents } = await call(srv, "GET", `api/threads/${state.control.id}/agents`) as { agents: unknown[] };
      const dir = join(run, "control", "agents");
      mkdirSync(dir, { recursive: true });
      const text = JSON.stringify(agents);
      const last = readdirSync(dir).sort().at(-1);
      if (!last || readFileSync(join(dir, last), "utf8") !== text) writeFileSync(join(dir, `${Date.now()}.json`), text);
    } catch (error) { log(run, `control agents: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const settings = readJson<Record<string, unknown>>(join(DATA, "check-in-settings.json"))[state.chat.id];
  writeJson(join(run, "check-in-setting.json"), settings ?? null);
  for (const id of knownSessions(run, state)) {
    const capture = join(DATA, "prompts", `${id}.json`);
    if (!existsSync(capture)) continue;
    const { capturedAt } = readJson<{ capturedAt: string }>(capture);
    const out = join(run, "prompts", id, `${capturedAt.replace(/[:.]/g, "-")}.json`);
    if (!existsSync(out)) { mkdirSync(dirname(out), { recursive: true }); copyFileSync(capture, out); }
  }
  const service = join(DATA, "service.log");
  const size = statSync(service).size;
  if (logOffset.at === 0 || size < logOffset.at) logOffset.at = Math.max(0, size - 2_000_000);
  if (size > logOffset.at) {
    const fd = readFileSync(service).subarray(logOffset.at, size).toString("utf8");
    logOffset.at = size;
    const short = state.chat.id.slice(0, 8);
    const mine = fd.split("\n").filter(line => line.includes(short) || line.includes(state.chat.name) || Object.values(state.fixtures).some(id => line.includes(id.slice(0, 8))));
    if (mine.length) appendFileSync(join(run, "service.log"), mine.join("\n") + "\n");
  }
}

async function collect(flags: Record<string, string>): Promise<void> {
  const run = need(flags, "run");
  const until = Date.parse(need(flags, "until"));
  const everyMs = Number(flags["every-s"] ?? 60) * 1000;
  const srv = await server();
  const offset = { at: 0 };
  writeJson(join(run, "run.json"), { ...readJson<RunState>(join(run, "run.json")), until });
  log(run, `collect until ${new Date(until).toISOString()}`);
  while (Date.now() < until) {
    if (!existsSync(join(run, "run.json"))) return;
    const state = readJson<RunState>(join(run, "run.json"));
    try { await collectOnce(run, state, srv, offset); } catch (error) { log(run, `collect: ${error instanceof Error ? error.message : String(error)}`); }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(everyMs, until - Date.now()))));
  }
  if (!existsSync(join(run, "run.json"))) return;
  // A later collect that moved the window on owns the end of the run.
  if ((readJson<RunState>(join(run, "run.json")).until ?? 0) > Date.now()) { log(run, "collect done; a later collect holds the window"); return; }
  log(run, "collect done; the window ended, so the run is judged and torn down");
  await evaluate({ run });
}

/** The owner's next message in a scenario that has one, sent through the composer's route and recorded as a seed, so the judge counts it as his. */
async function say(flags: Record<string, string>): Promise<void> {
  const run = need(flags, "run");
  const message = need(flags, "message");
  const state = readJson<RunState>(join(run, "run.json"));
  state.seeds.push(message);
  writeJson(join(run, "run.json"), state);
  // Every attempt is logged, a failed one too, so a check can tell a first send that landed from one that needed a retry.
  const id = requestId();
  log(run, `sending the owner's message (request ${id})`);
  try {
    await call(await server(), "POST", `api/threads/${state.chat.id}/prompt`, { message, images: [], mode: "steer", requestId: id });
  } catch (error) {
    log(run, `send failed (request ${id}): ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  log(run, `sent the owner's message (request ${id}): ${message}`);
}

/**
 * Archives the test chat alone through the archive route, the owner's archive button, once it is idle: its last turn ended with a stop, its
 * session file has not changed for a minute and none of its jobs runs. Records the time, the session file's length and the board rev.
 */
async function archive(flags: Record<string, string>): Promise<void> {
  const run = need(flags, "run");
  const state = readJson<RunState>(join(run, "run.json"));
  const srv = await server();
  const file = join(homedir(), ".prime/agent/sessions", `${state.chat.id}.jsonl`);
  const entries = chatEntries(state.chat.id);
  const last = entries.filter(entry => entry.role === "assistant" || entry.role === "user" || entry.role === "toolResult" || entry.customType === "agent_message").at(-1);
  const quietMs = Date.now() - statSync(file).mtimeMs;
  const { agents } = await call(srv, "GET", `api/threads/${state.chat.id}/agents`) as { agents: { state?: string; name?: string }[] };
  const working = agents.filter(agent => agent.state === "working" || agent.state === "queued");
  if (last?.role !== "assistant" || last.stopReason !== "stop" || quietMs < 60_000 || working.length)
    throw new Error(`not idle: last ${last?.role ?? "none"} ${last?.stopReason ?? ""}, quiet ${Math.round(quietMs / 1000)} s, ${working.length} jobs at work`);
  const boardFile = join(DATA, "boards", `${state.chat.id}.json`);
  const rev = existsSync(boardFile) ? readJson<{ rev?: number }>(boardFile).rev ?? 0 : 0;
  const lines = readFileSync(file, "utf8").split("\n").filter(line => line.trim()).length;
  const mark: ArchiveMark = { at: Date.now(), lines, rev, idle: `idle: last reply stopped at ${new Date(last.at).toISOString()}, quiet ${Math.round(quietMs / 1000)} s, ${agents.length} jobs, none at work` };
  // The intent goes first: on a timeout or a failed local write after the POST, the run still shows that it asked.
  writeJson(join(run, "archive.json"), { ...mark, sent: false });
  log(run, `archiving chat ${state.chat.id} through POST api/threads/<id>/archive`);
  await call(srv, "POST", `api/threads/${state.chat.id}/archive`, {});
  writeJson(join(run, "archive.json"), { ...mark, sent: true, answeredAt: Date.now() });
  log(run, `archived chat ${state.chat.id} alone through the archive route (${mark.idle}); ${lines} session lines, board rev ${rev}`);
}

/** The Chat reopen duty's criteria, the file run-3 passed on by hand on 10-18. */
const REOPEN_CRITERIA = join(homedir(), ".prime/agent/clean-room/reopen-first-message/criteria.md");
/**
 * The window of one reopen check. On 10-18 run-3's first reply took 51 s and its follow-up reply 34 s, but on 10-15 a duty's first turn waited
 * 1,604 s in the turn queue (pi-pool.log, src/chat-duty-job.ts), and this run has two turns that can wait like that.
 */
const REOPEN_WINDOW_MIN = 60;

/**
 * The Chat reopen duty's whole check (scripts/duties/chat-reopen.duty.json): a fresh chat in a new run folder under --dir gets the
 * reopen-first-message task, is archived through the route once it is idle, gets the one follow-up, and is judged when its verdict settles or
 * the window ends. Evaluate then tears the run down. The setup, archive, send and verdict evidence and a cleanup note stay in
 * `<run>.evidence/`, next to the verdict file. Nothing here resends the follow-up or touches the chat between those steps.
 */
async function reopenCheck(flags: Record<string, string>): Promise<void> {
  const dir = need(flags, "dir");
  const started = new Date();
  const local = started.toLocaleString("sv-SE").slice(5, 16);
  const run = join(dir, started.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-"));
  const until = started.getTime() + Number(flags["window-min"] ?? REOPEN_WINDOW_MIN) * 60_000;
  try { await reopenRun(flags, run, until, local); }
  catch (error) {
    // A check that could not run, such as a setup with no chat service or no account, is a failed check, never a pass the precheck could read.
    const text = error instanceof Error ? error.message : String(error);
    if (!existsSync(dirname(run)) || !readdirSync(dirname(run)).some(name => name.startsWith(`${basename(run)}.`) && name.endsWith(".md"))) {
      mkdirSync(dirname(run), { recursive: true });
      writeFileSync(`${run}.fail.md`, [`# ${basename(run)}: fail`, "", `The reopen check could not run: ${text}`, "",
        "Readings: followup_answered 0, tools_after_reopen 0, chat_listed_after_reopen 0", ""].join("\n"));
    }
    if (existsSync(join(run, "run.json"))) await teardown({ run }).catch(() => {});
    throw error;
  }
}

async function reopenRun(flags: Record<string, string>, run: string, until: number, local: string): Promise<void> {
  await setup({ scenario: "reopen-first-message", criteria: flags.criteria ?? REOPEN_CRITERIA, cwd: need(flags, "cwd"),
    name: flags.name ?? `python refs per folder ${local}`, "every-min": "120", run });
  writeJson(join(run, "run.json"), { ...readJson<RunState>(join(run, "run.json")), until });
  const srv = await server();
  const offset = { at: 0 };
  let wake = (): void => {};
  const pause = (ms: number) => new Promise<void>(done => { const timer = setTimeout(done, Math.max(0, Math.min(ms, until - Date.now()))); wake = () => { clearTimeout(timer); done(); }; });
  let done = false;
  void (async () => {
    while (!done && Date.now() < until) {
      await (async () => collectOnce(run, readJson<RunState>(join(run, "run.json")), srv, offset))()
        .catch(error => { if (!done) log(run, `collect: ${error instanceof Error ? error.message : String(error)}`); });
      if (!done) await new Promise<void>(next => { setTimeout(next, 60_000).unref(); });
    }
  })();
  let archived = false;
  while (Date.now() < until) {
    try { await archive({ run }); archived = true; break; }
    catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!text.startsWith("not idle")) { log(run, `archive failed: ${text}`); break; }
    }
    await pause(15_000);
  }
  if (archived) await say({ run, message: FOLLOW_UP }).catch(() => {});
  while (archived && Date.now() < until) {
    const state = readJson<RunState>(join(run, "run.json"));
    await collectOnce(run, state, srv, offset).catch(() => {});
    if ((await reopenFirstMessage.evaluate(run, state)).verdict !== "open") break;
    await pause(30_000);
  }
  done = true;
  wake();
  const evidence = `${run}.evidence`;
  mkdirSync(evidence, { recursive: true });
  const state = readJson<RunState>(join(run, "run.json"));
  writeJson(join(run, "run.json"), { ...state, until: Math.min(until, Date.now()) });
  for (const file of ["run.json", "setup.md", "criteria.md", "archive.json", "check-in-setting.json", "service.log", "clean-room.log"]) {
    if (existsSync(join(run, file))) copyFileSync(join(run, file), join(evidence, file));
  }
  // Evaluate and teardown log to the run's clean-room.log and stdout, and teardown deletes the run folder, so stdout goes to the copy meanwhile.
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => { appendFileSync(join(evidence, "clean-room.log"), chunk); return write(chunk, ...rest); }) as typeof process.stdout.write;
  let teardownError = "";
  await evaluate({ run }).catch((error: unknown) => { teardownError = error instanceof Error ? error.message : String(error); })
    .finally(() => { process.stdout.write = write; });
  const verdict = readdirSync(dirname(run)).find(name => name.startsWith(`${basename(run)}.`) && name.endsWith(".md"));
  const archivedNow = existsSync(join(DATA, "archived-chats.json")) && (readJson<{ ids?: string[] }>(join(DATA, "archived-chats.json")).ids ?? []).includes(state.chat.id);
  const todos = existsSync(join(DATA, "boards", `${state.chat.id}.json`)) ? readJson<ChatBoard>(join(DATA, "boards", `${state.chat.id}.json`)).todos.length : 0;
  writeFileSync(join(evidence, "cleanup.md"), [`# Cleanup of ${basename(run)}`, "",
    `- The run folder ${existsSync(run) ? "is still there" : "is deleted"} and the verdict file is ${verdict ?? "missing"}.`,
    `- The chat ${state.chat.id} is ${archivedNow ? "archived" : "not archived"} and has ${todos} todos.`,
    ...teardownError ? [`- Teardown failed: ${teardownError}`] : [], ""].join("\n"));
  process.stdout.write(`${verdict ? join(dirname(run), verdict) : "no verdict file"}; evidence in ${evidence}\n`);
}

async function evaluate(flags: Record<string, string>): Promise<void> {
  const run = need(flags, "run");
  if (!existsSync(join(run, "run.json"))) { process.stdout.write(`${run} is already torn down; its verdict file sits next to where it was\n`); return; }
  const state = readJson<RunState>(join(run, "run.json"));
  const scenario = SCENARIOS[state.scenario]!;
  const srv = await server().catch(() => null);
  if (srv) await collectOnce(run, state, srv, { at: 0 });
  const { verdict, text } = await scenario.evaluate(run, state);
  const out = join(dirname(run), `${basename(run)}.${verdict}.md`);
  writeFileSync(out, text);
  log(run, `verdict ${verdict}: ${out}`);
  if (verdict !== "open" || (state.until !== undefined && state.until <= Date.now())) await teardown({ run });
}

/**
 * The sessions the test chat owns, which teardown archives: its fixtures, duty jobs and subagents, and a root only when chat-jobs.json files it
 * under the chat. A thread the chat only messaged or named as a step owner is not its own: run-2 of correction-refine on 10-16 listed
 * the realtime layer thread among its agents, and teardown archived it. A child keeps its child: key after a later snapshot lists it as a
 * step thread, since the feature-cut run on 10-18 kept its finished job "duty failure page" open that way.
 */
async function ownSessions(run: string, state: RunState): Promise<string[]> {
  const registry = jobRegistry(join(DATA, "chat-jobs.json"));
  const agents = join(run, "agents");
  const listed = new Map<string, { key: string; name: string }>();
  if (existsSync(agents)) for (const file of readdirSync(agents)) for (const agent of readJson<{ sessionId?: string; key?: string; name?: string }[]>(join(agents, file))) {
    if (agent.sessionId && !listed.get(agent.sessionId)?.key.startsWith("child:")) listed.set(agent.sessionId, { key: agent.key ?? "", name: agent.name ?? "" });
  }
  const fixtures = new Set(Object.values(state.fixtures));
  const runs = join(run, "runs.jsonl");
  const duty = new Set(existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter(line => line.trim()).flatMap(line => { const id = (JSON.parse(line) as { job?: { id?: string } }).job?.id; return id ? [id] : []; }) : []);
  const own: string[] = [];
  for (const id of knownSessions(run, state)) {
    if (id === state.chat.id) continue;
    const agent = listed.get(id);
    const filed = await registry.chatOf(id) ?? (agent?.name ? await registry.chatOf(agent.name) : undefined);
    if (fixtures.has(id) || duty.has(id) || agent?.key.startsWith("child:") || filed === state.chat.name || filed === state.chat.id) own.push(id);
    else log(run, `kept ${id}${agent ? ` (${agent.name})` : ""}: not a session of the test chat`);
  }
  return own;
}

/**
 * The processes whose command line names the run folder: its collect, kill-worker and kill-hooks, and any scratch serve or sampler a job started
 * with its data in the run. This process and its parents are left out, since collect and evaluate tear the run down themselves.
 */
function runProcesses(run: string): number[] {
  let rows: string;
  try { rows = execFileSync("ps", ["-ww", "-ax", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); } catch { return []; }
  const path = resolve(run).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`${path}(?=$|[/\\s"'])`);
  const parents = new Map<number, number>();
  const hits: number[] = [];
  for (const row of rows.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(row);
    if (!match) continue;
    parents.set(Number(match[1]), Number(match[2]));
    if (named.test(match[3]!)) hits.push(Number(match[1]));
  }
  const self = new Set<number>();
  for (let pid = process.pid; pid > 1 && !self.has(pid); pid = parents.get(pid) ?? 0) self.add(pid);
  return hits.filter(pid => !self.has(pid));
}

/**
 * The stall for the check-in push control (owner 10-16: a parent's check-in "nudges a job idle one interval and restarts it after two"): in the
 * chat and in the control, the first job of the chat that makes progress, a goal number above 0 on the board or `afterMs` of its own work,
 * gets its turn aborted once through the abort route. A native abort holds the session's input until the next prompt, so the job sits idle with
 * its readers' reports queued, which is the stall a check-in has to push and the control has nobody to push. r3g on 10-18 could not judge (k)
 * because both jobs finished in 20 min.
 */
async function stallJobs(run: string, until: number, afterMs: number): Promise<void> {
  const srv = await server();
  const state = readJson<RunState>(join(run, "run.json"));
  const chats = [state.chat, ...(state.control ? [state.control] : [])];
  const stalled = new Map<string, string>();
  const seen = new Map<string, number>();
  while (Date.now() < until && stalled.size < chats.length) {
    for (const chat of chats) {
      if (stalled.has(chat.id)) continue;
      const boardFile = join(DATA, "boards", `${chat.id}.json`);
      const board = existsSync(boardFile) ? readJson<ChatBoard>(boardFile) : undefined;
      const moved = (board?.plan ?? []).some(goal => (goal.target?.current ?? 0) > 0);
      const { agents } = await call(srv, "GET", `api/threads/${chat.id}/agents`).catch(() => ({ agents: [] })) as { agents: { sessionId?: string; key?: string; name?: string; state?: string }[] };
      const job = agents.find(agent => agent.sessionId && agent.key?.startsWith("child:") && !/^check-in /.test(agent.name ?? ""));
      if (!job?.sessionId) continue;
      if (!seen.has(job.sessionId)) seen.set(job.sessionId, Date.now());
      if (!moved && Date.now() - seen.get(job.sessionId)! < afterMs) continue;
      try {
        await call(srv, "POST", `api/threads/${job.sessionId}/abort`, {});
        // The job's helpers go too: in r3h the YouTube job's 6 tracers kept writing after its abort and finished the page by 12:55Z.
        for (const helper of agents.filter(agent => agent !== job && agent.key?.startsWith("child:") && agent.state === "working" && !/^check-in /.test(agent.name ?? ""))) {
          const child = helper.sessionId ?? helper.key!.slice("child:".length);
          await call(srv, "POST", `api/threads/${child.startsWith("sub-") ? sessionOnDisk(chat.id, child) ?? child : child}/abort`, {}).catch(error => log(run, `stall helper ${helper.name}: ${error instanceof Error ? error.message : String(error)}`));
        }
        stalled.set(chat.id, job.sessionId);
        log(run, `stalled job ${job.name} (${job.sessionId}) of ${chat.name}: aborted its turn ${moved ? "after the goal's first move" : `after ${Math.round(afterMs / 60_000)} min of work`}`);
      } catch (error) { log(run, `stall ${job.sessionId}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    await new Promise(resolve => setTimeout(resolve, 15_000));
  }
  writeJson(join(run, "stalls.json"), Object.fromEntries(stalled));
}

/**
 * The owner's cancel for job-cancel-cleanup: once a job of the chat has an owned.json (written by its own board.own) naming a path that is
 * there and holds files, it waits 30 s, reads the record again, and stops and archives that job once through the routes the agents dialog's
 * Stop and Archive buttons call. It reads only the job's own record and writes `<run>.cancel.json`; it never writes a record or messages a chat.
 */
async function cancelJob(run: string, until: number): Promise<void> {
  const srv = await server();
  const state = readJson<RunState>(join(run, "run.json"));
  const files = (dir: string): number => { try { return readdirSync(dir).length; } catch { return 0; } };
  while (Date.now() < until) {
    for (const job of jobDirs(state.chat.id).filter(job => job.status !== "deleted" && job.transcripts.length)) {
      const recorded = (): { paths: string[]; units: string[] } => existsSync(join(job.dir, "owned.json")) ? ownedNow([job]) : { paths: [], units: [] };
      if (!recorded().paths.some(path => files(path) > 0)) continue;
      await new Promise(resolve => setTimeout(resolve, 30_000));
      const owned = recorded();
      const present = owned.paths.filter(path => files(path) > 0);
      if (!present.length) continue;
      const session = basename(job.transcripts[0]!, ".jsonl");
      const outcome = (step: Promise<unknown>) => step.then(() => "ok", (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`);
      const abort = await outcome(call(srv, "POST", `api/threads/${session}/abort`, {}));
      const archive = await outcome(call(srv, "POST", `api/threads/${session}/archive`, {}));
      const record: CancelRecord = { at: new Date().toISOString(), job: job.name, childDir: job.dir, session, paths: owned.paths, present, units: owned.units, abort, archive };
      writeJson(cancelFile(run), record);
      log(run, `cancelled job ${job.name} (${session}) through Stop (${abort}) and Archive (${archive}); its record named ${owned.paths.join(", ")} and ${present.join(", ")} held files`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 15_000));
  }
  log(run, "cancel-job: no job recorded a path that held files before --until");
}

/** A spawned helper's session id from its child id's folder under the chat's session-artifacts; undefined when it is not there yet. */
function sessionOnDisk(chat: string, child: string): string | undefined {
  const visit = (dir: string, depth: number): string | undefined => {
    if (depth > 4 || !existsSync(dir)) return undefined;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (!name.startsWith("sub-") || !statSync(path).isDirectory()) continue;
      if (name === child) return readdirSync(path).find(file => file.endsWith(".jsonl") && file !== "semantic-edges.jsonl")?.slice(0, -6);
      const deeper = visit(path, depth + 1);
      if (deeper) return deeper;
    }
    return undefined;
  };
  return visit(join(homedir(), ".prime/agent/session-artifacts", chat), 0);
}

/** Whether a session's own transcript, under one of the run's chats' session-artifacts, ends archived: by its id, or by its child id's folder. */
function archivedOnDisk(chats: readonly string[], id: string): boolean {
  const found: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === `${id}.jsonl`) found.push(path);
      else if (name === id && statSync(path).isDirectory()) found.push(...readdirSync(path).filter(file => file.endsWith(".jsonl") && file !== "semantic-edges.jsonl").map(file => join(path, file)));
      else if (name.startsWith("sub-") && statSync(path).isDirectory()) visit(path, depth + 1);
    }
  };
  for (const chat of chats) visit(join(homedir(), ".prime/agent/session-artifacts", chat), 0);
  return found.length > 0 && found.every(file => {
    const states = readFileSync(file, "utf8").split("\n").filter(line => line.startsWith('{"type":"session_state"'));
    return states.length > 0 && states.at(-1)!.includes('"status":"archived"');
  });
}

/**
 * Ends a run whatever its verdict: stops its processes, pauses the chat's check-in for good and deletes its duties, archives the chat and every job it had through the archive route, marks the wiki
 * pages the chat made as test output (wiki-pages.ts), removes its todos, corrections and wakes, and deletes the run folder. The verdict file next to the folder stays. A failed archive keeps the folder, so the
 * command can run again; a run already torn down is left as it is.
 */
async function teardown(flags: Record<string, string>): Promise<void> {
  const run = need(flags, "run");
  if (!existsSync(join(run, "run.json"))) { process.stdout.write(`${run} is already torn down\n`); return; }
  const state = readJson<RunState>(join(run, "run.json"));
  const scenario = SCENARIOS[state.scenario];
  for (const pid of [...runProcesses(run), ...(scenario?.prepare ? runProcesses(state.sandbox) : [])]) {
    try { process.kill(pid, "SIGTERM"); log(run, `stopped process ${pid}`); } catch (error) { log(run, `stop ${pid}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const srv = await server();
  await collectOnce(run, state, srv, { at: 0 }).catch(() => {});
  const jobs = await ownSessions(run, state);
  const chats = [state.chat.id, ...(state.control ? [state.control.id] : [])];
  const failed: string[] = [];
  const wiki = await wikiOrigin();
  if (wiki) {
    const transcripts = [...new Set([...knownSessions(run, state), ...jobs])].flatMap(id => {
      const file = join(homedir(), ".prime/agent/sessions", `${id}.jsonl`);
      return existsSync(file) ? [readFileSync(file, "utf8")] : [];
    });
    const pages = await archiveTestPages(wiki, transcripts, state.setupAt).catch((error: unknown) => {
      log(run, `wiki pages: ${error instanceof Error ? error.message : String(error)}`);
      return { archived: [], failed: ["wiki changes"] };
    });
    for (const path of pages.archived) log(run, `archived the wiki page ${path} as test output`);
    for (const path of pages.failed) { failed.push(path); log(run, `archive the wiki page ${path} failed`); }
  }
  const archive = (id: string, what: string) => call(srv, "POST", `api/threads/${id}/archive`, {}).then(() => log(run, `archived ${what} ${id}`), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/: 404 /.test(message)) { log(run, `${what} ${id} is gone already`); return; }
    // A job archived with its chat answers 502 "not on this box" once the chat is gone, so its own transcript decides: r3h's job and its 6
    // helpers on 10-18 had all ended archived, and teardown failed on them twice.
    if (archivedOnDisk(chats, id)) { log(run, `${what} ${id} is archived already, by its own transcript`); return; }
    failed.push(id);
    log(run, `archive ${id}: ${message}`);
  });
  for (const id of jobs) await archive(id, "job");
  for (const id of chats) {
    const boardFile = join(DATA, "boards", `${id}.json`);
    if (!existsSync(boardFile)) continue;
    await transactJsonFile({ path: boardFile, label: "Chat board", parse: parseBoard, initial: () => { throw new Error("no board"); } }, board => { board.todos = []; });
    log(run, `removed the todos of ${id}, so the owner's For you does not count them`);
  }
  // An archived chat came back on 10-18: plan-and-duties run-1's chat was re-adopted 1.5 min after teardown, and its 30 min check-in and two
  // daily duties went on starting jobs that pushed to sieun-pi and auto-sns-agent. So the check-in stops for good and the duties go first.
  const duties = new DutyStore(DATA);
  for (const id of chats) {
    await setCheckIn(srv, id, { pause: "forever" }).then(() => log(run, `paused the check-in of ${id} for good`), (error: unknown) => log(run, `check-in of ${id}: ${error instanceof Error ? error.message : String(error)}`));
    for (const duty of await duties.list(id)) if (await duties.remove(id, duty.id)) log(run, `removed duty ${duty.id} "${duty.name}" of ${id}`);
  }
  for (const id of chats) await archive(id, "chat");
  await transactJsonFile({ path: join(DATA, CLEAN_ROOM_CORRECTIONS_FILE), label: "Corrections ledger", parse: parseLedger, initial: () => ({ corrections: [] }) },
    ledger => { ledger.corrections = ledger.corrections.filter(entry => !chats.includes(entry.chat.id)); });
  await jobRegistry(join(DATA, "chat-jobs.json")).remove(Object.keys(state.fixtures).concat(Object.values(state.fixtures)));
  const wakes = join(DATA, "wakes");
  for (const file of existsSync(wakes) ? readdirSync(wakes) : []) {
    if ([...chats, ...jobs].some(id => file.startsWith(id))) { rmSync(join(wakes, file), { force: true }); log(run, `dropped wake ${file}`); }
  }
  if (failed.length) throw new Error(`kept ${run}, because ${failed.length} archives failed; run teardown again`);
  if (scenario?.cleanup) { scenario.cleanup(state); log(run, `removed the project folder ${state.sandbox}`); }
  rmSync(run, { recursive: true, force: true });
  process.stdout.write(`${new Date().toISOString()} deleted the run folder ${run}\n`);
}

async function main(): Promise<void> {
  const { command, flags } = args(process.argv.slice(2));
  if (command === "setup") return setup(flags);
  if (command === "collect") return collect(flags);
  if (command === "say") return say(flags);
  if (command === "archive") return archive(flags);
  if (command === "reopen-check") return reopenCheck(flags);
  if (command === "kill-worker") {
    const run = need(flags, "run");
    const kill = await killWorker(run, Date.parse(need(flags, "until")), flags.name);
    log(run, kill ? `killed worker ${kill.workerId} (pid ${kill.pid}) of the chat after job ${kill.record.name} was spawned` : "kill-worker: no spawn of the chat before --until");
    return;
  }
  if (command === "cancel-job") return cancelJob(need(flags, "run"), Date.parse(need(flags, "until")));
  if (command === "stall-jobs") {
    const run = need(flags, "run");
    await stallJobs(run, Date.parse(need(flags, "until")), Number(flags["after-min"] ?? "8") * 60_000);
    return;
  }
  if (command === "kill-hooks") {
    const run = need(flags, "run");
    const kills = await killHooks(run, Date.parse(need(flags, "until")), Number(need(flags, "window-min")) * 60_000);
    log(run, `kill-hooks: killed ${kills.length} token hook runs of ${new Set(kills.map(kill => kill.session)).size} jobs of the chat`);
    return;
  }
  if (command === "advance-release") return advanceRelease(need(flags, "run"), Date.parse(need(flags, "until")));
  if (command === "reseed") return reseed(flags);
  if (command === "evaluate") return evaluate(flags);
  if (command === "teardown") return teardown(flags);
  if (command === "baseline") {
    const scenario = SCENARIOS[need(flags, "scenario")]!;
    const { verdict, text } = scenario.baseline(need(flags, "before"));
    writeFileSync(need(flags, "out"), text);
    process.stdout.write(`${verdict}: ${flags.out}\n`);
    return;
  }
  throw new Error("usage: clean-room.ts <setup|collect|evaluate|teardown|baseline> --run <dir> ...; see the header of this file");
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exit(1); });
