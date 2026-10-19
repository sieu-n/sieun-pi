// Guards owner rule c79: on 10-18 a job put t49 "we send GitHub Support one request ... Can I send it right after the wipe?" on VP of CI's For you and the owner answered "NONONONO" on 10-19; Crawler VP's t52 asked to contact GeoNode support 5 h later.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBoardOp, BoardError, emptyBoard, nextIds, parseBoardOps } from "../src/shared/chat-board.ts";
import { vendorSupportAsk } from "../src/shared/vendor-support.ts";
import type { BoardActor, BoardOp, ChatBoard } from "../src/shared/types.ts";

const AT = "2026-10-19T06:00:00.000Z";
function run(board: ChatBoard, ops: unknown[], actor: BoardActor = "agent"): ChatBoard {
  for (const op of parseBoardOps(ops)) board = applyBoardOp(board, op as BoardOp, actor, AT, nextIds(board)).board;
  return board;
}
const refused = (ops: unknown[], board = emptyBoard(AT)) =>
  assert.throws(() => run(board, ops), error => error instanceof BoardError && error.kind === "forbidden" && /c79/.test(error.message));

const ASKS = [
  "After the old keys are wiped from history, GitHub still keeps cached copies of the old commits. To remove those, we send GitHub Support one request (draft on the page). It says you chose not to change the keys. Can I send it right after the wipe?",
  "GeoNode's us-08 has been mostly down since 04:40Z. Can a job ask GeoNode support to move us to a working host?",
  "GeoNode's us-09 server drops about 1 in 3 connection attempts. OK to send them the support note drafted in the scratchpad?",
  "Our test shows us-09 cuts out about 40 s of every minute. Send a follow-up on the open ticket with this data?",
  "The portal has no console action. Open a ticket with iWebFusion to enable IPMI VPN access?",
];
const FINE = [
  "Add Safari support to the share page?",
  "Should the crawler support TikTok Shop creator pages?",
  "GitHub keeps cached copies of the old commits, and only its support can purge them, so we skip that and accept the risk (c79). Wipe the history on Sunday?",
  "Reply to the customer's support email with the draft on the page?",
  "Send Barn a short support reply that his payments are credited and $50 was added?",
  "Merge PR #277?",
];

test("a todo that asks to contact a vendor's support is refused, in its text or a choice", () => {
  for (const text of ASKS) refused([{ op: "todo_add", text, choices: ["Yes", "Not yet"] }]);
  refused([{ op: "todo_add", text: "us-08 has been mostly down since 04:40Z. What now?", choices: ["Yes, send a short support ask in the portal", "Keep waiting"] }]);
});

test("rewording an open todo into a support ask is refused, and the owner's own todos pass", () => {
  const board = run(emptyBoard(AT), [{ op: "todo_add", text: "us-08 is down since 04:40Z. Move the crawler to us-07?", choices: ["Move it", "Wait"] }]);
  refused([{ op: "todo_update", id: "t1", text: ASKS[1] }], board);
  assert.equal(run(emptyBoard(AT), [{ op: "todo_add", text: ASKS[0] }], "owner").todos.length, 1);
});

test("other todos that name support pass", () => {
  for (const text of FINE) assert.equal(vendorSupportAsk(text), null, text);
  for (const text of ASKS) assert.notEqual(vendorSupportAsk(text), null, text);
});
