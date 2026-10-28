// c124 came back after its fix: the owed-links check (b90f0cc4) only sees a job that named a 5180 variant, and on 10-28 frontend bro never built
// one. A job wrote three Swipe layouts on a wiki page, the chat asked "Which Swipe layout, A ..., B ... or C?" in tell_owner and in t51 with
// text choices (t49 the same for New campaign), and at 15:08:59Z the owner answered "siwpe layout, 직접 만들어보라니까 이런건?". tell_owner now
// refuses once, and the board flags, an ask to pick a layout from words with no 5180 link.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TELL_OWNER_DONE, tellOwner, tellTurn } from "../src/chat-guard.ts";
import { applyBoardOp, emptyBoard, layoutTodoFlag } from "../src/shared/chat-board.ts";
import { layoutPickInWords } from "../src/shared/layout-ask.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-28T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const tell = (id: string, text: string, clock: string): ThreadMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text, why: "decision", about: "Swipe layout" } }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as ThreadMessage;
const told = (id: string, text: string, clock: string): ThreadMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text }], isError: true, timestamp: at(clock) }) as ThreadMessage;

/** frontend bro on 10-28: the owner's two Swipe messages, then the job report that woke the chat at 02:53Z. */
const ASK = "swip는 좀 재편이 필요해. what is the purpose first of all and what exactly does it do?";
const turn0253 = [
  owner(ASK, "02:24:00"),
  owner("visually, it should feel more like bio, and should be able to more easily skim through actual profile", "02:25:00"),
  { role: "custom", customType: "agent_message", content: "[job] swipe purpose and redesign reported, and its open step is yours now: p374", timestamp: at("02:53:06") } as unknown as ThreadMessage,
];
const SWIPE = "Which Swipe layout, A where the card is their profile page with a post grid (my pick), B with an up-next list on the left, or C with posts first?";
const decide = { text: SWIPE, why: "decision", about: "Swipe layout" };

test("the 02:53Z Swipe layout question, asked in words with no 5180 link, is refused once with how to build the options", () => {
  const out = tellOwner(decide, tellTurn(turn0253));
  assert.equal(out.kind, "refused");
  assert.match(out.text, /pick a layout from words/);
  assert.match(out.text, /variant/);
  assert.match(out.text, /version picker/);
  assert.match(out.text, /c124/);
});

test("the very same text sent again goes out, so the check is a soft cap (c98)", () => {
  const first = tellOwner(decide, tellTurn(turn0253));
  const again = [...turn0253, tell("a1", SWIPE, "02:53:20"), told("a1", first.text, "02:53:20"), tell("a2", SWIPE, "02:53:30")];
  assert.deepEqual(tellOwner(decide, tellTurn(again)), { kind: "sent", text: TELL_OWNER_DONE });
});

test("the same pick with each variant's 5180 link goes out", () => {
  const linked = "Which Swipe layout? A http://localhost:5180/app/campaigns/heartleaf-toner-us?view=review&v.creators=swipe-a, " +
    "B ?v.creators=swipe-b, or C ?v.creators=swipe-c.";
  assert.equal(layoutPickInWords(linked), null);
});

test("layout choices in words go out when the owner's latest message asked for a page", () => {
  const asked = [owner("can you write up the Swipe layout options as a page first? I want to read them before you build", "02:24:00"),
    turn0253[2]!];
  assert.deepEqual(tellOwner(decide, tellTurn(asked)), { kind: "sent", text: TELL_OWNER_DONE });
});

test("a message with no layout pick goes out as before", () => {
  const turn = tellTurn(turn0253);
  for (const text of [
    "Swipe is a keep-or-pass deck over matched creators nobody has emailed yet, and the ones you keep become your next email batch.",
    "Should Fit be the only number on the card, dropping the blended score? My pick is yes.",
    "Which sync design should the wiki use, A with a queue or B with a cron? My pick is A.",
    "The new layout is on Staging now.",
  ]) assert.deepEqual(tellOwner({ text, why: "decision", about: "Swipe" }, turn), { kind: "sent", text: TELL_OWNER_DONE }, text);
});

test("t51 and t49 as frontend bro added them are flagged, and the same todos with 5180 links are not", () => {
  const t51 = { text: "Which Swipe layout?", choices: ["A: the card is their profile page, post grid below (my pick)",
    "B: an up-next list on the left, profile on the right", "C: posts first, a short bio under them"] };
  const t49 = { text: "How should the full-screen New campaign be laid out?", choices: ["One long page (my pick)", "Steps with a progress bar"] };
  for (const todo of [t51, t49]) assert.match(layoutTodoFlag(todo) ?? "", /pick a layout.*c124/s, todo.text);
  const linked = { ...t51, links: ["a", "b", "c"].map(v => ({ label: `Swipe ${v}`, target: `http://localhost:5180/app/campaigns/heartleaf-toner-us?v.creators=swipe-${v}` })) };
  assert.equal(layoutTodoFlag(linked), null);
  assert.equal(layoutTodoFlag({ text: "Show creators another campaign already emailed in Swipe?", choices: ["No, hide them (my pick)", "Yes, show them with a note"] }), null);
});

test("the board saves t51 and its summary carries the c124 flag", () => {
  const { board, summary } = applyBoardOp(emptyBoard("2026-10-28T02:52:39Z"),
    { op: "todo_add", text: "Which Swipe layout?", choices: ["A: the card is their profile page (my pick)", "B: an up-next list on the left", "C: posts first"] },
    "agent", "2026-10-28T02:52:39Z", kind => `${kind}51`);
  assert.equal(board.todos.length, 1);
  assert.match(summary, /pick a layout \("layout"\) from words/);
});
