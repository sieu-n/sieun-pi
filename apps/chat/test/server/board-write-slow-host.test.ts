/**
 * A board write answers once it is on the chat server's disk, and pi-host gets it behind, in order. On 11-23 two of 100 walk writes waited
 * 3,495 and 3,725 ms in the handler (p50 48.5 ms), for a put behind pi-host's event loop while it reopened a session for a heartbeat and
 * built 2,558 rows for an `agent_observe.list_agents()` (~/work/p231-slow-calls/p231-board-handler).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/board-write-slow-host.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSummary, BoardView, ChatBoard } from "../../web/src/lib/api/types.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
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
