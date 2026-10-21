// 10-21: launch main bro and metal-management asked the owner to restart the stuck prod crawler worker 15 s and 6 min after Crawler VP put the
// same ask on For you as t56 (c117). tell_owner reads the other chats' open todos through the board write it already makes.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyAgentOps } from "../src/agent-board.ts";

const [self, crawler, archived, trial] = ["01a14d31-6ec0-7005-bbe8-c38b7ae73cfb", "01a115e2-9544-7204-b8db-8ce4d5319048", "01a11a24-a46e-77ff-adf7-671d01d462e2", "01a15dc8-1ad5-718d-b577-46206b25bba7"];
const board = (todos: unknown[]) => JSON.stringify({ v: 2, rev: 1, plan: [], todos, updatedAt: "2026-10-21T06:01:53.889Z" });
const todo = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, text, done: false, from: "agent", at: "2026-10-21T06:01:53.889Z", ...extra });

test("with others, a board read carries the open For you todos of the owner's other real chats", async () => {
  const dir = mkdtempSync(join(tmpdir(), "other-asks-"));
  mkdirSync(join(dir, "boards"));
  writeFileSync(join(dir, "chats.json"), JSON.stringify({ ids: [self, crawler, archived, trial] }));
  writeFileSync(join(dir, "archived-chats.json"), JSON.stringify({ ids: [archived] }));
  writeFileSync(join(dir, "clean-room-chats.json"), JSON.stringify({ ids: [trial] }));
  writeFileSync(join(dir, "boards", `${self}.json`), board([todo("t6", "How should the box's 19 web addresses get simpler?")]));
  writeFileSync(join(dir, "boards", `${crawler}.json`), board([todo("t56", "May I run the two fix commands on us-metal01 myself, this once?"),
    todo("t55", "Answered already", { done: true }), todo("t57", "Owner's own note", { from: "owner" })]));
  writeFileSync(join(dir, "boards", `${archived}.json`), board([todo("t8", "An archived chat's old ask")]));
  writeFileSync(join(dir, "boards", `${trial}.json`), board([todo("t1", "A clean-room trial's ask")]));
  const read = await applyAgentOps(dir, self, [], true);
  assert.deepEqual(read.others, [{ chat: crawler, id: "t56", text: "May I run the two fix commands on us-metal01 myself, this once?", at: "2026-10-21T06:01:53.889Z" }]);
  assert.equal(read.board?.todos[0]?.id, "t6", "the chat's own board still comes back");
  assert.equal((await applyAgentOps(dir, self, [])).others, undefined, "a plain board read reads no other board");
});
