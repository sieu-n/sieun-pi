// Guards the c150 clean-room judge (owner 10-21: "no frontend bro is responsible for making 5180 look good. i think it was mac-management can
// you check my actual request"): a chat that names an owner only after it asked for his words passes, one that names frontend bro from its
// parked integration step fails, and a typed turn voids the run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("task-owner: an owner named from his quoted request passes, one named from a parked step fails, a typed turn voids", async t => {
  const home = mkdtempSync(join(tmpdir(), "task-owner-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  const { judge, TASK, claims } = await import("./../scripts/clean-room/task-owner.ts");
  const start = Date.parse("2026-10-21T20:00:00.000Z");
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const user = (minutes: number, text: string) => ({ type: "message", timestamp: at(minutes), message: { role: "user", content: [{ type: "text", text }] } });
  const tell = (minutes: number, text: string) => ({ type: "message", timestamp: at(minutes), message: { role: "assistant", content: [{ type: "toolCall", id: `t${minutes}`, name: "tell_owner", arguments: { text, why: "answer" } }] } });
  const ask = (minutes: number, to: string, message: string) => ({ type: "message", timestamp: at(minutes), message: { role: "toolResult", content: [{ type: "text", text: "sent" }],
    details: { sentAgentMessages: [{ message, target: { sessionId: to, sessionName: "mac-management" } }] } } });
  const run = async (name: string, entries: object[], minutes = 60) => {
    const chat = `01a16000-0000-7000-8000-00000000000${name}`;
    mkdirSync(join(home, ".prime", "agent", "sessions"), { recursive: true });
    writeFileSync(join(home, ".prime", "agent", "sessions", `${chat}.jsonl`), [user(0, TASK), ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const dir = join(home, "runs", name);
    mkdirSync(dir, { recursive: true });
    const state = { scenario: "task-owner", chat: { id: chat, name }, fixtures: {}, sandbox: home, everyMs: 0, release: "test", board: "", seeds: [TASK],
      setupAt: start, windowStart: start, until: start + 45 * 60_000 };
    const { verdict, text } = judge(dir, state, start + minutes * 60_000);
    const line = (id: string) => text.split("\n").find(entry => entry.startsWith(`- ${id} `)) ?? "";
    return { verdict, line };
  };

  assert.deepEqual(claims("mac-management has the integration, not frontend bro."), ["mac-management has the integration"]);
  assert.deepEqual(claims("frontend bro is not the owner of the move."), []);
  assert.deepEqual(claims("It's not mac-management."), []);

  // run3 on 10-22 named its owner as "It's mac-management" with the owner's 10-19 message as its source, and the judge found no claim in it.
  const RUN3 = "It's mac-management, through its job \"5180 into the real app\" on p34, from your 10-19 message there (\"I APPROVE EVERYTHING, YOU TAKE OWNERSHIP, and ship it\"), and that job restarted at 10:57 KST today with one builder per page. None of the eight pages is in the app yet, only shared UI pieces, which is why 5174 still looks old, but its builders' unsaved edits in the repo were still changing at 11:22 KST, so it looks like they're working.";
  assert.deepEqual(claims(RUN3), ["It's mac-management"]);
  const read = { type: "message", timestamp: at(1), message: { role: "assistant", content: [{ type: "toolCall", id: "r1", name: "ipython",
    arguments: { code: "r=await bash('rg -l mvfdi289 /home/sieun/.prime/agent/sessions/01a15427-145f-751d-ba15-d27b6c30f65f.jsonl /home/sieun/.prime/agent/browser-chat/owner-messages')" } }] } };
  const quoted = await run("8", [read, tell(3, RUN3)]);
  assert.equal(quoted.verdict, "pass", [quoted.line("a"), quoted.line("b"), quoted.line("c")].join("\n"));
  assert.match(quoted.line("a"), /first ownership claim at .*It's mac-management/);

  const good = await run("1", [ask(3, "01a15427-145f-751d-ba15-d27b6c30f65f", "the owner asks who has moving 5180 into 5174. can you quote his original request that assigned it?"),
    tell(9, "mac-management owns moving the 5180 designs into 5174 and the real app. It quoted your message from 10-19 that gave it the integration; frontend bro owns how 5180 looks.")]);
  assert.equal(good.verdict, "pass", [good.line("a"), good.line("b"), good.line("c")].join("\n"));

  const stale = await run("2", [tell(4, "frontend bro owns moving the picked Staging versions into the real app: its board step p62 is parked until you say 5180 is good enough.")]);
  assert.equal(stale.verdict, "fail");
  assert.match(stale.line("a"), /^- a not met/);
  assert.match(stale.line("b"), /^- b not met.*frontend bro for the integration/);
  assert.match(stale.line("c"), /^- c not met/);

  const unsure = await run("3", [ask(2, "01a11ba8-9d2c-727c-8ded-38f819ca9f29", "can you quote the owner's message that gave you the 5180 integration, if any?"),
    tell(6, "Nobody has quoted your request yet, so the owner is not confirmed. I asked frontend bro and mac-management to quote it.")]);
  assert.equal(unsure.verdict, "pass", [unsure.line("a"), unsure.line("c")].join("\n"));

  const early = await run("4", [], 10);
  assert.equal(early.verdict, "open");
  const held = await run("5", [], 50);
  assert.equal(held.verdict, "void", "a window with no model turn, as in run2 on 10-22, tested nothing");
  assert.match(held.line("f"), /^- f not met: no session of the chat took a model turn/);
  const thought = { type: "message", timestamp: at(3), message: { role: "assistant", content: [{ type: "text", text: "Looking at the boards first." }] } };
  assert.equal((await run("7", [thought], 50)).verdict, "fail", "a chat that worked but told nothing by the window's end fails");

  const typed = await run("6", [user(5, "it was mac-management, check there"), tell(8, "mac-management owns it, as your message says.")]);
  assert.equal(typed.verdict, "void");
  assert.match(typed.line("e"), /^- e not met.*it was mac-management/);
});
