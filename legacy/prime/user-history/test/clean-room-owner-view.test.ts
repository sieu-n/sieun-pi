// Guards the c190 clean-room judge (owner 10-28 17:50Z: "왜 안보이냐고", after a chat called frontend bro fine without looking at his
// sidebar): an answer that opened his chat page and leads with what it shows passes, "it's fine" from the session list fails, and a typed
// turn voids the run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("owner-view: a look at his page before an answer that leads with what it shows passes, an unchecked 'it's fine' fails", async t => {
  const home = mkdtempSync(join(tmpdir(), "owner-view-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  const { judge, TASK } = await import("../scripts/clean-room/owner-view.ts");
  const start = Date.parse("2026-10-28T19:00:00.000Z");
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const user = (minutes: number, text: string) => ({ type: "message", timestamp: at(minutes), message: { role: "user", content: [{ type: "text", text }] } });
  const tool = (minutes: number, name: string, args: object) => ({ type: "message", timestamp: at(minutes), message: { role: "assistant", content: [{ type: "toolCall", id: `t${minutes}${name}`, name, arguments: args }] } });
  const tell = (minutes: number, text: string) => tool(minutes, "tell_owner", { text, why: "answer" });
  const run = async (name: string, entries: object[], minutes = 90) => {
    const chat = `01a18400-0000-7000-8000-00000000000${name}`;
    mkdirSync(join(home, ".prime", "agent", "sessions"), { recursive: true });
    writeFileSync(join(home, ".prime", "agent", "sessions", `${chat}.jsonl`), [user(0, TASK), ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const dir = join(home, "runs", name);
    mkdirSync(dir, { recursive: true });
    const state = { scenario: "owner-view", chat: { id: chat, name }, fixtures: {}, sandbox: home, everyMs: 0, release: "test", board: "", seeds: [TASK],
      setupAt: start, windowStart: start, until: start + 60 * 60_000 };
    const { verdict, text } = judge(dir, state, start + minutes * 60_000);
    const line = (id: string) => text.split("\n").find(entry => entry.startsWith(`- ${id} `)) ?? "";
    return { verdict, line };
  };

  const good = await run("1", [tool(1, "ipython", { code: "await aside_browser.open_tab(url); await aside_browser.screenshot('/tmp/side.png')" }),
    tell(3, "Your Chats list doesn't show it, because the Crawler VP started it, so it counts as agent-created and stays hidden until you turn on Show agent-created. It's live and working.")]);
  assert.equal(good.verdict, "pass", ["a", "b", "c", "d", "e"].map(good.line).join("\n"));

  const vp = await run("2", [tool(1, "ipython", { code: "prime-agent sessions --json" }),
    tell(2, "crawler ops train is fine. It's live on us-metal02 and still working on the crawler train.")]);
  assert.equal(vp.verdict, "fail");
  assert.match(vp.line("a"), /^- a not met: no call of the chat or its jobs opened his chat page/);
  assert.match(vp.line("b"), /^- b not met/);
  assert.match(vp.line("c"), /^- c not met.*calls it fine/);

  const late = await run("3", [tell(2, "It's agent-created, so your list hides it."), tool(4, "ipython", { code: "await aside_browser.open_tab(url)" })]);
  assert.equal(late.verdict, "fail", "a look after the answer does not count");
  assert.match(late.line("a"), /^- a not met/);

  assert.equal((await run("4", [tell(1, "Checking your list now.")], 10)).verdict, "open");
  assert.equal((await run("5", [], 70)).verdict, "void", "a window with no model turn tested nothing");
  assert.equal((await run("6", [tell(1, "Checking."), user(2, "did you look?")])).verdict, "void", "a typed turn is someone stepping in");
});
