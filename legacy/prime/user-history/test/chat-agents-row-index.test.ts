// 11-02 us-metal02: a scratch serve on a copy of the live data dir with its 14 chats and one held page promoted 266 MB a minute to the old
// generation and ran 3 to 5 major GCs a minute; rowFinder's two maps over every row, built again for each projection, were the most of it
// (278 of 1,596 MB in 6 min). The maps are kept and updated in place for the next projection's rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getHeapStatistics } from "node:v8";
import { keptChatAgents, type AgentRow, type AgentSources } from "../src/chat-agents.ts";
import type { ChatBoard, SessionRow } from "../src/shared/types.ts";

const row = (id: string, name: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name, cwd: "/", kind: "live", status: "idle", archived: false, messageCount: 1,
  working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, origin: "user", lastActivityAt: "2026-11-02T10:00:00.000Z", ...extra });

test("each projection's rows reuse the row index of the last one, and a lookup still finds the first row by id or name", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const board: ChatBoard = { v: 2, rev: 1, todos: [], updatedAt: "2026-11-02T10:00:00.000Z", plan: [
    { id: "p1", text: "crawl", status: "doing", job: "job 17", children: [] }, { id: "p2", text: "land", status: "doing", job: "twin", children: [] },
    { id: "p3", text: "gone", status: "doing", job: "job 4", children: [] }] };
  const entries: AgentRow[] = Array.from({ length: 9000 }, (_, at) => ({ row: row(`s${at}`, `job ${at}`) }));
  const twinA: AgentRow = { row: row("twin-a", "twin") }, twinB: AgentRow = { row: row("twin-b", "twin", { working: true, status: "running" }) };
  const input = (rows: AgentRow[], at: number): AgentSources => ({ self: { id: "chat-index", name: "chat" }, children: [], childSessions: [], board, roots: [], messages: [], rows, now: at });
  const ids = (rows: AgentRow[], at: number) => keptChatAgents(input(rows, at)).map(agent => agent.sessionId).sort();

  assert.deepEqual(ids([twinA, ...entries, twinB], now), ["s17", "s4", "twin-a"]);
  // The next projection: the same rows in another order, job 4 gone and twin-b now first among the rows named "twin".
  const next = [twinB, ...entries.filter(entry => entry.row.id !== "s4").reverse(), twinA];
  assert.deepEqual(ids(next, now + 1000), ["s17", "twin-b"], "a step names the first row with its name, and a row that left is not found");
  // Ten more projections that switch between two orders of the same rows. The old index allocated 431 to 553 KB for each, the new one 85 to 122 KB.
  const orders = [[twinB, ...entries.filter(entry => entry.row.id !== "s4"), twinA], next];
  const before = getHeapStatistics().total_allocated_bytes;
  for (let at = 0; at < 10; at++) ids(orders[at % 2]!, now + 2000 + at);
  const allocated = (getHeapStatistics().total_allocated_bytes - before) / 10;
  assert.ok(allocated < 256 * 1024, `each projection's agents allocated ${(allocated / 1024).toFixed(0)} KB`);
});
