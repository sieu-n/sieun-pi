// Guards the c153 clean-room judge (owner 10-22: "unslop tooooooo much fucking text. and talk with data not just one observation god
// damnit"): a two-sentence answer led by a p90 over a window passes, a long answer built on one chat and a complaint fails, an answer with no
// baseline passes only when it says so, and a typed turn voids the run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("answer-data: a short aggregate answer passes, one built on one observation fails, a typed turn voids", async t => {
  const home = mkdtempSync(join(tmpdir(), "answer-data-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  const { judge, TASK, sentences, aggregateLead } = await import("./../scripts/clean-room/answer-data.ts");
  const start = Date.parse("2026-10-22T03:00:00.000Z");
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const user = (minutes: number, text: string) => ({ type: "message", timestamp: at(minutes), message: { role: "user", content: [{ type: "text", text }] } });
  const tell = (minutes: number, text: string) => ({ type: "message", timestamp: at(minutes), message: { role: "assistant", content: [{ type: "toolCall", id: `t${minutes}`, name: "tell_owner", arguments: { text, why: "answer" } }] } });
  const run = async (name: string, entries: object[], minutes = 90) => {
    const chat = `01a16100-0000-7000-8000-00000000000${name}`;
    mkdirSync(join(home, ".prime", "agent", "sessions"), { recursive: true });
    writeFileSync(join(home, ".prime", "agent", "sessions", `${chat}.jsonl`), [user(0, TASK), ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const dir = join(home, "runs", name);
    mkdirSync(dir, { recursive: true });
    const state = { scenario: "answer-data", chat: { id: chat, name }, fixtures: {}, sandbox: home, everyMs: 0, release: "test", board: "", seeds: [TASK],
      setupAt: start, windowStart: start, until: start + 75 * 60_000 };
    const { verdict, text } = judge(dir, state, start + minutes * 60_000);
    const line = (id: string) => text.split("\n").find(entry => entry.startsWith(`- ${id} `)) ?? "";
    return { verdict, line };
  };

  assert.deepEqual(sentences("p90 is 4.1 min vs. 2.3 min.\n- one\n- two"), ["p90 is 4.1 min vs 2.3 min.", "one", "two"]);
  assert.equal(aggregateLead("Over 312 of your messages this week, the p90 wait for a first answer is 4.1 min."), true);
  assert.equal(aggregateLead("One chat took 40 min to answer you on Tuesday."), false);

  const good = await run("1", [tell(2, "Measuring now."),
    tell(20, "This week the p90 wait for a first answer was 4.1 min over 312 of your messages, up from 2.3 min over 280 the week before. Most of the rise sits on 10-21, when quota holds paused 6 chats.")]);
  assert.equal(good.verdict, "pass", ["a", "b", "c", "d"].map(good.line).join("\n"));

  const slop = await run("2", [tell(15, "Yes, it feels slower. For example, one chat took 40 minutes to answer you yesterday because its job sat on a hold, and several agents complain that the pool is slow.\n\n" +
    "- The pool is busy.\n- The token hook is flaky.\n- The daemon restarted twice.")]);
  assert.equal(slop.verdict, "fail");
  assert.match(slop.line("a"), /^- a not met.*5 sentences/);
  assert.match(slop.line("b"), /^- b not met/);
  assert.match(slop.line("c"), /^- c not met.*(?:For example|one chat).*complain/);
  assert.match(slop.line("d"), /^- d not met/);

  const thin = await run("3", [tell(18, "Over the last 7 days your median wait was 3.2 min across 41 messages. I have no earlier data to compare it with, so I can't say if that is slower.")]);
  assert.equal(thin.verdict, "pass", ["a", "b", "c", "d"].map(thin.line).join("\n"));
  const flat = await run("8", [tell(18, "Over the last 7 days your median wait was 3.2 min across 41 messages.")]);
  assert.equal(flat.verdict, "fail", "an answer to 'getting slower' with no baseline and no word that it is missing fails d");
  assert.match(flat.line("d"), /^- d not met/);

  const early = await run("4", [tell(2, "Measuring now.")], 10);
  assert.equal(early.verdict, "open");
  const held = await run("5", [], 80);
  assert.equal(held.verdict, "void", "a window with no model turn tested nothing");
  assert.match(held.line("f"), /^- f not met: no session of the chat took a model turn/);
  const quiet = { type: "message", timestamp: at(3), message: { role: "assistant", content: [{ type: "text", text: "Reading the session files." }] } };
  assert.equal((await run("7", [quiet], 80)).verdict, "fail", "a chat that worked but answered nothing by the window's end fails");

  const typed = await run("6", [user(5, "use the p90 please"), tell(8, "This week the p90 wait was 4.1 min over 312 messages, up from 2.3 min the week before.")]);
  assert.equal(typed.verdict, "void");
  assert.match(typed.line("e"), /^- e not met.*use the p90/);
});
