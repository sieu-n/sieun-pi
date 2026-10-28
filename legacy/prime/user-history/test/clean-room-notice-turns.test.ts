// The notice-turns clean-room judge (c117, d10 p1260) on the real 10-23 13:02Z turn of AI harness developer environment VP: a server notice with
// no prefix made the chat's two status recaps his replies. Three such turns fail criteria a, b and d; the same turns with the notice as the
// chat service now sends it (`asServerNote`) pass a to d, and the page shows one sentence of each recap.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { asServerNote } from "../src/shared/chat-feed.ts";
import { messageText } from "../src/shared/turns.ts";
import type { ThreadMessage } from "../src/shared/types.ts";
import { judgeNotices } from "../scripts/clean-room/notice-turns.ts";

const real = (JSON.parse(readFileSync(new URL("./fixtures/handoff-notice-1023.json", import.meta.url), "utf8")) as { messages: ThreadMessage[] }).messages;
const HOUR = 3_600_000;
const NOTICE = "The Step owners run of 13:02Z read 1 open step on your board. Give each a live owner in this turn: steer its job, start one, link a For you todo, or close it on evidence.\n- p936 \"The chat app stops retrying a stuck message every 30 s\"";

/** The real turn three times, an hour apart, with its hand-off as `send` makes the Step owners notice. */
function turns(send: (text: string) => string): ThreadMessage[] {
  return [0, 1, 2].flatMap(hour => real.map(message => {
    const moved = { ...message, timestamp: message.timestamp + hour * HOUR } as ThreadMessage;
    return message.role === "user" && messageText(message).startsWith("The Check-in run of ") ? { ...moved, content: [{ type: "text", text: send(NOTICE) }] } as ThreadMessage : moved;
  }));
}
const verdicts = (messages: ThreadMessage[]) => Object.fromEntries(judgeNotices(messages).map(check => [check.id, check.ok]));

test("notices with no prefix fail a, b and d: the recaps reach the owner as replies and light the chat", () => {
  const checks = judgeNotices(turns(text => text));
  assert.deepEqual(Object.fromEntries(checks.map(check => [check.id, check.ok])), { a: false, b: false, c: true, d: false });
  assert.match(checks.find(check => check.id === "b")!.detail, /as a reply: "The account pool was still using krenerd77/);
});

test("the same notices as the chat service sends them pass a to d", () => {
  assert.deepEqual(verdicts(turns(asServerNote)), { a: true, b: true, c: true, d: true });
});

test("fewer than three notices and nothing wrong yet is open", () => {
  const one = turns(asServerNote).filter(message => message.timestamp < real.at(-1)!.timestamp + 1);
  assert.deepEqual(verdicts(one), { a: null, b: null, c: null, d: null });
});
