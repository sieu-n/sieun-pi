/**
 * The owner's board write answers once the board is stored, without waiting for the chat's `[board]` line, which pi-host submits behind
 * every command queued there. On 11-20 to 11-23 his board writes ran p50 226 ms in the handler against 52 ms for the agents' own writes,
 * which send no line (~/work/p231-slow-calls).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/board-write-answer.test.ts
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AgentSummary, BoardView } from "../../web/src/lib/api/types.ts";
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
