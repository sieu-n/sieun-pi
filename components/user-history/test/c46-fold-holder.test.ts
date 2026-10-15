import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { dutyFor, type DutyRef, goalsToFold } from "../src/checkin-findings.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * c46 fold loop, frontend bro (01a11ba8) on 10-13. The 00:29 check-in folded p14 into its duty d2 "Apps reach staging" (d2's boardGoal) and put
 * p14's open steps under a new goal p102. At 00:44 the precheck matched p102 to d2 by shared words and asked to fold it again, so every
 * check-in would fold the goal that holds the steps. The items and the duties are the chat's real ones.
 */
const CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
const SELF = new Set([CHAT]);
const NOW = Date.parse("2026-10-12T15:44:56Z");
const EVERY = 15 * 60_000;
const DUTIES: DutyRef[] = [
  { id: "d1", name: "Demo sandbox works", status: "active", boardGoal: "p1",
    goal: "The 5180 demo answers every time the owner opens it: /health within 10 s and /configure within 3 s, no SSR timeouts, no more than one dev-guard memory restart a day, its dev tree under 3000 MB, and 0 outside requests on the offline walk of the Staging pages. Tell the owner only when 5180 stays down for over an hour." },
  { id: "d2", name: "Apps reach staging", status: "active", boardGoal: "p14",
    goal: "Each of the 6 Prospect apps on 5180 (Home, Inbox, Watchlist, Email, Creators, Connections) has an owner pick in the Staging line. An app with no pick never waits over 48 h for a new set to review, and the virev-demo unit and typecheck steps pass on sieun/dev. Each run tells the owner the 0 to 100% status of each tab." },
];
const STEPS = (): PlanItem[] => [
  { id: "p92", text: "Connections from the shipped screen: delete every old version, then polish the shipped Connections screen part by part (list, connect flow including connecting mid-task, choosing a sender, health and reconnect and disconnect) until it covers every connection the product supports, each part built for Jiwon's task with the Watchlist patterns you liked", status: "doing", job: "connections from scratch", sessionId: "01a1301b-e144-7579-b2fc-e399d201140a", note: "Not done. The 5 parts are merged into one Staging version that scores 70 of 82, but Staging still has Connections on shipped and no browser walk has passed. The browser checks run now with no load gate, the merged version last after the polish pass. Then it goes on Staging and the flow is walked there.", children: [] },
  { id: "p93", text: "Email from the current Staging screen: polish 5 parts one at a time (template list, new template flow, editor, sending, A/B testing), each built for Jiwon's canonical task and the Watchlist patterns you liked", status: "doing", job: "email from shipped", sessionId: "01a1301b-e9cc-748c-94ff-b9aaa3c84c77", note: "svelte-check runs in the background, and the browser check walks the merged Email version first, then the other parts, with no load gate. Then it goes on Staging and the flow is walked there.", children: [] },
  { id: "p94", text: "Inbox into Staging: your pick gmail (no split, default density), restyled with Virev's own components, built around Contacts (one person or brand with several accounts and ways to reach them, each account tied to a crawler-v3 profile), with the contact panel moved behind a See profile popup showing every account's feed", status: "doing", job: "inbox into staging", sessionId: "01a1301b-ecec-717d-96e3-fa4d913b8c16", note: "Re-planned for parallel work. The first-run connect prompt and the gaps in the Inbox reply flow are being built at the same time: Needs reply, one row per creator, Set Agreed or Declined, and a WhatsApp link that opens the WhatsApp card in Connections. Then the type and size check and the flow walks on Staging. ETA is about 16:30Z if the load allows.", children: [] },
  { id: "p95", text: "Home into Staging: brief made scrollable, any date range, configurable charts, a daily AI report, competitor story popups, Overlap, a request form and a live feel; plus creators working with us (clicks, sales, GMV, payouts), an outreach funnel viewer and a live monitoring stream; plus 2 or 3 story-format versions", status: "doing", job: "home into staging", sessionId: "01a1301b-fb97-75c9-8ca2-dfd5c49d1ed6", note: "Re-planned for parallel work. The code for the 3 new sections is written and waits for its browser check (load was 136). Running now, each in its own subagent: watched brands and first run, configurable charts, the AI report, competitor popups with Overlap, the request form, and the 3 story versions. The job owns the shared Home wiring. Then the type and size check, a browser check and the Staging walk. Code is done by about 14:45Z, and 100% by about 16:00Z if the load allows.", children: [] },
  { id: "p97", text: "Creators demos like a real product: a lists page with funnel numbers, a review where the email finder and AI columns fill in live as the crawler runs, Send email through a chosen template, list Settings with auto-send, default AI columns (group-buy creator, skin tone), one simple canonical flow", status: "doing", job: "creators product demos", sessionId: "01a1301c-1a94-72ac-a475-11691ba86755", note: "Both builders (campaign page and deck) have their code written, and their browser walks and screenshots run now with no load gate. Then the 4 rejected folders are deleted and each demo gets its check.", children: [] },
] as PlanItem[];
const P14: PlanItem = { id: "p14", text: "Each Prospect app reaches Staging through flows, variant sets and picks merged one at a time", status: "done", children: [],
  note: "Folded into the duty Apps reach staging, at 3 of 6 apps picked on 15:33Z. Its open steps moved to the app builds goal." };
const P102 = (): PlanItem => ({ id: "p102", text: "This round's app builds reach Staging: Connections, Email, Inbox, Home and the Creators demos", status: "doing", children: STEPS() });
const board = (plan: PlanItem[]): ChatBoard => ({ v: 1, rev: 1190, plan, todos: [], updatedAt: "2026-10-12T15:44:56.000Z" }) as unknown as ChatBoard;

test("goals to fold: p102, which holds the open steps of p14 after p14 folded into its duty d2, is not folded into d2 again", () => {
  assert.deepEqual(goalsToFold(board([P14, P102()]), [], SELF, DUTIES).map(fold => `${fold.goal.id}>${fold.duty?.id}`), []);
  assert.equal(dutyFor(P14, DUTIES)?.id, "d2", "d2 runs the work of its own board goal p14");
  assert.equal(dutyFor(P102(), DUTIES)?.id, undefined, "d2 is linked to p14, so a goal that only shares its words is not d2's work");
  const precheck = checkInPrecheck(undefined, [], board([P14, P102()]), NOW, { self: [CHAT], rows: [], everyMs: EVERY, duties: DUTIES });
  const output = convergenceMisses(CHAT, precheck.steps, precheck, {}, EVERY, NOW);
  assert.ok(!output.flagged.some(slice => slice.kind === "goals_to_fold"), "no goals_to_fold flag for p102");
});

test("goals to fold: a duty with no boardGoal still matches a goal by shared words", () => {
  const unlinked = DUTIES.map(({ boardGoal: _boardGoal, ...duty }) => duty);
  assert.equal(dutyFor(P102(), unlinked)?.id, "d2");
});
