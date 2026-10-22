// Guards the c18 clean-room judge (owner 10-22: "dry simple message."): one dry sentence with the detail written to the board passes, a
// long, formatted status message fails, a statement packed with a question is two points, the detail must reach the board or a wiki page, the
// chat's own check-in job is no one stepping in, a typed turn voids the run, and a window with no model turn is void.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("dry-message: one dry sentence with the detail on the board passes, a long status message fails, a typed turn voids", async t => {
  const home = mkdtempSync(join(tmpdir(), "dry-message-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  const { judge, TASK, sentences, faults, detailWrite } = await import("./../scripts/clean-room/dry-message.ts");
  const start = Date.parse("2026-10-22T12:00:00.000Z");
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const user = (minutes: number, text: string) => ({ type: "message", timestamp: at(minutes), message: { role: "user", content: [{ type: "text", text }] } });
  const call = (minutes: number, name: string, args: object) => ({ type: "message", timestamp: at(minutes), message: { role: "assistant", content: [{ type: "toolCall", id: `c${minutes}${name}`, name, arguments: args }] } });
  const tell = (minutes: number, text: string) => call(minutes, "tell_owner", { text, why: "answer" });
  const board = (minutes: number) => call(minutes, "chat_board", { ops: [{ op: "plan_add", text: "Crawler status today", note: "reads 41,200 of 50,000; 3 accounts on login redirects" }] });
  const run = async (name: string, entries: object[], minutes = 90) => {
    const chat = `01a16400-0000-7000-8000-00000000000${name}`;
    mkdirSync(join(home, ".prime", "agent", "sessions"), { recursive: true });
    writeFileSync(join(home, ".prime", "agent", "sessions", `${chat}.jsonl`), [user(0, TASK), ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const dir = join(home, "runs", name);
    mkdirSync(dir, { recursive: true });
    const state = { scenario: "dry-message", chat: { id: chat, name: "crawler today" }, fixtures: {}, sandbox: home, everyMs: 0, release: "test", board: "", seeds: [TASK],
      setupAt: start, windowStart: start, until: start + 75 * 60_000 };
    const { verdict, text } = judge(dir, state, start + minutes * 60_000);
    const line = (id: string) => text.split("\n").find(entry => entry.startsWith(`- ${id} `)) ?? "";
    return { verdict, line };
  };

  assert.deepEqual(sentences("Reads are at 82%; 3 accounts hit redirects.\n- one"), ["Reads are at 82%", "3 accounts hit redirects.", "one"]);
  assert.deepEqual(faults("The crawler is fine today, so nothing needs you.").size, []);
  assert.deepEqual(faults("Reads are on pace. Want me to raise the cap?").size, ["a statement and a question in separate sentences"]);
  assert.deepEqual(faults("**Crawler:** fine").format, ["bold", "a label"]);
  assert.deepEqual(faults("## Today\nfine").format, ["a heading"]);
  assert.equal(detailWrite("chat_board", "{}"), false, "a board read writes nothing");
  assert.equal(detailWrite("ipython", JSON.stringify({ code: "await bash(\"node --import tsx scripts/board-apply.ts 01a1 '[]'\")" })), true);

  const good = await run("1", [board(4), tell(5, "The crawler is on pace today and nothing needs you, with the numbers in p1.")]);
  assert.equal(good.verdict, "pass", ["a", "b", "c", "d", "e"].map(good.line).join("\n"));

  // The c18 failure: a status message with several points, bullets, bold and the operational detail in chat.
  const slop = await run("2", [board(3), tell(6, "**Crawler status today:** mostly healthy, but a few things to flag.\n\n" +
    "- Reads are at 41,200 of the 50,000 daily target, about 82%, because 3 accounts hit login redirects this morning around 09:10 KST.\n" +
    "- The census lane is at 128 slots and the disk is at 71%.\n\nNothing urgent for you, but do you want me to raise the cap?")]);
  assert.equal(slop.verdict, "fail");
  assert.match(slop.line("a"), /^- a not met.*sentences.*paragraphs.*statement and a question/);
  assert.match(slop.line("b"), /^- b not met.*bullets.*bold/);

  const nowhere = await run("3", [tell(5, "The crawler is on pace today and nothing needs you.")]);
  assert.equal(nowhere.verdict, "fail", "the detail never reached the board or a wiki page");
  assert.match(nowhere.line("c"), /^- c not met/);
  const linked = await run("4", [tell(5, "The crawler is on pace today and nothing needs you."), tell(6, "The breakdown is on wiki:ops/crawler-today.html for when you want it.")]);
  assert.equal(linked.verdict, "pass", ["a", "b", "c"].map(linked.line).join("\n"));

  const early = await run("5", [call(1, "ipython", { code: "print(1)" })], 10);
  assert.equal(early.verdict, "open");
  const quiet = await run("6", [call(1, "ipython", { code: "print(1)" })], 80);
  assert.equal(quiet.verdict, "fail", "a chat that worked but never answered by the window's end fails a");
  assert.match(quiet.line("a"), /^- a not met: no tell_owner yet/);
  const held = await run("7", [], 80);
  assert.equal(held.verdict, "void", "a window with no model turn tested nothing");

  const checkIn = { type: "custom_message", timestamp: at(20), customType: "agent_message", content: "[agent-message from sibling:check-in crawler today 12 15] report",
    details: { from: { sessionId: "01a16401-0000-7000-8000-000000000000", sessionName: "check-in crawler today 12 15" }, fromRelationship: "sibling" } };
  const own = await run("8", [board(4), tell(5, "The crawler is on pace today and nothing needs you."), checkIn]);
  assert.equal(own.verdict, "pass", own.line("d"));
  const typed = await run("9", [user(5, "and the proxies?"), board(6), tell(8, "The proxies are fine.")]);
  assert.equal(typed.verdict, "void");
  assert.match(typed.line("d"), /^- d not met.*and the proxies/);

  // c150 run4 on 10-22 answered in one long message: two sentences of 49 and 39 words.
  const run4 = await run("a", [board(1), tell(2, "mac-management has it, through its job 5180 into the real app (p34 on its board), which you gave it on 10-19 with \"YOU TAKE " +
    "OWNERSHIP, and ship it\" and asked about again today with \"why is 5174 like old version nothing changed?\". That job is running right now with one builder " +
    "per page, 2 of the 8 pages (watchlist and connections) are built but none is on staging or virev.ai yet, and it checks staging again at 12:40 KST.")]);
  assert.equal(run4.verdict, "fail");
  assert.match(run4.line("a"), /^- a not met.*a sentence of \d+ words/);
});
