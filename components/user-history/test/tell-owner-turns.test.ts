// 10-19: chats sent the owner 597 messages in a day and 469 of them came on turns he did not start (job reports, other threads, check-ins,
// [job] notices, wakes), so his feed was a long list of relays (c117). A tell_owner call on such a turn names its case or stays a note.
import assert from "node:assert/strict";
import { test } from "node:test";
import { askedTodos, TELL_OWNER_DONE, tellOwner, tellTurn, WAKE_NOTE, withWakeNotes } from "../src/chat-guard.ts";
import { chatLines, ownerMessageId, TELL_OWNER_HELD } from "../src/shared/chat-feed.ts";
import type { AssistantMessage, ThreadMessage } from "../src/shared/types.ts";

const at = (clock: string): number => Date.parse(`2026-10-19T${clock}Z`);
const owner = (text: string, clock: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: at(clock) }) as ThreadMessage;
const job = (text: string, clock: string): ThreadMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from child:deploy gate]\n\n${text}`, timestamp: at(clock) });
const said = (text: string, clock: string): ThreadMessage => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: at(clock) }) as unknown as ThreadMessage;
const tell = (id: string, args: Record<string, unknown>, clock: string): AssistantMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: args }], stopReason: "toolUse", timestamp: at(clock) }) as unknown as AssistantMessage;
const result = (id: string, text: string, clock: string): ThreadMessage => ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text }], isError: false, timestamp: at(clock) });

const asked = owner("fix the autovacuum stall in the deploy gate", "05:00:00");
const settled = [asked, said("The job deploy gate autovacuum fixes it.", "05:01:00")];

test("on a job report the owner did not start, a relay is held as a note and a named case reaches him", () => {
  const turn = tellTurn([...settled, job("taken, the stub case is in", "05:20:00")]);
  assert.equal(turn.owner, false);
  const relay = tellOwner({ text: "The job took the gate fix and wrote a stub case.", why: "update" }, turn);
  assert.equal(relay.kind, "held");
  assert.ok(relay.text.startsWith(TELL_OWNER_HELD));
  const bare = tellOwner({ text: "The job took the gate fix." }, turn);
  assert.equal(bare.kind, "refused", "on 10-19 ops guy's finished Grafana cleanup went with no why, and a held answer never got a second call");
  assert.match(bare.text, /why is required/);
  assert.equal(tellOwner({ text: "Here is the answer." }, { ...turn, owner: true }).kind, "sent", "an owner turn needs no why");
  assert.equal(tellOwner({ text: "The gate fix is live.", why: "done" }, turn).kind, "held", "a case with no about stays a note");
  assert.deepEqual(tellOwner({ text: "The gate fix is live, the 12:16 stall case passes.", why: "done", about: "autovacuum stall fix" }, turn),
    { kind: "sent", text: TELL_OWNER_DONE });
  assert.equal(tellOwner({ text: "The gate fix is live.", reply_to: ownerMessageId(asked.timestamp) }, turn).kind, "sent", "a reply_to his message is an answer");
  assert.equal(tellOwner({ text: "The gate fix is live.", reply_to: "zzz", why: "update", about: "gate fix" }, turn).kind, "held");
  assert.equal(tellOwner({ text: " ", why: "done", about: "x" }, turn).kind, "refused");
});

test("on the owner's turn every call reaches him, also when a job report joins that turn", () => {
  const ownTurn = tellTurn([...settled, owner("is it live?", "05:30:00")]);
  assert.equal(ownTurn.owner, true);
  assert.equal(tellOwner({ text: "Not yet, the land runs now." }, ownTurn).kind, "sent");
  const running = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "ipython", arguments: {} }], stopReason: "toolUse", timestamp: at("05:30:10") } as unknown as ThreadMessage;
  const joined = tellTurn([...settled, owner("is it live?", "05:30:00"), running, job("land 48 is green", "05:31:00")]);
  assert.equal(joined.owner, true);
  const retry = owner("[check-in] Your last turn failed at 05:40 (429). The owner's message is still unanswered: \"is it live?\". Answer it first.", "05:45:00");
  assert.equal(tellTurn([...settled, retry]).owner, true);
  const stopped = { role: "assistant", content: [], stopReason: "aborted", timestamp: at("05:31:00") } as unknown as ThreadMessage;
  const restart = owner("[check-in] Your last turn failed at 05:31 (aborted). Re-check the board and continue.", "05:33:00");
  assert.equal(tellTurn([...settled, owner("is it live?", "05:30:00"), stopped, restart]).owner, true, "a restart after an aborted owner turn is still his");
  assert.equal(tellTurn([...settled, job("taken", "05:20:00"), said("noted", "05:20:30"), restart]).owner, false);
  const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "429", timestamp: at("05:31:00") } as unknown as ThreadMessage;
  const checkIn = owner("[check-in] Check-in: could not reach job idle ram drop, so start a job in its place.", "05:32:00");
  assert.equal(tellTurn([...settled, owner("is it live?", "05:30:00"), said("Yes, since 05:10.", "05:30:30"), checkIn]).owner, false);
  assert.equal(tellTurn([...settled, owner("is it live?", "05:30:00"), failed, checkIn, tell("t9", { text: "Not yet." }, "05:34:00")]).owner, true,
    "his message has no answer yet, so the call that answers it goes out");
});

test("the feed shows a held call in the turn's notes and a sent one as a bubble", () => {
  const lines = chatLines([...settled, job("taken", "05:20:00"),
    tell("t1", { text: "The job took the gate fix.", why: "update" }, "05:20:10"), result("t1", `${TELL_OWNER_HELD}. The owner did not start this turn.`, "05:20:11"),
    tell("t2", { text: "The gate fix is live.", why: "done", about: "autovacuum stall fix" }, "05:20:20"), result("t2", TELL_OWNER_DONE, "05:20:21")]);
  const told = lines.flatMap(line => line.kind === "agent" && line.told ? [line.text] : []);
  assert.deepEqual(told, ["The gate fix is live."]);
  assert.ok(lines.some(line => line.kind === "notes" && line.text === "The job took the gate fix."));
});

test("each wake-up in the model's view carries the note, and the owner's messages do not", () => {
  const notice = owner("[job] deploy gate autovacuum ended at 05:10 with no report", "05:10:00");
  const retry = owner("[check-in] Your last turn failed at 05:11 (aborted). Re-check the board and continue.", "05:12:00");
  const view = withWakeNotes([asked, job("taken", "05:05:00"), notice, retry]);
  assert.ok(view);
  const noted = view.map(message => JSON.stringify(message).includes(WAKE_NOTE));
  assert.deepEqual(noted, [false, true, true, false]);
});

test("on a turn the owner did not start, two tell_owner calls in one step are refused so the chat sends one message", () => {
  // 10-19 17:21Z to 20:55Z: frontend bro, AI harness and Crawler VP each sent one answer or two finished items as 2 calls in one step.
  const two = [tell("a", { text: "Dashboards are live.", why: "done", about: "crawler dashboards" }, "06:00:00"), tell("b", { text: "The old board is gone." }, "06:00:00")];
  const step = { role: "assistant", content: [...(two[0] as any).content, ...(two[1] as any).content], stopReason: "toolUse", timestamp: at("06:00:00") } as unknown as ThreadMessage;
  const ended = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop", timestamp: at("05:50:30") } as unknown as ThreadMessage;
  const jobTurn = tellTurn([...settled, owner("set up dashboards", "05:50:00"), ended, job("boards deployed", "05:59:00"), step]);
  assert.equal(jobTurn.owner, true, "his newest message has no answer yet");
  assert.equal(tellOwner({ text: "Dashboards are live.", why: "done", about: "crawler dashboards" }, jobTurn).kind, "refused");
  const ownStep = tellTurn([...settled, owner("is it live?", "06:10:00"), { ...step, timestamp: at("06:10:05") } as ThreadMessage]);
  assert.equal(tellOwner({ text: "Yes, live." }, ownStep).kind, "sent", "two points on his own turn stay two calls (c97)");
  const one = tellTurn([...settled, job("boards deployed", "05:59:00"), { ...step, content: (two[0] as any).content } as ThreadMessage]);
  assert.equal(tellOwner({ text: "Dashboards are live.", why: "done", about: "crawler dashboards" }, one).kind, "sent");
});

test("on a turn the owner did not start, a second done on the goal it already reported is refused once, and the same text again goes out", () => {
  // 10-19 to 10-20: frontend bro sent "demo work landing on staging" at 00:34Z and "later demo work landing on staging" at 01:33Z, ops guy a
  // correction of its cleanup incident, and AI harness a second usage history line, each after a done on the same goal and no owner message between.
  const first = tell("d1", { text: "The demo is on staging.", why: "done", about: "demo work landing on staging" }, "06:00:00");
  const history = [...settled, job("landed", "05:59:00"), first, result("d1", TELL_OWNER_DONE, "06:00:01"), said("", "06:00:02"), job("later land done", "07:00:00")];
  const again = { text: "Tonight's later demo work is on staging too.", why: "done", about: "later demo work landing on staging" };
  const refused = tellOwner(again, tellTurn(history));
  assert.equal(refused.kind, "refused");
  assert.match(refused.text, /already told him this goal is done/);
  const call = tell("d2", again, "07:00:05");
  const insisted = tellTurn([...history, call, result("d2", refused.text, "07:00:06"), tell("d3", again, "07:00:10")]);
  assert.equal(tellOwner(again, insisted).kind, "sent", "the very same text again goes out, so a real result is never lost");
  assert.equal(tellOwner({ ...again, about: "Grafana load on prod ClickHouse" }, tellTurn(history)).kind, "sent", "another goal goes out");
  const asked = tellTurn([...history.slice(0, -1), owner("and the rest?", "06:30:00"), said("checking", "06:30:10"), job("later land done", "07:00:00")]);
  assert.equal(tellOwner(again, asked).kind, "sent", "an owner message in between starts over");
});

test("on a turn the owner did not start, a message naming an open todo the chat added in an earlier turn is refused once", () => {
  // 10-20: mac-management asked about the metal queue slots at 02:44Z, 03:07Z and 03:14Z, each naming t4, the todo it had put on For you at 23:11Z.
  const turn = tellTurn([...settled, job("slots cut to 18", "07:00:00")]);
  const asked = { ...turn, asked: askedTodos([{ id: "t4", done: false, at: "2026-10-19T06:00:00Z", from: "agent" }, { id: "t5", done: false, at: "2026-10-19T07:00:30Z", from: "agent" }], turn.startedAt) };
  const again = { text: "Slots are at 18 now, pick 18 or 24 in t4.", why: "decision", about: "metal queue slot count (t4)" };
  const refused = tellOwner(again, asked);
  assert.equal(refused.kind, "refused");
  assert.match(refused.text, /already waits for him on For you as t4/);
  assert.equal(tellOwner({ ...again, text: "Pick one in t5.", about: "new ask (t5)" }, asked).kind, "sent", "a todo added in this turn goes with its question (c96)");
  assert.equal(tellOwner(again, { ...asked, resent: new Set([again.text]) }).kind, "sent", "the very same text again goes out");
  assert.equal(tellOwner(again, { ...asked, owner: true }).kind, "sent", "his own turn is never held");
  assert.deepEqual([...askedTodos([{ id: "t4", done: true, at: "2026-10-19T06:00:00Z" }], turn.startedAt)], [], "an answered todo is no longer waiting");
  // 10-21 09:47Z: mac-management added t8 at 09:47:42Z, a job's message was steered in at 09:47:43Z, and the question for t8 was refused once.
  const adding = { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "chat_board", arguments: {} }], stopReason: "toolUse", timestamp: at("07:00:05") } as unknown as ThreadMessage;
  const steered = tellTurn([...settled, job("slots swing 60 to 89%", "07:00:00"), adding, result("b1", "Added a todo t8", "07:00:06"), job("prod checks started", "07:00:07")]);
  assert.equal(steered.startedAt, at("07:00:00"), "a message steered in mid-turn starts no new turn");
  assert.deepEqual([...askedTodos([{ id: "t8", done: false, at: "2026-10-19T07:00:06Z", from: "agent" }], steered.startedAt)], [], "a todo added in this turn goes with its question");
});

test("a Prime quota resume or restart note starts no owner turn, so the chat's plain answer to it is notes, and an owner turn it interrupts stays his", () => {
  // 10-20 04:38Z to 05:43Z: vent, api portal, AI harness, CI and RepoOps and Crawler VP answered <provider_quota_resumed> as if the owner wrote.
  const resume = owner("<provider_quota_resumed>\nThe provider usage limit that paused this session has been reported as reset.", "07:00:00");
  const lines = chatLines([...settled, resume, said("I resumed and restarted the jobs.", "07:00:30")]);
  assert.ok(!lines.some(line => line.kind === "agent" && line.text.includes("I resumed")), "the plain answer is not a bubble");
  assert.ok(!lines.some(line => line.kind === "user" && line.text.includes("provider_quota_resumed")), "the note is not his message");
  assert.equal(tellTurn([...settled, resume]).owner, false);
  const cut = { role: "assistant", content: [{ type: "toolCall", id: "c9", name: "ipython", arguments: {} }], stopReason: "toolUse", timestamp: at("06:50:10") } as unknown as ThreadMessage;
  assert.equal(tellTurn([...settled, owner("is it live?", "06:50:00"), cut, resume]).owner, true, "a quota pause inside his turn keeps it his");
  assert.equal(tellTurn([owner("Prime Agent restarted after an update. Continue the interrupted task.", "07:10:00")]).owner, false);
  const update = owner("<prime_agent_update_interrupted>\nPrime Agent was updated while this turn ran.\n</prime_agent_update_interrupted>", "07:20:00");
  assert.equal(tellTurn([...settled, update]).owner, false, "every Prime tag note is Prime's, as d9, d10 and d11 read it");
  assert.equal(tellTurn([...settled, owner("<b>bold</b> is fine?", "07:30:00")]).owner, true);
});

test("on a turn the owner did not start, a blocker that asks nothing of him is refused once, and one that says what he must do goes out", () => {
  // 10-19 to 10-20: ops guy sent its two disk cleanup incidents as blocker while a job handled each, and api portal a crawler outage the crawler
  // team owned; of 23 blocker calls on such turns, the 8 that asked him for something were real, and 1 of the other 15 was needed.
  const turn = tellTurn([...settled, job("cleanup stopped", "07:00:00")]);
  const incident = { text: "Another disk cleanup deleted 60 folders of other chats' work. It's stopped now, and a job is telling each chat what it lost.", why: "blocker", about: "cleanup deleted live work" };
  const refused = tellOwner(incident, turn);
  assert.equal(refused.kind, "refused");
  assert.match(refused.text, /asks nothing of him/);
  assert.equal(tellOwner(incident, { ...turn, resent: new Set([incident.text]) }).kind, "sent", "the very same text again goes out");
  assert.equal(tellOwner({ ...incident, text: "The add-on is uploaded, but its last tab needs your sign-in. Sign in once with Touch ID in Aside." }, turn).kind, "sent");
  assert.equal(tellOwner({ ...incident, text: "Promote 16 failed and my tools broke. Please restart this chat." }, turn).kind, "sent");
  assert.equal(tellOwner({ ...incident, text: "Cloudflare 로그인이 필요해요, Aside에서 한 번 로그인해 주세요." }, turn).kind, "sent");
  assert.equal(tellOwner(incident, { ...turn, owner: true }).kind, "sent", "his own turn is never held");
});

test("on a turn the owner did not start, an ask that another chat already put on For you is refused once, and the same text again goes out", () => {
  // 10-21: Crawler VP asked to restart the stuck prod crawler worker as t56 at 06:01:53Z, then launch main bro asked at 06:02:09Z and
  // metal-management at 06:08:09Z, the same incident three times in 7 min.
  const turn = tellTurn([...settled, job("watchlist green fell to 73.6%", "07:00:00")]);
  const t56 = { chat: "01a115e2-9544-7204-b8db-8ce4d5319048", id: "t56", at: "2026-10-19T06:59:00Z", text: "Prod TikTok signing and the Instagram jobs " +
    "worker are stuck, and the metal box owner is out on usage limits until 15:40 KST or later. May I run the two fix commands on us-metal01 myself, this once?" };
  const others = { ...turn, others: [t56] };
  const again = { text: "Prod Watchlist has been mostly down since 11:04 KST, and the restart that fixes it is waiting on the metal box owner, who's " +
    "paused on a usage limit. Your rule c146 keeps me off prod's box, so can I do that one restart myself? Answer on t7.", why: "decision", about: "prod Watchlist outage restart" };
  const now = at("07:01:00");
  const refused = tellOwner(again, others, now);
  assert.equal(refused.kind, "refused");
  assert.match(refused.text, /another chat already asks him this on For you, as t56 of chat 01a115e2/);
  const history = [...settled, job("watchlist green fell to 73.6%", "07:00:00"), tell("s1", again, "07:01:00"), result("s1", refused.text, "07:01:01"), tell("s2", again, "07:01:30")];
  assert.equal(tellOwner(again, { ...tellTurn(history), others: [t56] }, now).kind, "sent", "the very same text again goes out");
  assert.equal(tellOwner(again, { ...others, owner: true }, now).kind, "sent", "his own turn is never held");
  assert.equal(tellOwner(again, others, at("07:01:00") + 24 * 3_600_000).kind, "sent", "a todo older than a day is a standing question, not this incident");
  assert.equal(tellOwner(again, turn, now).kind, "sent", "with no other chat's todo it goes out");
  assert.equal(tellOwner({ ...again, why: "done", about: "prod Watchlist back" }, others, now).kind, "sent", "only an ask is checked");
  const addOn = { text: "Chrome add-on 1.3 is uploaded to the Chrome Web Store, but Google only takes the review submission after a sign-in. " +
    "Can you sign in once in Aside with Touch ID?", why: "blocker", about: "Chrome add-on review" };
  assert.equal(tellOwner(addOn, { ...turn, others: [{ ...t56, text: "Give your Cloudflare token access to konti.bot, so a job can sign in once in Aside." }] }, now).kind, "sent",
    "a different ask that shares a few words goes out");
});

test("on a turn the owner did not start, a text that reports work still going is refused once, and the very same text again goes out", () => {
  // 10-22: Crawler VP sent interim numbers "still being counted" 28 min before its final answer, and (temp) mcp release a scope change that
  // said it would ask him after that; d11 labelled both, and AI harness's "down to 11 open steps", as progress relays.
  const turn = tellTurn([...settled, job("sample read done, the new-profile count is running", "06:30:00")]);
  const interim = { text: "Only about 15% of logged-out profile reads return related profiles. How many of those are new to us is still being counted.",
    why: "answer", about: "how many related profiles are new" };
  const refused = tellOwner(interim, turn);
  assert.equal(refused.kind, "refused");
  assert.match(refused.text, /work still going \("still being counted"\)/);
  const later = tellTurn([...settled, job("taken", "06:30:00"), tell("p1", interim, "06:30:10"), result("p1", refused.text, "06:30:11")]);
  assert.equal(tellOwner(interim, later).kind, "sent", "the very same text again goes out");
  for (const text of ["The MCP job now ends at a passing staging test, and I'll ask you to walk the prod deploy with it after that.",
    "My plan is down to 11 open steps, each with a job on it.", "The 6-hour hold clock starts now, and slots are stepping up again toward 20k."])
    assert.equal(tellOwner({ text, why: "done", about: "plan items" }, turn).kind, "refused", text);
  assert.equal(tellOwner({ text: "Instagram census reads 12,000 profiles a minute now, past your 10k goal.", why: "done", about: "10k Instagram profiles a minute" }, turn).kind, "sent");
  assert.equal(tellOwner({ text: "Check Campaigns on 5180 now, everything is in except the template editor, which is still finishing.", why: "done", about: "campaigns demo" }, { ...turn, looked: true }).kind, "sent");
  assert.equal(tellOwner(interim, { ...turn, owner: true }).kind, "sent", "his own turn is never held");
});
