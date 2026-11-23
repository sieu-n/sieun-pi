/**
 * A board write answers once it is on the chat server's disk, and pi-host gets it behind, in order. On 11-23 two of 100 walk writes waited
 * 3,495 and 3,725 ms in the handler (p50 48.5 ms), for a put behind pi-host's event loop while it reopened a session for a heartbeat and
 * built 2,558 rows for an `agent_observe.list_agents()` (~/work/p231-slow-calls/p231-board-handler).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/board-write-slow-host.test.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSummary, BoardView, ChatBoard } from "../../web/src/lib/api/types.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { seedFixture } from "../../server/fixture/seed.ts";
import { start, until } from "./helpers.ts";

/** Answers in time, or "held" after `ms`. */
const within = <T>(promise: Promise<T>, ms: number): Promise<T | "held"> =>
  Promise.race([promise, new Promise<"held">(resolve => setTimeout(() => resolve("held"), ms))]);

test("a board write answers while pi-host holds its put for seconds, and pi-host gets every write in order with its [board] line after it", async () => {
  const s = await start({ wordMs: 0 });
  let release: () => void = () => undefined;
  try {
    const host = s.host as FixtureHost;
    const agent: AgentSummary = (await s.send("POST", "/api/agents", { name: "slow put" })).body;
    await until(async () => s.app.threads.thread(agent.thread)?.status, status => status !== "running");
    const path = `/api/agents/${agent.id}/board`;
    await s.get<BoardView>(path);
    const order: string[] = [];
    const gate = new Promise<void>(resolve => (release = resolve));
    const put = host.docPut.bind(host);
    host.docPut = async (id, name, value) => {
      await gate;
      order.push(`put ${(value as ChatBoard).rev}`);
      return put(id, name, value);
    };
    host.beforeSubmit = (_thread, input) => {
      if (input.requestId?.startsWith("board:")) order.push(`line ${input.requestId.split(":").at(-1)}`);
    };

    const first = await within(s.send<BoardView>("POST", path, { ops: [{ op: "todo_add", text: "Pick the night shift's alert channel." }] }), 1_000);
    assert.notEqual(first, "held", "the write waited for pi-host's put");
    const second = await within(s.send<BoardView>("POST", path, { ops: [{ op: "plan_add", text: "Move the alerts." }] }), 1_000);
    assert.notEqual(second, "held", "the second write waited for pi-host's put");
    if (first === "held" || second === "held") return;
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // The second write builds on the first, and a read shows both before pi-host has either.
    const shown = (await s.get<BoardView>(path)).board!;
    assert.equal(shown.todos.at(-1)?.text, "Pick the night shift's alert channel.");
    assert.equal(shown.plan.at(-1)?.text, "Move the alerts.");
    assert.equal(order.length, 0, `pi-host got ${order.join(", ")} while its put was held`);

    release();
    const stored = await until(async () => (await host.docGet(agent.thread, "chat.board")) as ChatBoard | null, board => board?.rev === shown.rev);
    assert.deepEqual(stored, shown);
    await until(async () => order.filter(line => line.startsWith("line")).length, count => count === 2);
    const lastPut = order.lastIndexOf(`put ${shown.rev}`);
    assert.ok(lastPut >= 0 && order.every((line, i) => !line.startsWith("line") || i > lastPut), `order ${order.join(", ")}`);
  } finally {
    // A put still held would hold the server's stop.
    release();
    await s.close();
  }
});

test("a write answered while pi-host refused its put reaches pi-host from the next server on the same data dir", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-test-"));
  const first = await start({ wordMs: 0, dataDir });
  const host = first.host as FixtureHost;
  let agent: AgentSummary;
  const put = host.docPut.bind(host);
  try {
    agent = (await first.send("POST", "/api/agents", { name: "put after restart" })).body;
    await until(async () => first.app.threads.thread(agent.thread)?.status, status => status !== "running");
    host.docPut = async () => {
      throw new Error("connect ECONNREFUSED pi-host.sock");
    };
    const written = await within(first.send<BoardView>("POST", `/api/agents/${agent.id}/board`, { actor: "agent", ops: [{ op: "plan_add", text: "Keep this step." }] }), 1_000);
    assert.notEqual(written, "held");
    assert.equal((await first.get<BoardView>(`/api/agents/${agent.id}/board`)).board?.plan.at(-1)?.text, "Keep this step.");
  } finally {
    await first.close();
  }
  host.docPut = put;
  const second = await start({ wordMs: 0, dataDir, host });
  try {
    const stored = await until(async () => (await host.docGet(agent.thread, "chat.board")) as ChatBoard | null, board => board?.plan.at(-1)?.text === "Keep this step.");
    assert.equal(stored?.plan.at(-1)?.text, "Keep this step.");
    assert.equal((await second.get<BoardView>(`/api/agents/${agent.id}/board`)).board?.plan.at(-1)?.text, "Keep this step.");
  } finally {
    await second.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a server killed with -9 after it answered a write, before its put, leaves the board for the next start to put, and a reload shows it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "apps-chat-test-"));
  const dataDir = join(dir, "data");
  // .mts: a file outside the package is CommonJS to tsx, which has no top-level await.
  const child = join(dir, "crash.mts");
  // The first server runs in a child process whose put never ends, so the kill lands between the answer and the put.
  writeFileSync(child, [
    `import { start } from ${JSON.stringify(new URL("./helpers.ts", import.meta.url).href)};`,
    "const s = await start({ wordMs: 0, dataDir: process.argv[2] });",
    "s.host.docPut = () => new Promise(() => undefined);",
    `const written = await s.send("POST", "/api/agents/ag_crawler-vp/board", { actor: "agent", ops: [{ op: "plan_add", text: "Kept through a crash." }] });`,
    "process.stdout.write(`${JSON.stringify(written.body.board)}\\n`);",
    "setInterval(() => undefined, 1_000);",
  ].join("\n"));
  const server = spawn(process.execPath, ["--import", "tsx", child, dataDir], { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  server.stdout.on("data", chunk => (out += String(chunk)));
  const answered = await until(async () => out, text => text.includes("\n"), 60_000);
  const board = JSON.parse(answered.split("\n")[0]!) as ChatBoard;
  assert.equal(board.plan.at(-1)?.text, "Kept through a crash.");
  server.kill("SIGKILL");
  await new Promise(resolve => server.once("exit", resolve));

  const host = new FixtureHost();
  seedFixture(host, join(dir, "seed"));
  const next = await start({ wordMs: 0, dataDir, host });
  try {
    const thread = next.app.boards.threadOf("ag_crawler-vp");
    assert.deepEqual(await until(async () => host.docGet(thread, "chat.board"), stored => JSON.stringify(stored) === JSON.stringify(board)), board);
    assert.deepEqual((await next.get<BoardView>("/api/agents/ag_crawler-vp/board")).board, board);
  } finally {
    await next.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a write on a board this server read long ago answers with no pi-host read, while pi-host holds every read and put", async () => {
  const s = await start({ wordMs: 0 });
  const realNow = Date.now;
  let release: () => void = () => undefined;
  try {
    const host = s.host as FixtureHost;
    const agent: AgentSummary = (await s.send("POST", "/api/agents", { name: "old read" })).body;
    await until(async () => s.app.threads.thread(agent.thread)?.status, status => status !== "running");
    const path = `/api/agents/${agent.id}/board`;
    await s.get<BoardView>(path);
    const gate = new Promise<void>(resolve => (release = resolve));
    const get = host.docGet.bind(host);
    const put = host.docPut.bind(host);
    let reads = 0;
    host.docGet = async (id, name) => {
      if (name === "chat.board") reads += 1;
      await gate;
      return get(id, name);
    };
    host.docPut = async (id, name, value, opts) => {
      await gate;
      return put(id, name, value, opts);
    };
    // A minute later: the old 15 s TTL read pi-host again here, inside the write.
    Date.now = () => realNow() + 60_000;
    const written = await within(s.send<BoardView>("POST", path, { ops: [{ op: "plan_add", text: "Written a minute after the read." }] }), 1_000);
    assert.notEqual(written, "held", "the write waited for a pi-host read");
    if (written === "held") return;
    assert.equal(written.body.board?.plan.at(-1)?.text, "Written a minute after the read.");
    assert.equal(reads, 0);
  } finally {
    Date.now = realNow;
    release();
    await s.close();
  }
});

test("a stop ends while pi-host holds a board put, and that put, landing after the next server's put of a later board, leaves the later board", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-test-"));
  const first = await start({ wordMs: 0, dataDir });
  const host = first.host as FixtureHost;
  let release: () => void = () => undefined;
  let next: Awaited<ReturnType<typeof start>> | undefined;
  let firstOpen = true;
  try {
    const agent: AgentSummary = (await first.send("POST", "/api/agents", { name: "late put" })).body;
    await until(async () => first.app.threads.thread(agent.thread)?.status, status => status !== "running");
    const path = `/api/agents/${agent.id}/board`;
    await first.get<BoardView>(path);
    // The first server's next put is held, as pi-host holds a put behind its event loop; every later put goes through.
    const gate = new Promise<void>(resolve => (release = resolve));
    const put = host.docPut.bind(host);
    let held = false;
    let landed: Promise<void> = Promise.resolve();
    host.docPut = async (id, name, value, opts) => {
      if (!held && name === "chat.board") {
        held = true;
        landed = gate.then(() => put(id, name, value, opts));
        return landed;
      }
      return put(id, name, value, opts);
    };
    const older = (await first.send<BoardView>("POST", path, { actor: "agent", ops: [{ op: "plan_add", text: "Older step." }] })).body.board!;
    // A hand-over's calls wait in the socket's queue while the old server stops, so its stop never waits for pi-host's put.
    firstOpen = false;
    assert.notEqual(await within(first.close(), 2_000), "held", "the stop waited for pi-host's put");
    // The next server starts from the same data dir, puts the board the first one left in board-writes.json, and takes a later write.
    next = await start({ wordMs: 0, dataDir, host });
    await until(async () => (await host.docGet(agent.thread, "chat.board")) as ChatBoard | null, board => board?.rev === older.rev);
    const later = (await next.send<BoardView>("POST", path, { actor: "agent", ops: [{ op: "plan_add", text: "Later step." }] })).body.board!;
    assert.ok(later.rev > older.rev);
    await until(async () => (await host.docGet(agent.thread, "chat.board")) as ChatBoard | null, board => board?.rev === later.rev);
    release();
    await landed;
    const stored = (await host.docGet(agent.thread, "chat.board")) as ChatBoard;
    assert.equal(stored.rev, later.rev, `pi-host holds rev ${stored.rev}, the late put's, over the later board's rev ${later.rev}`);
    assert.deepEqual(stored.plan.map(step => step.text).slice(-2), ["Older step.", "Later step."]);
  } finally {
    release();
    if (firstOpen) await first.close();
    await next?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
