// chat-2572 p20 on 10-25: run-1 and run-2 of unrelated-ci-wait read "nothing due, so no job" on every aged wait, so the controlled variant
// seeds one fixture goal whose count never moves. This guards its seed: the shelf exists before admission, the goal's first reading is the real
// count at seed time, the push step makes goalWait skip its asleep branch, and the fixture brief names no CI run, wait or check-in behaviour.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GOAL_PUSH_LINK } from "../src/shared/chat-board.ts";
import { controlledBoard, fixtureBrief, FIXTURE, prepareShelf, shelfCount, TASK } from "../scripts/clean-room/unrelated-ci-controlled.ts";

test("unrelated-ci-controlled: the shelf and the controlled goal exist before admission, and no brief teaches the tested behaviour", t => {
  const root = mkdtempSync(join(tmpdir(), "shelf-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sandbox = prepareShelf(join(root, "runs", "run-3"), root);
  assert.equal(prepareShelf(join(root, "runs", "run-3"), root), sandbox, "setup run again finds the same folder");
  assert.equal(shelfCount(sandbox), 12);
  assert.deepEqual(readdirSync(join(sandbox, "shelf")).slice(0, 2), ["f01", "f02"]);

  const now = "2026-10-25T02:00:00.000Z";
  const board = controlledBoard("01a17000-0000-7000-8000-000000000001", now, shelfCount(sandbox));
  const goal = board.plan[0]!;
  assert.equal(goal.target?.current, 12);
  assert.equal(goal.target?.measuredAt, now, "the first reading is taken at seed time, never backdated");
  assert.equal(goal.children[0]?.duty, GOAL_PUSH_LINK);
  assert.equal(goal.children[0]?.sessionId, "01a17000-0000-7000-8000-000000000001");
  assert.deepEqual(board.lastIds, { p: 2, t: 0 });

  const brief = fixtureBrief({ chat: "01a17000-0000-7000-8000-0000000000ab", chatName: "root free space", logFile: join(root, "log.jsonl"), sandbox });
  for (const text of [brief, TASK, sandbox]) assert.doesNotMatch(text, /\b(?:carried|stalled|check-in|checkin|unrelated|controlled|clean.room|\d{9,})\b/i);
  assert.match(brief, new RegExp(`"${FIXTURE}"`));
  assert.doesNotMatch(TASK, /fixture|clean.room|test|shelf/i, "the head is never told about the fixture or the trial");
});
