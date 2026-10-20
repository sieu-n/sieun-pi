// c124 came back 20 minutes after its brief line: on 10-19 frontend bro filed c124 at 08:57:28Z and had told the owner at 08:57:15Z "I'll send
// the link as soon as its screens render", while "campaigns final build" had reported "It renders with ?v.creators=campaigns-final" at
// 08:42:29Z and "Home is built (shots checked)" at 08:57:32Z. The [job] notices for its builders cf-home (09:05:27Z) and cf-funnel (09:13:49Z)
// went by, and the owner asked "wheres the campaign app i requested?" at 09:17:30Z. The check-in now tells the chat which job's 5180 screens
// the owner has no link to.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobFact } from "../src/checkin-steps.ts";
import { owedLinkLines, owedLinks, screenKeys } from "../src/owed-links.ts";
import type { OwnerTodo, ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-19T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const job = (name: string, text: string, clock: string): ThreadMessage =>
  ({ role: "custom", customType: "agent_message", content: `[agent-message from child:${name}]\n\n${text}`, display: true, timestamp: at(clock) }) as unknown as ThreadMessage;
const notice = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
/** One tell_owner call and the tool's answer, "told the owner" when it went out. */
const tell = (id: string, text: string, clock: string, result = "told the owner"): ThreadMessage[] => [
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text, why: "answer" } }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as ThreadMessage,
  ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text: result }], isError: false, timestamp: at(clock) }) as ThreadMessage,
];
const fact = (name: string, extra: Partial<JobFact> = {}): JobFact => ({ key: `sub-${name}`, name, state: "working", ...extra });

const CAMPAIGNS = "campaigns final build";
const ONBOARDING_LINK = "About your company is done on your 5180, as one clean grid. http://localhost:5180/configure?scenario=fresh-start&line=staging&to=/app/welcome";
const CAMPAIGNS_LINK = "The Heartleaf campaign opens straight on its new Home here. http://localhost:5180/app/analytics/creators/heartleaf-toner-us?view=home&v.creators=campaigns-final";
/** frontend bro on 10-19 from 08:42Z to the 09:12:12Z check-in, cut to the lines that matter. */
const before0912: ThreadMessage[] = [
  job(CAMPAIGNS, "Campaigns final, status at 08:46Z.\n1. Fork made: apps/virev-demo/variants/creators/campaigns-final. It renders with ?v.creators=campaigns-final.", "08:42:29"),
  ...tell("t1", "The Campaigns final plan is up. wiki:sessions/2026/10/19/1732-campaigns-final/decision", "08:46:42"),
  owner("오 이런거 좋아, 근데 일단 demo에서 frontend part 다시 만들어보면 안돼?", "08:56:39"),
  ...tell("t2", "Yes, that's how it works already. Campaigns final is being built on your 5180 now, and I'll send the link as soon as its screens render.", "08:57:15"),
  job(CAMPAIGNS, "Got it: no more doc work, I'm spending the time on the screens. Home is built (shots checked).", "08:57:32"),
  ...tell("t3", ONBOARDING_LINK, "09:00:10"),
  notice("[job] cf-home ended at 18:03 with no report", "09:05:27"),
];
const facts = [fact(CAMPAIGNS), fact("onboarding brand and campaign steps")];

test("the 09:12:12Z check-in would tell the chat that campaigns final build's screens have no link to the owner", () => {
  const lines = owedLinkLines(before0912, facts);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[job\] campaigns final build named its screens on 5180 at \d\d:\d\d \(v\.creators=campaigns-final\)/);
  assert.match(lines[0]!, /localhost:5180 link/);
  assert.match(lines[0]!, /reply_to/);
  assert.match(lines[0]!, /c124/);
  assert.match(lines[0]!, /attach_image \(c118\)/);
});

test("only a link to the same variant pays: the 09:00Z onboarding link did not, the 09:17:57Z campaigns link does", () => {
  assert.deepEqual(owedLinks(before0912, facts).map(debt => debt.job), [CAMPAIGNS]);
  const after = [...before0912, owner("wheres the campaign app i requested?", "09:17:30"), ...tell("t4", CAMPAIGNS_LINK, "09:17:57")];
  assert.deepEqual(owedLinks(after, facts), []);
  const refused = [...before0912, ...tell("t5", CAMPAIGNS_LINK, "09:10:00", "Not sent, it has shop talk: 18:10Z (18:10 KST)")];
  refused[refused.length - 1] = { ...refused.at(-1)!, isError: true } as ThreadMessage;
  assert.deepEqual(owedLinks(refused, facts).map(debt => debt.job), [CAMPAIGNS], "a link the tool refused never reached him");
});

test("a For you todo with the link pays it, and a later report on a screen he has opens no debt", () => {
  const todo: OwnerTodo = { id: "t9", text: "Look at Campaigns final", done: false, from: "agent", at: "2026-10-19T09:01:00Z",
    links: [{ label: "Campaigns final", target: "http://localhost:5180/app/analytics/creators?v.creators=campaigns-final" }] };
  assert.deepEqual(owedLinks(before0912, facts, [todo]), []);
  const later = [...before0912, ...tell("t4", CAMPAIGNS_LINK, "09:17:57"), job(CAMPAIGNS, "Six parts render on ?v.creators=campaigns-final now.", "09:30:00")];
  assert.deepEqual(owedLinks(later, facts), []);
  const fresh = [...later, job(CAMPAIGNS, "Tags render on ?v.inbox=desk-tags too.", "09:40:00")];
  assert.deepEqual(owedLinks(fresh, facts), [{ job: CAMPAIGNS, at: at("09:40:00"), keys: ["v.inbox=desk-tags"] }]);
});

test("a job the chat cancelled or no longer lists owes nothing", () => {
  assert.deepEqual(owedLinks(before0912, [fact(CAMPAIGNS, { cancelled: true })]), []);
  assert.deepEqual(owedLinks(before0912, []), []);
});

test("the line goes once until the job messages again", () => {
  const [line] = owedLinkLines(before0912, facts);
  const told = [...before0912, notice(line!, "09:12:12")];
  assert.deepEqual(owedLinkLines(told, facts), []);
  assert.equal(owedLinkLines([...told, job(CAMPAIGNS, "cf-funnel's screening fix is in.", "09:13:00")], facts).length, 1);
});

test("screen keys are the variant switches a text names, not bare demo paths", () => {
  assert.deepEqual([...screenKeys(CAMPAIGNS_LINK)], ["v.creators=campaigns-final"]);
  assert.deepEqual([...screenKeys("[React Email](http://localhost:5180/app/analytics/email?v.email=editor-react-email).")], ["v.email=editor-react-email"]);
  assert.deepEqual([...screenKeys(ONBOARDING_LINK)], []);
});
