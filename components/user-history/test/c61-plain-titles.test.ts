import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import historyExtension from "../extension/index.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { applyBoardOp, BoardError, emptyBoard, nextIds } from "../src/shared/chat-board.ts";
import type { BoardActor, BoardOp, ChatBoard } from "../src/shared/types.ts";

// Owner correction c61 (10-13): board titles are plain outcomes ("Fix a bug in X"); file names, paths, run ids and code names go in the note.
const T0 = "2026-10-13T00:00:00.000Z";
const T1 = "2026-10-13T00:01:00.000Z";
function run(board: ChatBoard, ops: BoardOp[], actor: BoardActor = "agent"): ChatBoard {
  for (const op of ops) board = applyBoardOp(board, op, actor, T1, nextIds(board)).board;
  return board;
}
const REFUSAL = /plain outcome.*note/i;
const refused = (fn: () => unknown, detail: string, label: string) =>
  assert.throws(fn, (error: unknown) => error instanceof BoardError && error.kind === "invalid" && REFUSAL.test(error.message) && error.message.includes(detail), label);

const DETAILED: [string, string][] = [
  ["Fix the crash in chat-board.ts", "chat-board.ts"],
  ["Update README.md for the pool", "README.md"],
  ["Clean up src/x", "src/x"],
  ["Move the cache to ~/a/b", "~/a/b"],
  ["Read /Users/sieunpark/notes", "/Users/sieunpark/notes"],
  ["Fix the components/user-history board", "components/user-history"],
  ["Ship release-b34de98", "b34de98"],
  ["Revert 4f1c2a9e0b", "4f1c2a9e0b"],
  ["Rerun Actions run 18234567890", "18234567890"],
  ["Land ci/my-branch", "ci/my-branch"],
  ["Watch CI/fix-login go green", "CI/fix-login"],
];
const PLAIN = [
  "Fix a bug in the chat board", "Decide and/or ship the pricing page", "Pick UI/UX polish for the settings tab", "Run the A/B test on sign-up",
  "Keep the proxy up 24/7", "Read/write access for the crawler", "Upgrade Node.js to 24", "Ship v0.9.8 to staging", "Reach 1,000,000 posts",
  "Fix the decade-old cafe facade copy", "Cut deploy time from 40 min to 4", "Answer PR #4521 review", "Reply to the vendor on 10/13",
];

test("c61: chat_board refuses a plan title with a file name, a path, a git sha, a CI run id or a ci/ ref, and passes plain titles", async () => {
  for (const [text, detail] of DETAILED) {
    refused(() => run(emptyBoard(T0), [{ op: "plan_add", text }]), detail, `plan_add ${text}`);
    const board = run(emptyBoard(T0), [{ op: "plan_add", text: "Ship the board" }]);
    refused(() => run(board, [{ op: "plan_update", id: "p1", text }]), detail, `plan_update ${text}`);
    assert.equal(run(board, [{ op: "plan_update", id: "p1", note: text }]).plan[0]!.note, text, `the note keeps ${text}`);
  }
  for (const text of PLAIN) {
    assert.equal(run(emptyBoard(T0), [{ op: "plan_add", text }]).plan[0]!.text, text, text);
    assert.equal(run(run(emptyBoard(T0), [{ op: "plan_add", text: "Old" }]), [{ op: "plan_update", id: "p1", text }]).plan[0]!.text, text, text);
  }
  // A step saved before c61 keeps its title: a status or note change passes, only a new title is checked.
  const old: ChatBoard = { ...emptyBoard(T0), plan: [{ id: "p1", text: "Fix src/x.ts", status: "doing", children: [] }] };
  assert.equal(run(old, [{ op: "plan_update", id: "p1", text: "Fix src/x.ts", status: "done" }]).plan[0]!.status, "done");

  // The chat_board tool itself refuses, names the fix, and leaves the board as it was.
  const dataDir = await mkdtemp(join(tmpdir(), "c61-"));
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>();
  const pi = { on() {}, registerFlag() {}, registerCommand() {}, registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); },
    getFlag: (name: string) => name === "agent-chat-data-dir" ? dataDir : undefined };
  historyExtension(pi as never);
  const ctx = { sessionManager: { getSessionId: () => "s-1" } };
  await tools.get("chat_board")!.execute("c1", { ops: [{ op: "plan_add", text: "Ship the board" }] }, undefined, undefined, ctx);
  await assert.rejects(tools.get("chat_board")!.execute("c2", { ops: [{ op: "plan_add", text: "Fix chat-board.ts" }] }, undefined, undefined, ctx),
    /Keep the title a plain outcome.*move "chat-board\.ts" to the note/);
  assert.deepEqual((await new BoardStore(dataDir).read("s-1"))?.plan.map(item => item.text), ["Ship the board"]);
});
