// Crawler VP 10-19: the check-in flagged p146 (crawler API routes and deploy downtime on prod) under c36, which hands ops guy only the local
// environment's 200 uptime checks. The handoff's scope (its services and its environment) now decides, never the words "health check" alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type HandoffRule, parseHandoff } from "../src/chat-corrections.ts";
import { scopeMisses } from "../src/checkin-findings.ts";
import type { ChatBoard } from "../src/shared/types.ts";

const C36: HandoffRule = { correction: "c36", ...parseHandoff({ to: "ops guy (+observability)", topics: "200 check, health check, uptime, answers 200",
  with: "wiki, frontend app, search app, Convex, crawler API", env: "local" }) };
type Item = { id: string; text: string; status?: string; children?: Item[] };
const board = (...plan: Item[]): ChatBoard => {
  const full = (item: Item): unknown => ({ status: "doing", ...item, children: (item.children ?? []).map(full) });
  return { plan: plan.map(full), todos: [] } as unknown as ChatBoard;
};
const flagged = (chat: ChatBoard, self = ["chat-1", "Crawler VP"]) => scopeMisses(chat, [C36], self).map(miss => miss.item.id);

test("c36 skips prod and staging work that names a health check, and steps that name no environment", () => {
  assert.deepEqual(flagged(board(
    { id: "p146", text: "Every documented crawler API route works on prod, and deploys and the health check keep the API up" },
    { id: "p147", text: "Every documented crawler API route passes its own example on prod, 147 of 147, and a prod deploy closes the API for 0 minutes" },
    { id: "p148", text: "Staging crawler API uptime stays at 100%" },
    { id: "p149", text: "Wiki health check every 5 minutes" },
  )), []);
});

test("c36 still flags a local uptime check in another chat, named by the step or by the item above it", () => {
  assert.deepEqual(flagged(board(
    { id: "p10", text: "Keep the uptime checks for the local wiki and Convex green" },
    { id: "p11", text: "Local environment stays up", children: [{ id: "p12", text: "Frontend app health check every 5 minutes" }] },
    { id: "p13", text: "Check localhost crawler API answers 200 after each restart" },
  )), ["p10", "p12", "p13"]);
});

test("c36 needs one of its services, and never flags ops guy's own board", () => {
  assert.deepEqual(flagged(board({ id: "p20", text: "Local Grafana health check answers" })), []);
  assert.deepEqual(flagged(board({ id: "p21", text: "Keep the uptime checks for the local wiki green" }), ["ops-1", "ops guy (+observability)"]), []);
});

test("a handoff env outside local, staging and prod is refused", () => {
  assert.throws(() => parseHandoff({ to: "ops guy", topics: "uptime", env: "dev" }), /handoff.env/);
});
