// Owner 10-09: "if i correct you like this, this should NEVER happen the next day". repeat_corrections_7d (d10) counts only repeats he gave after the rule was in force; on 10-18 it counted c103's 05:21Z follow-up from before the 05:22Z refine, and on 10-19 ops guy's 09:10Z line that the chat filed under c110, first given at 10:43Z.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { ownerSaid, repeatsBetween, type ChatHistory, type Correction, type Ledger } from "../src/chat-corrections.ts";
import { refineCommand } from "../src/correction-refine.ts";
import { fileChatHistory } from "../src/owner-history.ts";
import { chatHistories } from "../scripts/duties/harness-health.ts";

const at = Date.parse;
const chat = { id: "01a1164b-4a2d-742d-b27a-82f086ed0200", name: "AI harness developer environment VP" };
const first = "지금 자꾸 Mac에서 껐다켰다 하는 새끼 누구고 왜 그렇게 하는거야";
const follow = "Aside쓰면 깜빡이지를 않아 커서를 안가져가거든";
const rule = "Jobs never open, focus, move or close visible app windows on the owner's MacBook Pro while he uses it.";
const c103: Correction = { id: "c103", at: "2026-10-18T05:20:25.957Z", chat, words: first, rule, enforcedBy: "brief", ref: "brief", status: "reopened",
  theme: ["screen", "window", "focu", "mac"], repeats: [{ at: "2026-10-18T05:21:13.069Z", chat, words: follow }] };
const since = at("2026-10-12T00:00:00Z");
const until = at("2026-10-19T21:46:00Z");
const count = async (ledger: Ledger, histories: Record<string, ChatHistory>, fixes: Record<string, string> = {}) =>
  (await repeatsBetween(ledger, since, until, async id => histories[id] ?? { owner: [], refines: [] }, async entry => fixes[entry.id] ? at(fixes[entry.id]!) : undefined))
    .map(({ entry, repeat }) => `${entry.id} ${repeat.words}`);
const vpOwner = [{ text: first, at: at("2026-10-18T05:16:29.987Z") }, { text: follow, at: at("2026-10-18T05:21:00.875Z") }];
const refineAt = (time: string, ...items: { id: string; words: string; rule: string }[]) => ({ text: refineCommand(items), at: at(time) });

test("a follow-up the owner wrote before the first refine ran is not a repeat (c103, 10-18 05:22Z)", async () => {
  const refines = [refineAt("2026-10-18T05:22:04.450Z", { id: "c103", words: first, rule }, { id: "c103", words: follow, rule })];
  assert.deepEqual(await count({ corrections: [c103] }, { [chat.id]: { owner: vpOwner, refines } }), []);
});

test("a repeat after the first refine and a landed fix counts, and with no refine on record the entry's own time is when it came in force", async () => {
  const refines = [refineAt("2026-10-18T05:20:40Z", { id: "c103", words: first, rule })];
  const fixes = { c103: "2026-10-18T05:20:50Z" };
  assert.deepEqual(await count({ corrections: [c103] }, { [chat.id]: { owner: vpOwner, refines } }, fixes), [`c103 ${follow}`]);
  assert.deepEqual(await count({ corrections: [c103] }, { [chat.id]: { owner: vpOwner, refines: [] } }, fixes), [`c103 ${follow}`]);
});

test("a chase in the correction's own chat within a day and before its first fix landed is not a repeat (c124, frontend bro 10-19 09:17Z)", async () => {
  const fb = { id: "01a11ba8-9d2c-727c-8ded-38f819ca9f29", name: "frontend bro" };
  const ask = "오 이런거 좋아, 근데 일단 demo에서 frontend part 다시 만들어보면 안돼?";
  const chase = "wheres the campaign app i requested?";
  const c124: Correction = { id: "c124", at: "2026-10-19T08:57:28.230Z", chat: fb, words: ask, rule: "The owner reviews UI work on the 5180 screens.",
    enforcedBy: "test", ref: "sieun-pi b90f0cc4", status: "active", theme: ["ui", "review"], repeats: [{ at: "2026-10-19T09:17:49.127Z", chat: fb, words: chase }] };
  const refines = [refineAt("2026-10-19T08:57:45.162Z", { id: "c124", words: ask, rule: c124.rule })];
  const histories = { [fb.id]: { owner: [{ text: ask, at: at("2026-10-19T08:57:00Z") }, { text: chase, at: at("2026-10-19T09:17:40Z") }], refines } };
  assert.deepEqual(await count({ corrections: [c124] }, histories, { c124: "2026-10-20T06:26:10Z" }), []);
  assert.deepEqual(await count({ corrections: [c124] }, histories), []);
  assert.deepEqual(await count({ corrections: [c124] }, histories, { c124: "2026-10-19T09:10:00Z" }), [`c124 ${chase}`]);
  const other = { id: "01a1164b-0000-7000-8000-000000000000", name: "another chat" };
  const elsewhere = { ...c124, repeats: [{ ...c124.repeats[0]!, chat: other }] };
  assert.deepEqual(await count({ corrections: [elsewhere] }, { ...histories, [other.id]: histories[fb.id]! }, { c124: "2026-10-20T06:26:10Z" }), [`c124 ${chase}`]);
});

test("the same rule given again in its own chat a day or more later counts before any fix landed (c48, frontend bro 10-19 17:16Z)", async () => {
  const fb = { id: "01a11ba8-9d2c-727c-8ded-38f819ca9f29", name: "frontend bro" };
  const words = "the closest reference you must consider for feature and style is the dashboard app";
  const c48: Correction = { id: "c48", at: "2026-10-12T06:55:55.529Z", chat: fb, words: "use frontend design skill", rule: "UI work follows the frontend design skill.",
    enforcedBy: "test", ref: "sieun-pi cfd66909", status: "active", theme: ["ui", "design"], repeats: [{ at: "2026-10-19T17:16:30Z", chat: fb, words }] };
  const histories = { [fb.id]: { owner: [{ text: words, at: at("2026-10-19T17:16:10Z") }], refines: [] } };
  assert.deepEqual(await count({ corrections: [c48] }, histories, { c48: "2026-10-20T06:26:11Z" }), [`c48 ${words}`]);
});

test("a line the owner wrote in another chat before the first correction does not count, by its own time and not when it was filed (c110, ops guy 10-18)", async () => {
  const ops = { id: "01a11af8-962e-773d-a19a-ee4104011987", name: "ops guy (+observability)" };
  const plan = "a chat is a VP/TL responsible of a certain project scope. plan is meant to all be done";
  const paranoid = "stop being paranoid in plan under p45, p221.";
  const c110: Correction = { id: "c110", at: "2026-10-18T10:43:04.742Z", chat, words: plan, rule: "A chat's plan holds only finishable work.", enforcedBy: "brief",
    ref: "brief", status: "reopened", theme: ["plan", "duty"], repeats: [{ at: "2026-10-18T10:53:56.955Z", chat: ops, words: paranoid }] };
  const histories = {
    [chat.id]: { owner: [{ text: plan, at: at("2026-10-18T10:42:50Z") }], refines: [refineAt("2026-10-18T10:43:20.972Z", { id: "c110", words: plan, rule: c110.rule })] },
    [ops.id]: { owner: [{ text: `1. respond in DM. unslop unslop\n${paranoid} these should be modeled separately`, at: at("2026-10-18T09:10:47.528Z") }], refines: [] },
  };
  assert.deepEqual(await count({ corrections: [c110] }, histories), []);
});

test("an old rule given again in another chat counts (c18, frontend bro 10-19 13:51Z)", async () => {
  const fb = { id: "01a11ba8-9d2c-727c-8ded-38f819ca9f29", name: "frontend bro" };
  const words = "\"Three things I'm still fixing there.";
  const c18: Correction = { id: "c18", at: "2026-10-09T14:27:39.767Z", chat, words: "unslop unslop", rule: "Replies read like a coworker's text message.", enforcedBy: "brief",
    ref: "brief", status: "active", theme: ["reply", "plain"], repeats: [{ at: "2026-10-19T13:51:23.127Z", chat: fb, words }] };
  const histories = { [fb.id]: { owner: [{ text: `${words} Home shows 0 matched\" slop`, at: at("2026-10-19T13:50:58Z") }], refines: [] } };
  assert.deepEqual(await count({ corrections: [c18] }, histories), [`c18 ${words}`]);
});

test("a second repeat in the same chat and burst of the owner's messages counts once, and one after the burst or in another chat counts (c78, frontend bro 10-27)", async () => {
  const fb = { id: "01a11ba8-9d2c-727c-8ded-38f819ca9f29", name: "frontend bro" };
  const broken = "why is 5180 one broken? i said i want it to be like Inbox/Outreach template's sidebar?";
  const shared = "make sure things that should be shared are only written once and shared at the code level";
  const later = "component 통합. EVERYWHERE. to the second style. all apps, systematically clear duplicate";
  const c78: Correction = { id: "c78", at: "2026-10-15T15:39:01.484Z", chat: fb, words: "PLEASE FOR THE LOVE OF GOD USE CONSISTENT COMPONENTS.",
    rule: "UI jobs use one shared component set.", enforcedBy: "test", ref: "auto-sns-agent 0e90bb1421", status: "active", theme: ["ui", "component"],
    repeats: [{ at: "2026-10-27T17:09:09.376Z", chat: fb, words: broken }, { at: "2026-10-27T17:12:57.730Z", chat: fb, words: shared },
      { at: "2026-10-27T19:44:12.632Z", chat: fb, words: later }] };
  const owner = [{ text: broken, at: at("2026-10-27T17:08:51Z") }, { text: shared, at: at("2026-10-27T17:12:40Z") }, { text: later, at: at("2026-10-27T19:43:55Z") }];
  const window = (ledger: Ledger, histories: Record<string, ChatHistory>) => repeatsBetween(ledger, at("2026-10-22T00:00:00Z"), at("2026-10-29T00:00:00Z"),
    async id => histories[id] ?? { owner: [], refines: [] }, async () => at("2026-10-22T12:16:00Z"));
  const words = async (ledger: Ledger, histories: Record<string, ChatHistory>) => (await window(ledger, histories)).map(({ repeat }) => repeat.words);
  assert.deepEqual(await words({ corrections: [c78] }, { [fb.id]: { owner, refines: [] } }), [broken, later]);
  const other = { id: "01a1164b-0000-7000-8000-000000000000", name: "another chat" };
  const elsewhere = { ...c78, repeats: [c78.repeats[0]!, { ...c78.repeats[1]!, chat: other }] };
  assert.deepEqual(await words({ corrections: [elsewhere] }, { [fb.id]: { owner, refines: [] }, [other.id]: { owner, refines: [] } }), [broken, shared]);
});

test("a repeat whose words the owner never wrote in the chat does not count", async () => {
  assert.deepEqual(await count({ corrections: [c103] }, { [chat.id]: { owner: vpOwner.slice(0, 1), refines: [] } }), []);
});

test("fileChatHistory reads the owner's words and the service's /refine commands with their times from a session file", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "repeat-corrections-")), "chat.jsonl");
  const refine = refineAt("2026-10-18T05:22:04.450Z", { id: "c103", words: first, rule }, { id: "c103", words: follow, rule });
  writeFileSync(file, [
    { type: "message", message: { role: "user", content: [{ type: "text", text: first }], timestamp: vpOwner[0]!.at } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "/refine --global not a command" }], timestamp: at("2026-10-18T05:20:14Z") } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: follow }], timestamp: vpOwner[1]!.at } },
    { type: "custom_message", customType: "session_slash_command", content: refine.text, display: false, timestamp: "2026-10-18T05:22:04.450Z" },
  ].map(line => JSON.stringify(line)).join("\n") + "\n");
  const history = await fileChatHistory(file);
  assert.deepEqual(history, { owner: vpOwner, refines: [refine] });
  assert.deepEqual(await count({ corrections: [c103] }, { [chat.id]: history }), []);
  assert.deepEqual(await fileChatHistory(join(tmpdir(), "no-such-chat.jsonl")), { owner: [], refines: [] });
});

test("a chat with no session file on this box is read from the Mac, and a failed Mac read is reported (frontend bro, 10-19)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repeat-corrections-mac-"));
  const line = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
  writeFileSync(join(dir, "aaaa.jsonl"), line("box words") + "\n");
  const asked: string[] = [];
  const errors: string[] = [];
  const history = chatHistories(dir, async id => {
    asked.push(id);
    if (id === "cccc") throw new Error("ssh mac: Connection timed out");
    return id === "bbbb" ? gzipSync(line("is any other tabs ready for review?") + "\n") : Buffer.alloc(0);
  }, errors);
  assert.deepEqual(await history("aaaa"), { owner: [{ text: "box words", at: 1 }], refines: [] });
  assert.deepEqual(await history("bbbb"), { owner: [{ text: "is any other tabs ready for review?", at: 1 }], refines: [] });
  assert.deepEqual(await history("dddd"), { owner: [], refines: [] });
  assert.deepEqual(await history("cccc"), { owner: [], refines: [] });
  assert.deepEqual(asked, ["bbbb", "dddd", "cccc"]);
  assert.deepEqual(errors, ["cccc: ssh mac: Connection timed out"]);
});

test("a repeat the chat cut with an ellipsis or joined with a period counts when each piece is in one owner message (c118, frontend bro 10-19)", () => {
  const owner = ["and it's ugly as fuck. \n일단 이거 좀 성의있게 styling 할수 없어? consistent with our actual apps. the form fucking sucks.\n\nuse clerk components 이런거 때문에 니가 현실성을 못느껴서 ㅈㄴ 대충하는거 같잖아\n\nuse subagent aggressively. maybe even each agent for each page literally"];
  assert.equal(ownerSaid("and it's ugly as fuck. 일단 이거 좀 성의있게 styling 할수 없어? consistent with our actual apps. ... 이런거 때문에 니가 현실성을 못느껴서 ㅈㄴ 대충하는거 같잖아. use subagent aggressively. maybe even each agent for each page literally", owner), true);
  assert.equal(ownerSaid("consistent with our actual apps. ... use subagents for the landing page", owner), false);
});
