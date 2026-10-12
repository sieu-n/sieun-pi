import assert from "node:assert/strict";
import test from "node:test";
import { tellOwner } from "../src/chats.ts";
import { foldReply, REPLY_CHECK_PREFIX, replyWordCount, serverNote } from "../src/shared/chat-feed.ts";
import { lastOwnerText, lintOwnerReply, replyCheck, replyNotes } from "../src/shared/reply-lint.ts";
import type { ThreadMessage } from "../src/shared/types.ts";
import { CLEAN_REPLIES, SLOP_REPLIES } from "./reply-lint-replies.ts";

const whats = (text: string, owner = ""): string[] => lintOwnerReply(text, owner).map(finding => finding.what);
const kinds = (text: string, owner = ""): string[] => lintOwnerReply(text, owner).map(finding => finding.kind);

test("reply lint: the real replies the owner called slop fail, each for what made it slop", () => {
  const expected: Record<keyof typeof SLOP_REPLIES & string, string[]> = {
    "two stages": ["69 words", 'label opener "**코드 체크.**", "**프롬프트.**"', 'abstract words "단계", "계산"'],
    "built-in duty": ['internal terms "기본으로 들어가", "보드 관리"'],
    "fan-out logic": ['abstract words "로직"', 'internal terms "duty", "fan-out"'],
    "ledger labels": ["76 words", 'label opener "**Ledger:**", "**Health check:**", "**Backfill:**"'],
    "check-in job labels": ["109 words", 'label opener "**Check-in turn:**", "**Real work:**", "**Quiet ticks:**"', 'internal terms "check-in job"'],
    "standing duty bullets": ["90 words", "4 bullets"],
    "pro bullets": ["77 words", "4 bullets"],
  };
  assert.deepEqual(Object.keys(expected), Object.keys(SLOP_REPLIES));
  for (const [name, reply] of Object.entries(SLOP_REPLIES)) assert.deepEqual(whats(reply.reply, reply.owner), expected[name], name);
  for (const finding of lintOwnerReply(SLOP_REPLIES["two stages"]!.reply)) assert.ok(finding.hint.length > 10, "every finding carries a plain fix");
});

test("reply lint: real short plain replies pass, a mermaid diagram and 3 bullets included", () => {
  assert.ok(Object.keys(CLEAN_REPLIES).length >= 4);
  for (const [name, reply] of Object.entries(CLEAN_REPLIES)) assert.deepEqual(whats(reply.reply, reply.owner), [], name);
});

test("reply lint: an internal term the owner used in the message the reply answers is spared; otherwise it is flagged", () => {
  const { reply, owner } = SLOP_REPLIES["built-in duty"]!;
  assert.match(owner, /un-deletable duty/, "the owner said duty");
  assert.deepEqual(whats(reply, owner), ['internal terms "기본으로 들어가", "보드 관리"']);
  assert.deepEqual(whats(reply), ['internal terms "duty", "duties", "기본으로 들어가", "보드 관리"'], "with no owner words, duty is ours too");
  assert.deepEqual(whats(reply, "보드 관리 얘기야? 기본으로 들어가는 거 맞아? duty"), [], "the owner's own words are fine");
  assert.deepEqual(whats("The check-in steers the chat with a digest.", "why did the chat get a message?"), ['internal terms "digest", "steers"']);
  assert.deepEqual(whats("The check-in steers the chat with a digest.", "what's the digest and who steers?"), []);
  assert.deepEqual(whats("I moved Cal.com hooks and [orphan steps](job:orphan steps) runs now."), [], "a product's hooks and a job name are names");
  assert.deepEqual(whats("A token hook failed, so the pre-check runs again with the fan out."), ['internal terms "pre-check", "fan out", "hook"']);
});

test("reply lint: shape findings, as the owner's corrections name them", () => {
  for (const opener of ["Update:", "Done:", "Live now:", "Fixed X:", "Status:", "Summary:", "Next steps:"]) {
    assert.deepEqual(kinds(`${opener} the deploy finished at 14:20.`), ["label"], opener);
    assert.deepEqual(kinds(`The deploy finished.\n- ${opener} nothing else.`), ["label"], `${opener} on a bullet`);
  }
  assert.deepEqual(kinds("**Still open:** two steps."), ["label"]);
  assert.deepEqual(kinds("The deploy finished at 14:20: all green."), [], "a colon after a sentence is no label; a time is no colon");
  assert.deepEqual(whats("It works \u2014 mostly.\nOne gap \u2013 the docs."), ["em dash and en dash"]);
  assert.deepEqual(kinds("It works, `a\u2014b` in code is fine."), []);
  assert.deepEqual(whats("## Status\nIt works."), ['heading "## Status"']);
  assert.deepEqual(whats("- one\n- two\n- three"), []);
  assert.deepEqual(whats("- one\n- two\n- three\n1. four"), ["4 bullets"]);
  assert.deepEqual(whats("It has **one** and **two** and **three** and **four**."), ["4 bold spans"]);
  assert.deepEqual(whats("It has **a bold part that runs on for well over forty characters**."), ['bold over 40 characters "a bold part that runs on for well over\u2026"']);
});

test("reply lint: abstract words, with the uses that name a real thing spared", () => {
  assert.deepEqual(whats("The server computes it in two stages, and the second step is the model."), ['abstract words "stages", "second step", "computes"']);
  assert.deepEqual(whats("The server computes 14 metrics. Stage 2 lands today."), [], "a number names it");
  assert.deepEqual(whats("The pipeline is slow; the crawler pipeline is fine."), ['abstract words "pipeline"'], "only the unnamed one");
  assert.deepEqual(whats("I just sent it; it's done just now. Not really, it's fine."), [], "recency and 'not really' are plain");
  assert.deepEqual(whats("It just works and really helps, essentially."), ['abstract words "essentially", "really", "just"']);
  assert.deepEqual(whats("Step 1 is the logic that handles retries."), ['abstract words "step 1", "logic", "handles"']);
  assert.deepEqual(whats('You said "the logic stage" earlier. `pipeline` runs.\n> robust pipeline logic\n[logic pipeline](job:logic pipeline) is on it.'), [],
    "quoted words, code spans, quoted lines and links are not read");
  assert.deepEqual(whats("두 번째 단계에서 서버가 계산해요. 3단계는 계산 결과 12개를 보내요."), ['abstract words "단계", "계산"'], "Korean stems, a numbered stage spared");
});

test("reply lint: words count the way the page folds: link labels, a code span as one word, no image or URL, no list mark", () => {
  assert.equal(replyWordCount("See [secrets walkthrough](job:secrets walkthrough) and `npm run test` at https://example.com/a/b ![chart](/tmp/x.png)."), 6);
  assert.equal(replyWordCount("- one\n- two\n```mermaid\nflowchart LR\n  A --> B\n```\n3. three"), 3);
  const sixty = Array.from({ length: 58 }, (_, index) => `w${index}`).join(" ");
  assert.deepEqual(foldReply(`${sixty} [two words](job:x y)`), { shown: `${sixty} [two words](job:x y)`, folded: false });
  assert.deepEqual(foldReply(`${sixty} [three more words](job:x y)`), { shown: `${sixty}\u2026`, folded: true }, "a cut never falls inside a link");
  assert.deepEqual(whats(`${sixty} a b c`), ["61 words"]);
});

test("reply lint: a limit with a rate or size needs the measured resource and how full it was, or a plain 'not measured' (c43, owner 10-12)", () => {
  const unmeasured = (text: string): string[] => lintOwnerReply(text).filter(finding => finding.kind === "unmeasured").map(finding => finding.what);
  const refused = [
    "Each new Instagram profile writes about 1.7 MB to the server disk, which caps new profiles near 2,200 a minute.",
    "Census new reads cap near 2,100/min because of metal's 75 MB/s NVMe write line.",
    "Each account can only scrape about 50 pages per account before Instagram bans it.",
    "The proxy pool tops out at 300 requests a minute, so the backfill takes 4 days.",
    "We can go up to 1,500 profiles/min on one box.",
    "계정당 하루 최대 50장까지만 긁을 수 있어요.",
  ];
  for (const reply of refused) assert.equal(unmeasured(reply).length, 1, reply);
  assert.deepEqual(unmeasured(refused[0]!), ['limit with no measurement "caps new profiles near 2,200 a minute."']);
  assert.match(tellOwner(refused[0]).text, /- limit with no measurement .*: name the resource you measured and how full it was \(disk 95% busy, CPU 400%/);
  const passed = [
    "Census new reads hit 2,100/min, and iostat showed the NVMe 98% busy, so disk is the cap.",
    "CPU sat at 400% on 4 cores, so the box tops out near 900 profiles a minute.",
    "We hit Instagram's rate limit at 200 requests an hour, with 429s on 40% of calls after that.",
    "The API ceiling is above 1,500 req/s; p99 latency was 40 ms there.",
    "Census reads cap near 2,100/min only because of a 75 MB/s caution line an earlier agent set; it is not measured, so I'm load testing the disk now.",
    "The NVMe is rated 7,000 MB/s and we write 75 MB/s, so disk is not the bottleneck.",
    "The brief allows at most 6 open goals and max 3 bullets.",
    "Claude Max costs $200 a month.",
    "The crawler wrote 2,100 profiles a minute for the last hour.",
    'You asked "what caps us at 2,100/min", and I am measuring disk, CPU and RAM now.',
  ];
  for (const reply of passed) assert.deepEqual(lintOwnerReply(reply), [], reply);
});

test("tell_owner refuses a reply with findings and returns them with fixes; a plain one goes through", () => {
  assert.deepEqual(tellOwner("The audit is done; nothing failed."), { ok: true, text: "told the owner" });
  const refused = tellOwner("Update: the digest is ready \u2014 see the board.");
  assert.equal(refused.ok, false);
  assert.match(refused.text, /^Refused: the owner did not see it\. Rewrite it and call tell_owner again:\n/);
  assert.match(refused.text, /- label opener "Update:": drop the label/);
  assert.match(refused.text, /- em dash: use a comma or end the sentence/);
  assert.match(refused.text, /- internal terms "digest": /);
  assert.deepEqual(tellOwner("The digest is ready.", "is the digest ready?"), { ok: true, text: "told the owner" }, "the owner's own word");
});

const user = (text: string, timestamp: number): ThreadMessage => ({ role: "user", content: [{ type: "text", text }], timestamp });
const said = (text: string, timestamp: number, extra: Record<string, unknown> = {}): ThreadMessage =>
  ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp, ...extra }) as unknown as ThreadMessage;
const told = (text: string, timestamp: number, id: string): ThreadMessage =>
  ({ role: "assistant", content: [{ type: "toolCall", id, name: "tell_owner", arguments: { text } }], stopReason: "toolUse", timestamp }) as unknown as ThreadMessage;
const result = (id: string, timestamp: number, isError = false): ThreadMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text: "x" }], isError, timestamp }) as unknown as ThreadMessage;

test("reply check: one server note per owner-turn reply with findings, naming them; none for a clean reply, a wake-up or tell_owner", () => {
  const slop = SLOP_REPLIES["two stages"]!;
  const messages = [user(slop.owner, 1), said(slop.reply, 2)];
  const check = replyCheck(messages)!;
  assert.equal(check.at, 2);
  assert.ok(check.message.startsWith(REPLY_CHECK_PREFIX));
  assert.equal(serverNote(check.message), "reply check", "the feed folds it and the turn it starts is not the owner's");
  assert.match(check.message, /^\[reply check\] Your reply to the owner "네, 거의 맞아요\. 두 단계로 돌아가요\. 1\. \*\*코드\u2026" had:\n- 69 words: /);
  assert.match(check.message, /- abstract words "단계", "계산": name the real thing/);
  assert.match(check.message, /send one corrected short reply with tell_owner now\. Otherwise do not resend it; apply this from your next reply\.$/);
  assert.equal(replyCheck([user("is it live?", 1), said("Yes, it's live on virev.ai.", 2)]), null, "a clean reply");
  assert.equal(replyCheck([...messages, user(check.message, 3), said("Noted.", 4)])?.at, 2, "the reply-check turn's own text is notes; the owner reply stays the last");
  assert.equal(replyCheck([user("[check-in] What changed", 1), said("Update: all good \u2014 nothing.", 2)]), null, "text on a wake-up is notes");
  assert.equal(replyCheck([user("go", 1), said(slop.reply, 2, { stopReason: "aborted" })]), null, "a stopped reply");
  assert.equal(replyCheck([user("[job] x ended", 1), told("Fine now.", 2, "t1"), result("t1", 3)]), null, "tell_owner checks itself");
});

test("reply notes: each owner message after a reply with findings carries them, from that reply only, so the prefix holds", () => {
  const messages = [
    user("why is CI slow?", 1), said("Update: one runner \u2014 the M1.", 2),
    user("ok and now?", 3), said("Two jobs queued.", 4),
    user("[check-in] What changed", 5), told("Status: done.", 6, "t1"), result("t1", 7, true), told("All done.", 8, "t2"), result("t2", 9),
    user("thanks", 10),
  ];
  const notes = replyNotes(messages);
  assert.deepEqual([...notes.keys()], [2]);
  assert.equal(notes.get(2), '[reply check] Your last owner reply had: label opener "Update:"; em dash. Fix that in this reply.');
  assert.deepEqual([...replyNotes(messages.slice(0, 3)).entries()], [...notes.entries()], "a later message changes no earlier note");
  assert.equal(lastOwnerText(messages), "thanks");
  assert.equal(lastOwnerText([user("<skill name=\"unslop\">\nlots of rules about pipelines\n</skill>\nunslop this", 1)]), "unslop this");
});

test("reply check on an owner turn: text after an accepted tell_owner is notes and gets no check; text with no accepted tell_owner still does (W59)", () => {
  const slop = SLOP_REPLIES["standing duty bullets"]!;
  const answered = [user(slop.owner, 1), told("Three jobs started; I report when they finish.", 2, "t1"), result("t1", 3), said(slop.reply, 4)];
  assert.equal(replyCheck(answered), null, "the owner read the told text; the long text after it is notes");
  assert.deepEqual(replyNotes([...answered, user("ok", 5)]), new Map(), "and the model's view carries no finding for it");
  const refusedFirst = [user(slop.owner, 1), told(slop.reply, 2, "t1"), result("t1", 3, true), said(slop.reply, 4)];
  assert.equal(replyCheck(refusedFirst)?.at, 4, "a refused tell_owner leaves the plain text as the reply, so the [reply check] still fires");
  assert.equal(replyCheck([user(slop.owner, 1), said(slop.reply, 2)])?.at, 2, "plain text alone keeps the check");
});
