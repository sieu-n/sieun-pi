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
