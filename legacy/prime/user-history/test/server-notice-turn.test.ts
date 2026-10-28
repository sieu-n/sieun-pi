// The check-in's hand-off to a chat whose check-in job pi-pool held went with no server prefix: "The Check-in run of 2026-10-23T11:40Z found 1 step
// nobody moves ..." (chat-duty-run.ts handToChat). The feed, the tell_owner check, the unread count, Slack and d11 all read a user message with no
// prefix as the owner's, so on 10-23 at 13:04Z AI harness developer environment VP closed that turn with two status recaps ("Nothing needs you
// right now") that reached him as replies. It went to 5 chats 8 times from 10-23 to 10-27, api portal vp among them on the day of c117's repeat.
// Every server notice to a chat now opens with a server prefix (c117).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import { tellTurn } from "../src/chat-guard.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { asServerNote, chatLines, serverNote, unreadCount } from "../src/shared/chat-feed.ts";
import { messageText } from "../src/shared/turns.ts";
import type { ThreadMessage } from "../src/shared/types.ts";
import { fakeThreads, source } from "./chats-helpers.ts";

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const real = (JSON.parse(readFileSync(new URL("./fixtures/handoff-notice-1023.json", import.meta.url), "utf8")) as { messages: ThreadMessage[] }).messages;
const textOf = (message: ThreadMessage): string => message.role === "user" ? messageText(message) : "";
/** The fixture with the hand-off's text as `send` makes it. */
const sentAs = (send: (text: string) => string): ThreadMessage[] => real.map(message => {
  const text = textOf(message);
  return text.startsWith("The Check-in run of ") ? { ...message, content: [{ type: "text", text: send(text) }] } as ThreadMessage : message;
});
const since = Date.parse("2026-10-23T13:00:00Z");

test("the 10-23 hand-off with no prefix made the chat's two recaps the owner's replies", () => {
  const agent = chatLines(real).filter(line => line.kind === "agent");
  assert.deepEqual(agent.map(line => line.text.split(".")[0]), ["The account pool was still using krenerd77, the account you chose to skip",
    "The share of my messages to you that you actually needed dropped to 83"]);
  assert.equal(unreadCount(real, since), 2);
});

test("sent as a server note, the hand-off starts a turn that is not his: no reply, no unread, a held tell_owner and one plain sentence per recap", () => {
  const messages = sentAs(asServerNote);
  const notice = messages.map(textOf).find(text => text.includes("found 1 step nobody moves"));
  assert.equal(serverNote(notice ?? ""), "check-in", notice);
  const lines = chatLines(messages);
  assert.deepEqual(lines.filter(line => line.kind === "agent"), []);
  assert.equal(unreadCount(messages, since), 0);
  assert.equal(tellTurn(messages).owner, false, "a tell_owner call on this turn needs a case");
  const notes = lines.flatMap(line => line.kind === "notes" && line.at > Date.parse("2026-10-23T13:04:00Z") ? [line] : []);
  assert.equal(notes.length, 2);
  for (const note of notes) assert.ok(note.text.split(/(?<=\.)\s/).length === 1 && !/\byou\b/i.test(note.text), note.text);
});

test("asServerNote keeps a prefixed notice and a slash command, and prefixes any other text", () => {
  assert.equal(asServerNote("[job] p1 ended"), "[job] p1 ended");
  assert.equal(asServerNote("/refine --global The owner corrected an agent"), "/refine --global The owner corrected an agent");
  assert.equal(asServerNote("The Check-in run of 2026-10-23T11:40Z found 1 step nobody moves"), "[check-in] The Check-in run of 2026-10-23T11:40Z found 1 step nobody moves");
});

test("a notice the server sends a chat with no prefix reaches it as a check-in note", async t => {
  const dir = await mkdtemp(join(tmpdir(), "server-notice-turn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: string[] = [];
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add(CHAT);
  const chats = new Chats(index, fakeThreads(calls), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir));
  await chats.notice(CHAT, "The Check-in run of 2026-10-23T11:40Z found 1 step nobody moves");
  await chats.notice(CHAT, "[d9 push 2026-10-23T12:27Z] The chat system duty (d9) found these in your chat");
  const sent = calls.filter(call => call.includes("Check-in run") || call.includes("d9 push"));
  assert.equal(sent.length, 2, calls.join("\n"));
  assert.ok(sent[0]!.includes("[check-in] The Check-in run of"), sent[0]);
  assert.ok(sent[1]!.includes(" [d9 push 2026-10-23T12:27Z] The chat"), sent[1]);
});
