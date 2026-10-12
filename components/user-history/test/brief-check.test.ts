import assert from "node:assert/strict";
import { test } from "node:test";
import { briefCheck, briefCheckNote, type BriefInput, ownerMessages, quotedOwnerWords, turnOwnerAt } from "../src/shared/brief-check.ts";
import { serverNote } from "../src/shared/chat-feed.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp }) as unknown as ThreadMessage;
const reply = (text: string, timestamp: number, stopReason = "toolUse") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp }) as unknown as ThreadMessage;

const goal = "keep every crawler page under two minutes and tell me when it holds";
const ask = "are you not conveying the raw version of the message? like can you simulate what you send to the agent?";
const transcript = [
  user(goal, 1_000), reply("on it", 1_100, "stop"),
  user(ask, 5_000), reply("starting a job", 5_100),
];
const input = (brief: string, extra: Partial<BriefInput> = {}): BriefInput =>
  ({ brief, owner: ownerMessages(transcript), turnOwner: turnOwnerAt(transcript, 5_200), previousSpawnAt: 2_000, ...extra });

test("brief check: a brief that quotes the message that started the job and has a Split line passes", () => {
  const brief = `[task from parent]\nOwner's words (verbatim):\n1. 10:02 "${ask}"\n\nMy read: he wants the raw brief shown.\nSplit: inline, two file reads.\nAudit the briefs.`;
  assert.deepEqual(briefCheck(input(brief)), []);
  const cut = "Owner\u2019s words (verbatim):\n1. 10:02 \u201care you not conveying   the raw version ... can you simulate what you send\u201d (his ask)\nMy read: x\nSplit: one subagent per chat.";
  assert.deepEqual(briefCheck(input(cut)), [], "curly quotes, extra spaces, a \"...\" cut and a note after the quote pass");
  assert.deepEqual(quotedOwnerWords(cut), [["are you not conveying the raw version", "can you simulate what you send"]]);
});

test("brief check: a paraphrased owner quote is not verbatim", () => {
  const brief = `Owner's words (verbatim):\n1. "is the chat passing my raw messages to agents? ... simulate the brief format"\nMy read: x\nSplit: inline.`;
  assert.deepEqual(briefCheck(input(brief)), [{ kind: "not-verbatim", piece: "is the chat passing my raw messages to agents?" }, { kind: "not-verbatim", piece: "simulate the brief format" }]);
});

test("brief check: an old goal line reused on a turn a check-in started is an old message", () => {
  const checkIn = [...transcript, reply("done", 5_300, "stop"), user("[check-in] Your last turn failed at 10:00 (429). Re-check the board and continue.", 9_000), reply("starting", 9_100)];
  assert.equal(serverNote("[check-in] x"), "check-in");
  const turnOwner = turnOwnerAt(checkIn, 9_200);
  assert.equal(turnOwner, null, "a check-in started the turn");
  const brief = `Owner's words (verbatim):\n1. "${goal}"\nMy read: x\nSplit: inline.`;
  assert.deepEqual(briefCheck({ brief, owner: ownerMessages(checkIn), turnOwner, previousSpawnAt: 5_200 }), [{ kind: "old-message", quoted: { text: goal, at: 1_000 } }]);
  assert.deepEqual(briefCheck({ brief, owner: ownerMessages(checkIn), turnOwner, previousSpawnAt: null }), [], "the chat's first job may quote any owner message");
  assert.deepEqual(briefCheck(input(brief, { previousSpawnAt: 5_200 })), [], "on a turn the owner started, a job may quote the older ask it answers");
  const none = "Owner's words: none, started by check-in\n\"Your last turn failed\"\nMy read: x\nSplit: one subagent per stalled job.";
  assert.deepEqual(briefCheck({ brief: none, owner: ownerMessages(checkIn), turnOwner, previousSpawnAt: 5_200 }), [], "none on a check-in turn passes");
  assert.deepEqual(briefCheck(input(none)), [{ kind: "none-but-owner-turn", owner: { text: ask, at: 5_000 } }], "none on a turn the owner started");
});

test("brief check: a missing Split line and a missing owner block are findings", () => {
  assert.deepEqual(briefCheck(input(`Owner's words (verbatim):\n1. "${ask}"\nMy read: x\nSplitting work is up to you.`)), [{ kind: "no-split" }]);
  assert.deepEqual(briefCheck(input("Audit the briefs.\nSplit: inline.")), [{ kind: "no-owner-block" }]);
  assert.deepEqual(briefCheck(input("Owner's words (verbatim): he wants the raw brief\nMy read: x\nSplit: inline.")), [{ kind: "no-owner-block" }], "a block with no quote");
  const note = briefCheckNote("brief audit", [{ kind: "no-split" }]);
  assert.match(note, /^\[brief check\] Your brief for \[brief audit\]\(job:brief audit\) breaks the Jobs rule:\n- No `Split:` line\./);
  assert.match(note, /receiver_name="brief audit"/);
  assert.equal(serverNote(note), "brief check");
});

test("brief check: owner messages leave out server notes and board actions, and a restarted owner turn stays the owner's", () => {
  const messages = [user(ask + "\n[message id: abc]", 1_000), user("[board] chose Go on p3", 2_000), user("[reply check] Your reply had: x", 3_000),
    user("[check-in] Your last turn failed at 10:00 (429). The owner's message is still unanswered: \"x\". Answer it first.", 4_000), reply("ok", 4_100)];
  assert.deepEqual(ownerMessages(messages).map(message => message.at), [1_000]);
  assert.equal(turnOwnerAt(messages, 4_200)?.at, 1_000, "the server's restart of a failed owner turn keeps it the owner's");
  assert.equal(turnOwnerAt(messages, 2_500), null, "a board action is not an owner message");
  assert.deepEqual(briefCheck({ brief: `Owner's words (verbatim):\n1. "${ask} [message id: abc]"\nSplit: inline.`, owner: ownerMessages(messages), turnOwner: null, previousSpawnAt: null }), []);
});
