// c118 came back 13 minutes after its brief line: on 10-19 frontend bro filed c118 at 07:16:44Z, then at 07:18:44Z sent the owner the onboarding
// on localhost:5180 after only an ls of the variant folder, and he answered "and it's ugly as fuck ... consistent with our actual apps" at
// 07:29:01Z. tell_owner now refuses once a 5180 link or screenshot when the chat opened no image in that turn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TELL_OWNER_DONE, tellOwner, tellTurn } from "../src/chat-guard.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-19T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const run = (id: string, code: string, clock: string): ThreadMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "ipython", arguments: { code } }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as ThreadMessage;
const output = (id: string, text: string, clock: string, image = false): ThreadMessage => ({ role: "toolResult", toolCallId: id, toolName: "ipython",
  content: [{ type: "text", text }, ...(image ? [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] : [])], isError: false, timestamp: at(clock) }) as ThreadMessage;
const tell = (id: string, text: string, clock: string): ThreadMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text, why: "answer" } }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as ThreadMessage;
const told = (id: string, text: string, clock: string): ThreadMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text }], isError: true, timestamp: at(clock) }) as ThreadMessage;

const SENT = "The new onboarding is on your Mac's 5180 too. http://localhost:5180/configure?scenario=fresh-start&line=staging&to=/app/welcome";
/** frontend bro's turn on 10-19: it opened the old campaigns shot for c118, then the owner asked for 5180, and it ran only ls and rg. */
const turn07 = [
  owner("are you fucking stupid? this should look like Outreach template case (or before). i kinda liked the icons showing.", "07:16:07"),
  run("a1", "await attach_image.run('/Users/sieunpark/scratch/campaigns/shots/e2e/01-all-campaigns.png')", "07:16:18"),
  output("a1", "Loaded 1 image(s) into context", "07:16:18", true),
  owner("야이 씨발롬이 localhost 5180에서 해야지", "07:16:47"),
  run("a2", "r = await bash('ls apps/virev-demo/variants/onboarding/')", "07:16:53"),
  output("a2", "setup-guide\nstart\nwalk", "07:16:53"),
  owner("wait check branching what is local, what is metal-02, where are each's demos at?", "07:18:11"),
  run("a3", "r1 = await bash('git status -sb')", "07:18:18"),
  output("a3", "## sieun/dev...origin/sieun/dev", "07:18:22"),
];

test("the 07:18:44Z onboarding link, sent with no screenshot opened in its turn, is refused with what to do", () => {
  const out = tellOwner({ text: SENT, why: "answer" }, tellTurn(turn07));
  assert.equal(out.kind, "refused");
  assert.match(out.text, /attach_image/);
  assert.match(out.text, /accepted Staging app/);
  assert.match(out.text, /c118/);
});

test("a screenshot opened before the owner's latest message does not count, and one opened after it does", () => {
  const opened = [...turn07, run("a4", "await attach_image.run('/Users/sieunpark/scratch/onboarding-start/walk/walk-b-3-purpose.png')", "07:18:30"),
    output("a4", "Loaded 1 image(s) into context", "07:18:30", true)];
  assert.deepEqual(tellOwner({ text: SENT, why: "answer" }, tellTurn(opened)), { kind: "sent", text: TELL_OWNER_DONE });
  const shot = "The new sidebar is on Staging. ![sidebar](/Users/sieunpark/scratch/rail-grouped/shots/campaigns-expanded.png)";
  assert.equal(tellOwner({ text: shot, why: "answer" }, tellTurn(turn07)).kind, "refused", "a markdown screenshot is a hand-off too");
  assert.equal(tellOwner({ text: shot, why: "answer" }, tellTurn(opened)).kind, "sent");
  const box = "Try it here: https://us-metal02-dev.tail0c093d.ts.net:15180/configure?scenario=fresh-start&to=/app/welcome";
  assert.equal(tellOwner({ text: box, why: "answer" }, tellTurn(turn07)).kind, "refused", "the box's 15180 copy is a hand-off too");
});

test("a message with no 5180 link or screenshot goes out as before", () => {
  const turn = tellTurn(turn07);
  for (const text of [
    "Right now both machines sit on the same dev branch, and the box runs a second copy of the demo on its port 15180.",
    "The 5180 demo restarts on its own when the Mac wakes.",
    "The landing page is up at http://localhost:5173 again.",
  ]) assert.deepEqual(tellOwner({ text, why: "answer" }, turn), { kind: "sent", text: TELL_OWNER_DONE }, text);
});

test("the very same text sent again after the refusal goes out, so the check is a soft cap (c98)", () => {
  const first = tellOwner({ text: SENT, why: "answer" }, tellTurn(turn07));
  assert.equal(first.kind, "refused");
  const again = tellTurn([...turn07, tell("t1", SENT, "07:18:44"), told("t1", first.text, "07:18:44")]);
  assert.deepEqual(tellOwner({ text: SENT, why: "answer" }, again), { kind: "sent", text: TELL_OWNER_DONE });
  assert.equal(tellOwner({ text: "Look at http://localhost:5180/app/inbox?line=staging", why: "answer" }, again).kind, "refused", "a different text is checked again");
});
