// c124 is one rule with several shapes: the owner reviews UI and product work on the 5180 screens, never on a design page. The 10-28 refix
// (15bdfb9d) read only "a layout" picked from words, so the 10-19 shape (the Campaigns final plan page sent while its fork rendered), a pick
// between "cards or a table" or "one long page or steps", a todo that hands him a design page, and the job brief that put the Swipe options on
// a wiki page all went through. These cases read every shape against tell_owner, the For you todo, a plan step and the brief check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TELL_OWNER_DONE, tellOwner, tellTurn } from "../src/chat-guard.ts";
import { applyBoardOp, emptyBoard, layoutTodoFlag } from "../src/shared/chat-board.ts";
import { briefCheck, briefCheckNote } from "../src/shared/brief-check.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-28T${clock}Z`);
const owner = (text: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at("02:24:00") }) as ThreadMessage;
const wake = { role: "custom", customType: "agent_message", content: "[job] swipe build reported", timestamp: at("02:53:06") } as unknown as ThreadMessage;
const anyPage = (): boolean => true;
/** What tell_owner answers on a wake-up after the owner's message, or on his own turn. */
const tell = (text: string, ownerText = "swip는 좀 재편이 필요해", ownerTurn = false, why = "decision") =>
  tellOwner({ text, why, about: "Swipe" }, tellTurn(ownerTurn ? [owner(ownerText)] : [owner(ownerText), wake]), Date.now(), anyPage);

test("a layout or design pick in words is refused once in every phrasing, not only with the word layout", () => {
  for (const [text, ownerTurn] of [
    ["Should the Watchlist rows be cards or a table? My pick is cards.", false],
    ["For New campaign, one long page or steps with a progress bar? I'd go with one long page.", false],
    ["Do you want the Inbox split into two columns like Gmail, or keep the single list? My pick is two columns.", false],
    ["스와이프 화면, A안(프로필 그리드)이랑 B안(포스트 먼저) 중에 어떤 게 좋아?", false],
    ["Three directions for the Dashboard home are on the page, which one should we build? wiki:sessions/2026/10/29/0100-dash/directions.html", false],
    ["I can do it two ways, a profile-first card or a posts-first card. Which do you want?", true],
  ] as const) {
    const out = tell(text, undefined, ownerTurn, ownerTurn ? "answer" : "decision");
    assert.equal(out.kind, "refused", text);
    assert.match(out.text, /pick a layout from words.*c124/s, text);
  }
});

test("the 10-19 Campaigns final plan page and other design pages for a screen are refused once with the 5180 link to send instead", () => {
  for (const text of [
    "The Campaigns final plan is up, with the derived stages, every screen's data source in the real Convex schema, and each new table or " +
      "field marked. Eight builders are on it now. wiki:sessions/2026/10/19/1732-campaigns-final/decision",
    "The Swipe redesign page is ready, with what each control does and the new card. wiki:sessions/2026/10/28/1128-swipe-purpose-redesign/swipe.html",
  ]) {
    const out = tell(text, "campaigns final 어떻게 돼가?", true, "answer");
    assert.equal(out.kind, "refused", text);
    assert.match(out.text, /design page for a screen.*c124.*localhost:5180/s, text);
  }
});

test("a design page goes out when he asked for a page, and on a resend", () => {
  const page = "The Inbox design doc has three directions with mockups, and my pick is the split view. wiki:sessions/2026/10/29/0200-inbox/design.html";
  assert.deepEqual(tell(page, "write me a doc with the inbox directions first, I want to read before you build"), { kind: "sent", text: TELL_OWNER_DONE });
  const first = tell(page, "inbox feels cluttered, rethink it");
  assert.equal(first.kind, "refused");
  const again = [owner("inbox feels cluttered, rethink it"), wake,
    { role: "assistant", content: [{ type: "toolCall", id: "a1", name: "tell_owner", arguments: { text: page, why: "decision", about: "Swipe" } }], stopReason: "toolUse", timestamp: at("02:53:20") } as unknown as ThreadMessage,
    { role: "toolResult", toolCallId: "a1", toolName: "tell_owner", content: [{ type: "text", text: first.text }], isError: true, timestamp: at("02:53:20") } as ThreadMessage];
  assert.deepEqual(tellOwner({ text: page, why: "decision", about: "Swipe" }, tellTurn(again), Date.now(), anyPage), { kind: "sent", text: TELL_OWNER_DONE });
});

test("his word page for a screen is no ask for a document", () => {
  const out = tell("Which Swipe layout, A with a post grid (my pick) or B with posts first?", "the swipe page needs a rework, it should feel like bio");
  assert.equal(out.kind, "refused");
});

test("pages that answer his question, other designs and product questions go out as before", () => {
  for (const [text, ownerText] of [
    ["Swipe is the review step after Scout, and the page shows what each control does. wiki:sessions/2026/10/28/1128-swipe/swipe.html", "what is swipe for?"],
    ["Which sync design should the wiki use, A with a queue or B with a cron? My pick is A. wiki:sessions/2026/10/29/sync.html", "how should sync work?"],
    ["Should Fit be the only number on the card, dropping the blended score? My pick is yes.", "fit or score?"],
    ["The harness load plan is up, with the worker split and the memory caps per box. wiki:sessions/2026/10/23/0132-harness-load/plan.html", "plan?"],
    ["The design links each Brand watch to Watchlist brands with no copies or filters, wiki:sessions/2026/10/28/0319-brand-watch-on-brands/design.html", "is it duplicated?"],
    ["The realistic plan is here. wiki:sessions/2026/10/22/1441-5180-product-plan/plan.html", "realistic plan?"],
    ["5174 got the data details, not the full 5180 design. [Screenshots and findings](wiki:sessions/2026/10/22/0255-sep-launch-alignment-audit/findings.html).", "why old?"],
    ["Check 1 redefined from the ground up is here, wiki:sessions/2026/10/22/1330-check1-redesign/check1", "redefine check 1"],
  ] as const) assert.deepEqual(tell(text, ownerText, true, "answer"), { kind: "sent", text: TELL_OWNER_DONE }, text);
});

test("For you todos with a layout pick in other words or a design page are flagged, and real todos on other boards are not", () => {
  for (const todo of [
    { text: "Watchlist rows as cards or a table?", choices: ["Cards (my pick)", "Table"] },
    { text: "Should post lists keep a table view behind the toggle?", choices: ["Feed by default, with the table one click away (my pick)", "Feed only, no table"] },
    { text: "Read the Inbox redesign page and pick a direction", links: [{ label: "Inbox redesign", target: "wiki:sessions/2026/10/29/0200-inbox/design.html" }] },
    { text: "온보딩 화면 어떤 안으로 갈까?", choices: ["A안 한 페이지", "B안 단계별"] },
  ]) assert.match(layoutTodoFlag(todo) ?? "", /c124/, todo.text);
  for (const todo of [
    { text: "Where should Kafka live in your a/b/c layout?", choices: ["Drive c, with ClickHouse (my pick)", "Drive a, with Postgres"] },
    { text: "Keep the census grid-page fallback (p901)? Without it about 1.3M reads a day end blocked.", choices: ["Keep it (my pick)", "Remove it anyway"] },
    { text: "Six signup tests wait for you, Continue with Google on blog cards (#246) and a blog signup card that slides in (#248). Start those six?", choices: ["Go: start all six", "Not yet"] },
    { text: "To hide the bar at the top of the chat app in full screen, press Cmd+Shift+F once in that window.", choices: ["Done, bar is gone", "Keep the bar"] },
    { text: "Run the data move on prod now? The move is 12 convex-run steps that passed on staging.", choices: ["Run it now, one step at a time", "Wait"] },
  ]) assert.equal(layoutTodoFlag(todo), null, todo.text);
});

test("a plan step that has a job put a screen's options on a page is flagged, and one that builds them is not", () => {
  const add = (text: string, note: string) => applyBoardOp(emptyBoard("2026-10-28T02:27:00Z"), { op: "plan_add", text, note, status: "doing" }, "agent",
    "2026-10-28T02:27:00Z", kind => `${kind}374`).summary;
  assert.match(add("The owner knows what Swipe is for and picks how to reorganize it", "A wiki page leads with a real deck card, says what " +
    "each control does, and gives 2 or 3 options with a pick. Done when the owner has the page and has picked an option."), /options on a page.*c124/s);
  assert.doesNotMatch(add("Swipe layouts A and B as variants", "Fork creators/lean-1028 into swipe-a and swipe-b, one builder per option, " +
    "then send him both 5180 links. The options page stays with the builders."), /c124/);
});

const BRIEF_1028 = `Owner's words (verbatim):
1. 10-28 02:24Z (mvrhuj8d): "swip는 좀 재편이 필요해. what is the purpose first of all and what exactly does it do?"
2. 10-28 02:25Z (mvrhuzcr): "visually, it should feel more like bio, and should be able to more easily skim through actual profile"
My read: he wants to know what Swipe is for and a better Swipe; a page shows both.
Split: one job, one page.
Task: write ONE wiki page under sessions/2026/10/28/<hhmm>-swipe-purpose-redesign/swipe.html.
1. What each control does, from the code.
2. Two or three redesign options, each with a one-line pitch, a small wireframe (mermaid or an HTML mock), and your pick first.
Do not change app code. Only research and write the page.
Reply with await agent_message.send(report, receiver_role="parent").`;

test("the brief check steers the chat on a brief that has a job put a screen's options on a page", () => {
  const findings = briefCheck(BRIEF_1028);
  assert.deepEqual(findings.map(finding => finding.kind), ["screen-options-page"]);
  const note = briefCheckNote("swipe purpose and redesign", findings);
  assert.match(note, /describe screen options on a page instead of building them \(c124\)/);
  assert.match(note, /one builder per option/);
  assert.doesNotMatch(note, /not with a new job/);
});

test("briefs that build the options, serve builders with a page, or follow his ask for a page pass the c124 brief check", () => {
  for (const brief of [
    BRIEF_1028.replace(/Task:[\s\S]*Only research and write the page\./, "Task: fork creators/lean-1028 with `pnpm --filter virev-demo " +
      "variant:fork creators/lean-1028 swipe-a`, build layout A, and send its ?v.creators=swipe-a link and one shot."),
    BRIEF_1028.replace("Two or three redesign options", "As design lead, write a short decision page with two layout options, then spawn one builder per option").replace("Do not change app code. Only research and write the page.", ""),
    BRIEF_1028.replace("what exactly does it do?\"", "what exactly does it do? write me a page with a few layouts first\""),
    BRIEF_1028.replace(/Task:[\s\S]*Only research and write the page\./, "Task: write a design page with two options for the wiki sync, a queue or a cron, with a diagram."),
  ]) assert.deepEqual(briefCheck(brief).filter(finding => finding.kind === "screen-options-page"), [], brief.slice(-300));
});
