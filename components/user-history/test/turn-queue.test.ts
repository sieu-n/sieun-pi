import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { ChatBackend } from "../src/chat-backend.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import type { DutyChat, DutyJobHost } from "../src/chat-duty-job.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { type DutyJobRef, parseDutyInput } from "../src/shared/chat-duties.ts";
import type { AgentQueueReading, ChatAgent, ChatBoard, PlanItem } from "../src/shared/types.ts";

// The Mac-wide turn queue (agent-queue-design, 10-14): a session `pi-pool queue --json` lists as queued reads as queued to the check-in, the
// board shows its place, the owner's prompts are owner turns, and a duty job's session is created only once the queue admits its run.

/** A fake pi-pool: admit prints a queued line, then the admitted answer; every call is logged. Set before chat-pool.ts reads PI_POOL_BIN. */
const dir = mkdtempSync(join(tmpdir(), "turn-queue-"));
const fake = join(dir, "pi-pool");
const calls = join(dir, "calls.log");
writeFileSync(fake, `#!/bin/sh
echo "$@" >> "${calls}"
case "$1" in
  admit) echo '{"state":"queued","kind":null,"position":2,"total":3}'; echo '{"state":"admitted","kind":"slot","position":null,"total":null}' ;;
  owner-turn|release) ;;
  *) exit 1 ;;
esac
`);
chmodSync(fake, 0o755);
process.env.PI_POOL_BIN = fake;
const { admitTurn, markOwnerTurn, releaseTurn } = await import("../src/chat-pool.ts");
const { dutyAdmitter, dutyQueueKey, queuedPlaces, queueReader, withQueuePlaces } = await import("../src/chat-turn-queue.ts");
const { checkInPrecheck, checkInPrecheckText, convergenceMisses } = await import("../src/chat-checkin.ts");
const { blockedOnOthers, noProgress, staleSteps } = await import("../src/checkin-findings.ts");
const { agentLines, withQueue } = await import("../src/chat-agents.ts");
const { queueText } = await import("../src/client/board.ts");
const { Duties } = await import("../src/chat-duty-run.ts");
const { startChatServer } = await import("../src/chat-server.ts");
const { slackChats } = await import("../src/chat-slack.ts");
const { DutyStore } = await import("../src/chat-duty-store.ts");

test.after(() => rmSync(dir, { recursive: true, force: true }));
const logged = (): string[] => { try { return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };

const NOW = Date.parse("2026-10-14T00:00:00Z");
const MIN = 60_000;
const EVERY = 15 * MIN;
const reading = (queued: { session: string; position: number; total: number; since: number }[], working: string[] = []): AgentQueueReading => ({
  enabled: true, macWorkingMax: 16, macWorkingMaxSet: null, treeWorkingMax: 8, governor: null,
  working: working.map(session => ({ session, tree: session, parent: null, priority: "low", since: NOW })),
  queued: queued.map(entry => ({ ...entry, tree: entry.session, parent: null, priority: "normal", basePriority: "normal", waitMs: NOW - entry.since })) });

test("pi-pool: admit waits and answers with its last line, owner-turn and release name the session", async () => {
  assert.equal(await admitTurn("duty:c1:checkin", "duty:c1:checkin", "low"), "admitted");
  await markOwnerTurn("s-chat");
  await releaseTurn("duty:c1:checkin");
  assert.deepEqual(logged(), ["admit duty:c1:checkin --tree duty:c1:checkin --class low --wait", "owner-turn s-chat", "release duty:c1:checkin"]);
});

test("queuedPlaces keeps each queued session's place; the reader caches for its window and reads a failure as nothing queued", async () => {
  const places = queuedPlaces(reading([{ session: "s-job", position: 3, total: 7, since: NOW - 4 * MIN }], ["s-work"]));
  assert.deepEqual([...places], [["s-job", { position: 3, total: 7, since: NOW - 4 * MIN }]]);
  let reads = 0;
  let now = NOW;
  const read = queueReader(async () => { reads++; if (reads === 2) throw new Error("pi-pool failed"); return reading([{ session: "s-job", position: 1, total: 1, since: NOW }]); }, 10_000, () => now);
  assert.equal((await read()).size, 1);
  now += 9_000;
  assert.equal((await read()).size, 1);
  assert.equal(reads, 1, "one read serves its window");
  now += 2_000;
  assert.equal((await read()).size, 0, "a failed read holds nothing as queued");
});

test("check-in facts: a thread by its id and a subagent by the session id the daemon's list gives its child id carry their queue place", () => {
  const place = { position: 2, total: 5, since: NOW - MIN };
  const facts: JobFact[] = [{ key: "thread:s-ops", name: "ops guy", state: "ended" }, { key: "c-job", name: "audit", state: "ended" }, { key: "c-other", name: "fix", state: "ended" }];
  const placed = withQueuePlaces(facts, new Map([["s-ops", place], ["s-audit", place]]),
    [{ id: "c-job", label: "audit", status: "done" }, { id: "c-job", label: "audit", status: "done", sessionId: "s-audit" }, { id: "c-other", label: "fix", status: "done", sessionId: "s-fix" }]);
  assert.deepEqual(placed.map(fact => fact.queued ?? null), [place, place, null]);
});

const step = (id: string, text: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "todo", children: [], ...extra });
const boardOf = (minutes: number, ...steps: PlanItem[]): ChatBoard =>
  ({ v: 2, rev: 1, updatedAt: new Date(NOW - minutes * MIN).toISOString(), scratch: [], todos: [], plan: [step("p1", "Ship the queue", { status: "doing", children: steps })] });
const ROWS = [{ id: "s-crawler", name: "Crawler VP", archived: false }];
const SELF = ["c1", "Concierge"];

test("check-in: a step whose owner job or awaited thread is queued is not blocked_on_others; without the queue it is", () => {
  const board = boardOf(90, step("p2", "Share the crawler schema", { waitFor: "Crawler VP to send the schema" }),
    step("p3", "Fix the release gate", { waitFor: "the release queue", job: "gate-fix" }));
  const ended: JobFact = { key: "k2", name: "gate-fix", state: "ended", activityAt: NOW - 80 * MIN };
  const run = (facts: JobFact[], queued: Map<string, unknown>) => {
    const precheck = checkInPrecheck(undefined, facts, board, NOW, { self: SELF, rows: ROWS, everyMs: EVERY, queued });
    return { precheck, output: convergenceMisses("c1", precheck.steps, precheck, {}, EVERY, NOW) };
  };
  assert.equal(run([ended], new Map()).output.metrics.blocked_on_others, 2, "before the queue both read as blocked");
  const queuedJob: JobFact = { ...ended, sessionId: "s-gate", queued: { position: 3, total: 7, since: NOW - 4 * MIN } };
  const { precheck, output } = run([queuedJob], new Map([["s-crawler", {}], ["s-gate", {}]]));
  assert.deepEqual(precheck.blocked, []);
  assert.equal(output.metrics.blocked_on_others, 0);
  assert.equal(blockedOnOthers(precheck.steps, ROWS, new Set(SELF), NOW).length, 1, "the job's own place on its fact holds its step with no map");
  assert.match(checkInPrecheckText(precheck, [queuedJob], output.flagged, NOW), /job gate-fix: (?:ended|idle)[^\n]*, queued 3 of 7 for a working slot for 4 min/);
});

test("check-in: a job that ended under a step is a stale step unless its next turn is queued", () => {
  const board = boardOf(120, step("p2", "Write the copy", { job: "copy-writer" }));
  const ended: JobFact = { key: "k1", name: "copy-writer", state: "ended", activityAt: NOW - 60 * MIN };
  const stale = (fact: JobFact) => staleSteps(board, [fact], () => NOW - 120 * MIN, new Set(SELF), EVERY, NOW);
  assert.deepEqual(stale(ended).map(entry => entry.item.id), ["p2"]);
  assert.deepEqual(stale({ ...ended, queued: { position: 1, total: 2, since: NOW - 5 * MIN } }), []);
});

test("check-in: no_progress holds a step whose job, or the chat itself, waits for a working slot", () => {
  const board = boardOf(120, step("p2", "Write the copy", { job: "copy-writer" }), step("p3", "Tidy the plan", { job: "Concierge" }));
  const ended: JobFact = { key: "k1", name: "copy-writer", state: "ended", activityAt: NOW - 90 * MIN };
  const moving = (facts: JobFact[], queued: Map<string, unknown>) => {
    const steps = checkInPrecheck(undefined, facts, board, NOW, { self: SELF, everyMs: EVERY }).steps;
    return noProgress(board, steps, {}, NOW - 2 * 60 * MIN, [], new Set(SELF), NOW, undefined, queued)?.moving.map(view => view.item.id) ?? [];
  };
  assert.deepEqual(moving([ended], new Map()), ["p2", "p3"]);
  assert.deepEqual(moving([{ ...ended, queued: { position: 1, total: 1, since: NOW } }], new Map()), ["p3"]);
  assert.deepEqual(moving([{ ...ended, queued: { position: 1, total: 1, since: NOW } }], new Map([["c1", {}]])), [], "the chat's own steps wait with the chat");
});

const agent = (name: string, sessionId: string): ChatAgent => ({ key: `child:${name}`, sessionId, name, job: name, sender: name, link: "subagent", state: "working", steps: ["p2"] });

test("board: a queued agent carries its place, reads 'Queued 3 of 7, waiting 4 min', and the chat_board Agents line says so", () => {
  const agents = withQueue([agent("audit links", "s-a"), agent("fix ci", "s-b")], new Map([["s-a", { position: 3, total: 7, since: NOW - 4 * MIN - 5_000 }]]));
  assert.deepEqual(agents.map(entry => entry.queued ?? null), [{ position: 3, total: 7, since: NOW - 4 * MIN - 5_000 }, null]);
  assert.equal(queueText(agents[0]!.queued!, NOW), "Queued 3 of 7, waiting 4 min");
  assert.equal(queueText({ position: 1, total: 1, since: NOW - 20_000 }, NOW), "Queued 1 of 1, waiting under 1 min");
  assert.equal(queueText({ position: 2, total: 9, since: NOW - 75 * MIN }, NOW), "Queued 2 of 9, waiting 1 h 15 min");
  assert.deepEqual(agentLines(agents, NOW), ["Agents:", "- audit links: queued 3 of 7 for a working slot, waiting 4 min (p2)", "- fix ci: working (p2)"]);
});

test("duty admitter: admitted returns a release, off and a failing pool start the job unqueued, and the sweep frees only this service's chats' keys", async () => {
  const pool: string[] = [];
  let answer: "admitted" | "off" | Error = "admitted";
  const fakePool = {
    admit: async (session: string, tree: string, priority: string) => { pool.push(`admit ${session} ${tree} ${priority}`); if (answer instanceof Error) throw answer; return answer; },
    release: async (session: string) => { pool.push(`release ${session}`); },
    read: async () => reading([{ session: dutyQueueKey("c2", "d1"), position: 1, total: 1, since: NOW }], [dutyQueueKey("c1", "checkin"), "s-chat"]),
  };
  const lines: string[] = [];
  const admitter = dutyAdmitter({ log: line => lines.push(line), pool: fakePool });
  const release = await admitter.admit("c1", "checkin");
  assert.deepEqual(pool, ["admit duty:c1:checkin duty:c1:checkin low"]);
  await release!();
  assert.deepEqual(pool.slice(1), ["release duty:c1:checkin"]);
  answer = "off";
  assert.equal(await admitter.admit("c1", "checkin"), null);
  answer = new Error("pi-pool failed: usage");
  assert.equal(await admitter.admit("c1", "checkin"), null);
  assert.match(lines.at(-1)!, /the turn queue did not answer, so its job starts unqueued: pi-pool failed: usage/);
  pool.length = 0;
  await admitter.sweep(async chat => chat === "c1");
  assert.deepEqual(pool, ["release duty:c1:checkin"]);
});

test("Duties: the job's session is created only after the queue admits its run, outside the start lane, and the key is released after the start", async () => {
  const store = new DutyStore(await mkdtemp(join(tmpdir(), "turn-queue-duty-")));
  const writeOutput = `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { orphans: 0 }, flagged: [] }))`;
  const at = new Date(2026, 9, 14, 9, 0).getTime();
  await store.update("chat1", duties => {
    duties.push({ ...parseDutyInput({ name: "Local dev servers", ownerWords: "keep them up", goal: "Dev servers answer.", onMiss: "Fix the server that is down.",
      metrics: [{ key: "orphans", label: "Down", op: "<=", target: 0 }], schedule: { kind: "every", minutes: 10 }, precheck: { command: ["node", "-e", writeOutput], cwd: tmpdir() } },
    "d1", at - 10 * MIN) });
  });
  const events: string[] = [];
  let admit: () => void = () => {};
  const jobs: DutyJobHost = {
    async chat(chatId): Promise<DutyChat> { return { id: chatId, name: "dev VP", cwd: "/repo", board: `/boards/${chatId}.json` }; },
    async working() { return false; },
    async start(_chat, name): Promise<DutyJobRef> { events.push("create"); return { id: "s1", name }; },
    async retire() {},
  };
  const duties = new Duties(store, { isChat: async id => id === "chat1", jobs, now: () => at, tickMs: 0,
    admit: (chatId, dutyId) => new Promise(resolve => { events.push(`admit ${dutyQueueKey(chatId, dutyId)}`); admit = () => resolve(async () => { events.push("release"); }); }) });
  await duties.tick();
  for (let i = 0; i < 50 && events.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(events, ["admit duty:chat1:d1"], "no session while the run waits");
  const view = await duties.view("chat1");
  assert.equal(view[0]!.running, true, "the scheduled run is still going, not skipped");
  admit();
  await duties.settled();
  assert.deepEqual(events, ["admit duty:chat1:d1", "create", "release"]);
  assert.equal((await store.runs("chat1"))[0]!.job?.id, "s1");
});

test("owner prompts: the composer, a board answer and a Slack message each mark an owner turn right before the prompt", async () => {
  const boards = new BoardStore(await mkdtemp(join(tmpdir(), "turn-queue-board-")));
  await boards.apply("chat1", [{ op: "todo_add", text: "Approve the picks" }], "agent");
  const order: string[] = [];
  const backend = {
    chats: { ids: async () => new Set(["chat1"]) },
    boards,
    threads: { setBoard() {}, async prompt(id: string) { order.push(`prompt ${id}`); } },
    ownerTurn: async (id: string) => { order.push(`owner-turn ${id}`); },
    close: async () => {},
  } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "t" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {} });
  const origin = new URL(server.url).origin;
  const post = (route: string, body: unknown) => fetch(server.url + route, { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-Chat-Token": "token", Origin: origin } });
  try {
    assert.equal((await post("api/threads/chat1/prompt", { message: "ship it", requestId: randomUUID() })).status, 200);
    assert.equal((await post("api/threads/chat1/board", { ops: [{ op: "todo_update", id: "t1", done: true }] })).status, 200);
    await slackChats(backend).prompt("chat1", "from Slack");
    assert.deepEqual(order, ["owner-turn chat1", "prompt chat1", "owner-turn chat1", "prompt chat1", "owner-turn chat1", "prompt chat1"]);
  } finally { await server.close(); }
});
