/**
 * The owner's board write answers once the board is stored, without waiting for the chat's `[board]` line, which pi-host submits behind
 * every command queued there. On 11-20 to 11-23 his board writes ran p50 226 ms in the handler against 52 ms for the agents' own writes,
 * which send no line (~/work/p231-slow-calls).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/board-write-answer.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgentSummary, BoardView, BoardWrite } from "../../web/src/lib/api/types.ts";
import { applyBoardDelta, boardKey } from "../../web/src/lib/api/shared/board-delta.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

let s: Running;
let agent: AgentSummary;
let release: () => void = () => undefined;
const held: string[] = [];

before(async () => {
  s = await start({ wordMs: 0 });
  agent = (await s.send("POST", "/api/agents", { name: "board answer" })).body;
  assert.ok(s.host instanceof FixtureHost);
  await until(async () => s.app.threads.thread(agent.thread)?.status, status => status !== "running");
  const gate = new Promise<void>(resolve => (release = resolve));
  s.host.beforeSubmit = async (_thread, input) => {
    if (!input.requestId?.startsWith("board:")) return;
    held.push(input.text ?? "");
    await gate;
  };
});
after(async () => {
  release();
  await s.close();
});

test("a write that names the board it was made on answers only what changed, and that applied to it gives the board a read answers", async () => {
  const path = `/api/agents/${agent.id}/board`;
  await s.send("POST", path, { actor: "agent", ops: [{ op: "plan_add", text: "Pick the night shift's pager.", note: "x".repeat(4_000) }, { op: "plan_add", text: "Move the alerts." }] });
  const shown = (await s.get<BoardView>(path)).board!;
  const written = await s.send<BoardWrite & { summaries: string[] }>("POST", path, { actor: "agent", base: boardKey(shown), ops: [{ op: "plan_update", id: shown.plan.at(-1)!.id, text: "Move the alerts to the night channel." }] });
  assert.equal(written.status, 200);
  assert.ok("delta" in written.body, "the answer carries the whole board");
  assert.ok(JSON.stringify(written.body).length < 1_000, `the answer is ${JSON.stringify(written.body).length} bytes`);
  assert.deepEqual(applyBoardDelta(shown, written.body.delta), (await s.get<BoardView>(path)).board);
  // A page whose board is not the server's gets the whole board.
  const stale = await s.send<BoardWrite>("POST", path, { actor: "agent", base: boardKey(shown), ops: [{ op: "plan_update", id: shown.plan.at(-1)!.id, text: "Move the alerts." }] });
  assert.ok("board" in stale.body);
});

test("an owner's board write answers its board while the chat's [board] line is still on its way to pi-host", async () => {
  const written = s.send<BoardView & { summaries: string[] }>("POST", `/api/agents/${agent.id}/board`, { ops: [{ op: "todo_add", text: "Pick the night shift's alert channel." }] });
  const answer = await Promise.race([written, new Promise<"held">(resolve => setTimeout(() => resolve("held"), 2_000))]);
  assert.notEqual(answer, "held", "the answer waited for the [board] line's submit");
  if (answer === "held") return;
  assert.equal(answer.status, 200);
  assert.equal(answer.body.board?.todos.at(-1)?.text, "Pick the night shift's alert channel.");
  assert.equal(held.length, 1);
  assert.match(held[0]!, /^\[board\] /);
});
