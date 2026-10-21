// vent 10-21: two findings on p7 "Check every search app flow end to end on clean data, and fix what breaks" were wrong in 10 check-ins in a row.
// blocked_on_others read "blocked on promote for 3 d": p7 waits for the open agent todo t13, and "promote" came from the note's past "Prod after
// promote 17". job_end_silent read "search flows finish stopped on a provider error ... with no report": the job ended on an error at 10-20
// 19:24Z, resumed, and sent the chat its p7 report at 08:32:59Z and 08:35Z as "[agent-message from sibling:search flows finish]".
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses, lastJobMessages } from "../src/chat-checkin.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { agentMessageSender } from "../src/no-report.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-21T09:17:18Z");
const THREAD = "01a14fbd-c47f-724d-b259-b4d820c06eb3";
const endAt = Date.parse("2026-10-20T19:24:01Z");
const t13: OwnerTodo = { id: "t13", text: "To test the staging Instagram DM flow end to end, our spare account ohalin7 sends one DM ... Ok?", done: false,
  choices: ["Send it", "Not yet"], from: "agent", at: "2026-10-20T22:33:20.632Z" } as OwnerTodo;
const p7: PlanItem = { id: "p7", text: "Check every search app flow end to end on clean data, and fix what breaks", status: "doing", job: "search flows finish",
  sessionId: THREAD, note: "Done when: the search flow checks pass on staging. Prod after promote 17: /app/welcome 200. It waits on the owner's \"Send it\" on t13.",
  waitFor: "t13 answer from the owner on the staging test DM between two spare accounts; then about 15 minutes to reconnect the sender and send it", children: [] };
const board = (todos: OwnerTodo[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: "2026-10-18T16:10:35Z", todos,
  plan: [{ id: "p1", text: "Search app works end to end", status: "doing", children: [p7] }] }) as unknown as ChatBoard;
const said = (at: string, text: string) => ({ role: "custom", customType: "agent_message", timestamp: Date.parse(at), content: `[agent-message from sibling:search flows finish]\n\n${text}` });
const owner = (messages: ReturnType<typeof said>[]): JobFact => {
  const lastMessage = lastJobMessages(messages).get("search flows finish");
  return { key: `thread:${THREAD}`, name: "search flows finish", state: "ended", activityAt: Date.parse("2026-10-21T08:35:01Z"), ...lastMessage ? { lastMessage } : {} };
};
const run = (todos: OwnerTodo[], fact: JobFact) => {
  const precheck = checkInPrecheck(undefined, [fact], board(todos), now);
  const told = { [`thread:${THREAD}`]: { at: endAt, cause: "error" as const } };
  return convergenceMisses("vent", precheck.steps, precheck, told, 30 * 60_000, now).flagged
    .filter(slice => slice.item === "p7" && (slice.kind === "blocked_on_others" || slice.kind === "job_end_silent")).map(slice => slice.kind);
};
const reports = [said("2026-10-21T08:32:59Z", "p7 report: staging a2a3b405c4 all green but the real DM"), said("2026-10-21T08:35:00Z", "p7 update: the dm-real world was reaped")];

test("a sibling's agent message counts under its own name", () => {
  assert.equal(agentMessageSender("[agent-message from sibling:search flows finish]\n\nhi"), "search flows finish");
  assert.equal(agentMessageSender("[agent-message from child:ux-email]\n\nhi"), "ux-email");
  assert.equal(lastJobMessages(reports).get("search flows finish")?.at, Date.parse("2026-10-21T08:35:00Z"));
});

test("a root on another box counts under the name its cross-host line gives", () => {
  const text = "[agent-message from unknown:chat-service]\n\n[cross-host message from ops guy (+observability) (01a11af8-962e-773d) on mac; answer with " +
    "agent_message.send(text, receiver_role=\"sibling\", receiver_name=\"01a11af8-962e-773d\")]\n\np45 is done";
  assert.equal(agentMessageSender(text), "ops guy (+observability)");
  assert.equal(lastJobMessages([{ role: "custom", customType: "agent_message", timestamp: 1, content: text }]).get("ops guy (+observability)")?.text, "p45 is done");
});

test("p7 on open todo t13 is not blocked on others, and its job's reports after the error clear job_end_silent", () => {
  assert.deepEqual(run([t13], owner(reports)), []);
});

test("without t13 and the reports, the same p7 still reads the error end as silent, and a note's past promote names no blocker", () => {
  assert.deepEqual(run([], owner([])), ["job_end_silent"]);
  assert.deepEqual(run([], owner([said("2026-10-20T19:00:00Z", "a report before the end")])), ["job_end_silent"]);
  const waits = { ...p7, waitFor: "promote 18 on prod" };
  const precheck = checkInPrecheck(undefined, [owner(reports)], { ...board([]), plan: [{ id: "p1", text: "Search app", status: "doing", children: [waits] }] } as ChatBoard, now);
  const flagged = convergenceMisses("vent", precheck.steps, precheck, {}, 30 * 60_000, now).flagged.filter(slice => slice.kind === "blocked_on_others");
  assert.match(flagged[0]?.excerpt ?? "", /blocked on promote/, "a waitFor that names promote still counts");
});
