// chat-2572 p20 on 10-25: run-1 and run-2 of unrelated-ci-wait read "nothing due, so no job" on every aged wait, so the controlled variant
// seeds one fixture goal whose count drops one file per reading. Controlled run-1 kept that count still, and quietPush held every push after
// the first for a day. This guards its seed: the shelf exists before admission, the goal's first reading is the real
// count at seed time, the push step makes goalWait skip its asleep branch, and the fixture brief names no CI run, wait or check-in behaviour.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type GoalMemo, type GoalNumber, quietPush } from "../src/checkin-goals.ts";
import { GOAL_PUSH_LINK } from "../src/shared/chat-board.ts";
import { controlledBoard, fixtureBrief, FIXTURE, prepareShelf, shelfCount, TASK } from "../scripts/clean-room/unrelated-ci-controlled.ts";

test("unrelated-ci-controlled: the shelf and the controlled goal exist before admission, and no brief teaches the tested behaviour", t => {
  const root = mkdtempSync(join(tmpdir(), "shelf-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sandbox = prepareShelf(join(root, "runs", "run-3"), root);
  assert.equal(prepareShelf(join(root, "runs", "run-3"), root), sandbox, "setup run again finds the same folder");
  assert.equal(shelfCount(sandbox), 39);
  assert.deepEqual(readdirSync(join(sandbox, "shelf")).slice(0, 2), ["f01", "f02"]);

  const now = "2026-10-25T02:00:00.000Z";
  const board = controlledBoard("01a17000-0000-7000-8000-000000000001", now, shelfCount(sandbox));
  const goal = board.plan[0]!;
  assert.equal(goal.target?.current, 39);
  assert.equal(goal.target?.measuredAt, now, "the first reading is taken at seed time, never backdated");
  assert.equal(goal.children[0]?.duty, GOAL_PUSH_LINK);
  assert.equal(goal.children[0]?.sessionId, "01a17000-0000-7000-8000-000000000001");
  assert.deepEqual(board.lastIds, { p: 2, t: 0 });

  const brief = fixtureBrief({ chat: "01a17000-0000-7000-8000-0000000000ab", chatName: "root free space", logFile: join(root, "log.jsonl"), sandbox });
  for (const text of [brief, TASK, sandbox]) assert.doesNotMatch(text, /\b(?:carried|stalled|check-in|checkin|unrelated|controlled|clean.room|\d{9,})\b/i);
  assert.match(brief, new RegExp(`"${FIXTURE}"`));
  assert.doesNotMatch(TASK, /fixture|clean.room|test|shelf/i, "the head is never told about the fixture or the trial");
});

test("unrelated-ci-controlled: each fixture reading is news to the check-in, while a still count goes quiet after one push", () => {
  const pushedAt = Date.parse("2026-10-25T03:33:00Z");
  const reading = (minutes: number, value: number): GoalNumber => ({ metric: "files on the archive shelf", target: 40, unit: "files", op: ">=", value,
    measuredAt: pushedAt + minutes * 60_000, source: "ls shelf", staleMs: 45 * 60_000 });
  const memo: GoalMemo = { readings: [{ at: pushedAt - 60_000, value: 30 }], still: 0, pushed: { at: pushedAt, reading: pushedAt - 60_000, value: 30, act: "steer" } };
  // Controlled run-1: the same 12 files each reading, so the push after 03:33Z waited a day.
  assert.ok(quietPush(memo, reading(10, 30), pushedAt + 15 * 60_000, "steer"), "a still count is no news");
  assert.equal(quietPush(memo, reading(10, 29), pushedAt + 15 * 60_000, "steer"), undefined, "one file fewer is a regression, so the push is due again");
});
