#!/usr/bin/env node
/**
 * The clean-room check for a harness, skill or tool change (skills/board/references/clean-room.md). It makes a throwaway test chat on the live
 * chat service through the server's own routes, seeds its board from a copy of a real board, sets its check-in interval, and then only watches:
 * the server runs the chat on its own clock, `collect` saves the evidence, `evaluate` judges it against the criteria written before the run,
 * and `teardown` archives the chat and its jobs.
 *
 *   node --import tsx scripts/clean-room/clean-room.ts setup --scenario checkin-goal-push --criteria <file> --board <file> --name <chat name> --every-min <n> --run <dir>
 *   node --import tsx scripts/clean-room/clean-room.ts reseed --run <dir>
 *   node --import tsx scripts/clean-room/clean-room.ts collect --run <dir> --until <ISO time>
 *   node --import tsx scripts/clean-room/clean-room.ts evaluate --run <dir>
 *   node --import tsx scripts/clean-room/clean-room.ts teardown --run <dir>
 *   node --import tsx scripts/clean-room/clean-room.ts baseline --scenario checkin-goal-push --before <dir> --out <file>
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { jobRegistry } from "../../src/chat-sources.ts";
import { transactJsonFile } from "../../src/locked-json.ts";
import { parseBoard } from "../../src/shared/chat-board.ts";
import type { ChatBoard } from "../../src/shared/types.ts";
import { checkinGoalPush } from "./checkin-goal-push.ts";
import type { RunState, Scenario } from "./session-read.ts";

const DATA = process.env.AGENT_CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
const RELEASES = join(homedir(), ".local/share/sieun-pi-chat");
const SCENARIOS: Record<string, Scenario> = { "checkin-goal-push": checkinGoalPush };

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

/** The live chat server: its base URL from instance.json and the write token its shell page carries. */
export interface Server { base: string; origin: string; token: string }
export async function server(): Promise<Server> {
  const { url } = readJson<{ url: string }>(join(DATA, "instance.json"));
  const html = await (await fetch(url)).text();
  const token = /data-chat-token="([a-f0-9]+)"/.exec(html)?.[1];
  if (!token) throw new Error(`no write token on ${url}`);
  return { base: url, origin: new URL(url).origin, token };
}
async function call(srv: Server, method: "GET" | "POST", route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(srv.base + route, { method, headers: { "content-type": "application/json", "x-chat-token": srv.token, origin: srv.origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const requestId = (): string => randomBytes(12).toString("hex");
const MODEL = { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" };

/** Creates the test chat or a fixture thread through `POST api/threads`, the route the New chat dialog uses. */
async function createThread(srv: Server, kind: "chat" | "thread", name: string, cwd: string, message: string): Promise<string> {
  const result = await call(srv, "POST", "api/threads", { requestId: requestId(), cwd, message, name, kind, ...MODEL }) as { id: string };
  return result.id;
}
const setCheckIn = (srv: Server, chat: string, body: Record<string, unknown>) => call(srv, "POST", `api/threads/${chat}/check-in`, body);

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

const liveRelease = (): string => { try { return readlinkSync(join(RELEASES, "current")); } catch { return "unknown"; } };

async function setup(flags: Record<string, string>): Promise<void> {
  const scenario = SCENARIOS[need(flags, "scenario")];
  if (!scenario) throw new Error(`unknown scenario; known: ${Object.keys(SCENARIOS).join(", ")}`);
  const run = need(flags, "run");
  const criteria = need(flags, "criteria");
  if (existsSync(join(run, "run.json"))) throw new Error(`${run} already holds a run`);
  mkdirSync(run, { recursive: true });
  copyFileSync(criteria, join(run, "criteria.md"));
  const sandbox = join(run, "sandbox");
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(join(sandbox, "AGENTS.md"), scenario.agentsMd(sandbox));
  const everyMin = Number(need(flags, "every-min"));
  const name = need(flags, "name");
  const srv = await server();
  const headMessage = scenario.headMessage(name);
  const chat = await createThread(srv, "chat", name, sandbox, headMessage);
  log(run, `created test chat ${chat} "${name}" in ${sandbox}`);
  await setCheckIn(srv, chat, { pause: "forever" });
  log(run, "paused its check-in while the board is seeded");
  const registry = jobRegistry(join(DATA, "chat-jobs.json"));
  const fixtures: Record<string, string> = {};
  const fixtureBriefs: string[] = [];
  for (const fixture of scenario.fixtures) {
    const logFile = join(run, `fixture-${fixture.name.replace(/\W+/g, "-")}.jsonl`);
    const brief = fixture.brief({ chat, chatName: name, logFile, sandbox });
    const id = await createThread(srv, "thread", fixture.name, sandbox, brief);
    await registry.add([fixture.name, id], name);
    fixtures[fixture.name] = id;
    fixtureBriefs.push(brief);
    log(run, `created fixture ${id} "${fixture.name}", filed under the test chat in chat-jobs.json`);
  }
  const copy = parseBoard(readJson(need(flags, "board")));
  const { board, changes } = scenario.board(copy, { fixtures, sandbox });
  await seedBoard(chat, board);
  log(run, `seeded board rev ${board.rev} from ${flags.board}`);
  const state: RunState = { scenario: scenario.name, chat: { id: chat, name }, fixtures, sandbox, everyMs: everyMin * 60_000, release: liveRelease(),
    board: need(flags, "board"), seeds: [headMessage, ...fixtureBriefs], setupAt: Date.now(), windowStart: 0 };
  writeJson(join(run, "run.json"), state);
  writeFileSync(join(run, "setup.md"), scenario.setupNotes(state, changes));
  await setCheckIn(srv, chat, { everyMs: state.everyMs, pause: null });
  state.windowStart = Date.now();
  writeJson(join(run, "run.json"), state);
  log(run, `check-in resumed every ${everyMin} min on ${state.release}; the measured window starts now and nobody steps in`);
}

/** Seeds the board again from the run's copy and opens a new window: for a setup whose seed failed, with the check-in paused around it. */
async function reseed(flags: Record<string, string>): Promise<void> {
  const run = need(flags, "run");
  const state = readJson<RunState>(join(run, "run.json"));
  const scenario = SCENARIOS[state.scenario]!;
  const srv = await server();
  await setCheckIn(srv, state.chat.id, { pause: "forever" });
  const { board } = scenario.board(parseBoard(readJson(state.board)), { fixtures: state.fixtures, sandbox: state.sandbox });
  await seedBoard(state.chat.id, board);
  log(run, `seeded board rev ${board.rev} again from ${state.board}`);
  await setCheckIn(srv, state.chat.id, { everyMs: state.everyMs, pause: null });
  state.windowStart = Date.now();
  writeJson(join(run, "run.json"), state);
  log(run, `check-in resumed every ${state.everyMs / 60_000} min; a new measured window starts now`);
}

/** Every session id the run knows: the chat, its fixtures, its agents, the board's step sessions and its duty jobs. */
function knownSessions(run: string, state: RunState): Set<string> {
  const ids = new Set<string>([state.chat.id, ...Object.values(state.fixtures)]);
  const agents = join(run, "agents");
  if (existsSync(agents)) for (const file of readdirSync(agents)) for (const agent of readJson<{ sessionId?: string }[]>(join(agents, file))) if (agent.sessionId) ids.add(agent.sessionId);
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
  log(run, `collect until ${new Date(until).toISOString()}`);
  while (Date.now() < until) {
    const state = readJson<RunState>(join(run, "run.json"));
    try { await collectOnce(run, state, srv, offset); } catch (error) { log(run, `collect: ${error instanceof Error ? error.message : String(error)}`); }
    await new Promise(resolve => setTimeout(resolve, everyMs));
  }
  log(run, "collect done");
}

async function evaluate(flags: Record<string, string>): Promise<void> {
  const run = need(flags, "run");
  const state = readJson<RunState>(join(run, "run.json"));
  const scenario = SCENARIOS[state.scenario]!;
  const srv = await server().catch(() => null);
  if (srv) await collectOnce(run, state, srv, { at: 0 });
  const { verdict, text } = scenario.evaluate(run, state);
  const out = join(dirname(run), `${basename(run)}.${verdict}.md`);
  writeFileSync(out, text);
  log(run, `verdict ${verdict}: ${out}`);
}

async function teardown(flags: Record<string, string>): Promise<void> {
  const run = need(flags, "run");
  const state = readJson<RunState>(join(run, "run.json"));
  const srv = await server();
  await collectOnce(run, state, srv, { at: 0 }).catch(() => {});
  const jobs = [...knownSessions(run, state)].filter(id => id !== state.chat.id);
  for (const id of jobs) {
    await call(srv, "POST", `api/threads/${id}/archive`, {}).then(() => log(run, `archived job ${id}`), error => log(run, `archive ${id}: ${error instanceof Error ? error.message : String(error)}`));
  }
  await call(srv, "POST", `api/threads/${state.chat.id}/archive`, {});
  log(run, `archived test chat ${state.chat.id}`);
  await jobRegistry(join(DATA, "chat-jobs.json")).remove(Object.keys(state.fixtures).concat(Object.values(state.fixtures)));
  for (const file of existsSync(join(DATA, "wakes")) ? readdirSync(join(DATA, "wakes")) : []) {
    if (Object.values(state.fixtures).some(id => file.startsWith(id))) log(run, `fixture wake left for the service to drop: ${file}`);
  }
}

async function main(): Promise<void> {
  const { command, flags } = args(process.argv.slice(2));
  if (command === "setup") return setup(flags);
  if (command === "collect") return collect(flags);
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
