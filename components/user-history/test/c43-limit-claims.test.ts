import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import historyExtension from "../extension/index.ts";
import { BoardStore } from "../src/chat-board-store.ts";
import { tellOwner } from "../src/chats.ts";
import { lintOwnerReply, boardLimitClaims } from "../src/shared/reply-lint.ts";

// The exact owner-facing lines the Crawler VP chat (01a115e2) sent on 10-12 before the owner repeated c43. Each one carried a limit no
// measurement backed. 129f66c refused only (2): (1) went out as a For you todo, which no lint read, and (3) passed because the reply said
// "disk busy about 2%" in another sentence and called the cap a caution limit.
/** (1) For you todo t28, added 13:23:48Z (22:23 KST); the owner answered it at 22:35. */
const TODO_T28 = "Each new Instagram profile writes about 1.7 MB to the server disk, which caps new profiles near 2,200 a minute. Keeping posts in " +
  "Postgres only for 1M+ follower accounts (ClickHouse keeps all posts) lifts it to about 5,400. Writing only to ClickHouse during the crawl, then " +
  "filling Postgres and search in a later pass, reaches about 20,000. [Details](http://localhost:5176/page/sessions/2026/10/12/2145-census-write-bytes/findings)";
/** (2) tell_owner at 20:09:45 KST; the owner answered "bro what the fuck? so 1 profile crawl is 40kb" at 20:20. */
const TOLD_2009 = "150 Mbps can't come from Instagram yet: above about 300 new profiles a minute, Instagram blocks a third of reads, which caps census " +
  "near 52 Mbps ([page](http://localhost:5176/page/sessions/2026/10/12/1939-crawler-tier-throughput-defaults/tier-defaults.html)). My plan is to " +
  "fill the rest with Meta Ads, TikTok Shop and YouTube, and raise Instagram step by step after the sticky-session fix.";
/** (3) tell_owner at 22:36:33 KST; the owner answered "r u fucking kidding?" at 22:37:00. */
const TOLD_2236 = "None of them yet. Today's limit is Instagram blocking new-profile reads. At 1,200 a minute the server was barely loaded: disk busy " +
  "about 2%, Postgres CPU 45%, connections half used. The 2,100 cap is metal's 75 MB/s disk-write line, a caution limit, not the drive being full. " +
  "I've asked metal what that line rests on.";

const unmeasured = (text: string): string[] => lintOwnerReply(text).filter(finding => finding.kind === "unmeasured").map(finding => finding.what);

test("c43 (Crawler VP 10-12 22:37): tell_owner refuses the 22:36 reply that named a caution line as the census cap", () => {
  assert.deepEqual(unmeasured(TOLD_2236), ['limit with no measurement "cap is metal\'s 75 MB/s disk-write line, a caution limit, no\u2026"']);
  assert.equal(tellOwner(TOLD_2236).ok, false);
  assert.equal(tellOwner(TOLD_2009).ok, false, "the 20:09 reply that 129f66c already refuses stays refused");
});

test("c43: a measurement counts only in the sentence that states the limit, and calling the line a caution line does not excuse it", () => {
  for (const reply of [
    "Disk was 2% busy. Census caps near 2,100/min because of metal's 75 MB/s line.",
    "Census reads cap near 2,100/min only because of a 75 MB/s caution line an earlier agent set; it is not measured, so I'm load testing the disk now.",
    "At 2% disk busy, census caps at 2,100/min, a safety line metal set at 75 MB/s.",
  ]) assert.equal(unmeasured(reply).length, 1, reply);
  for (const reply of [
    "The 75 MB/s line was never measured, so I dropped it, and census now runs at 2,100/min.",
    "Metal's 75 MB/s line isn't a real limit, since the NVMe sat 2% busy at 25 MB/s.",
    "The 300 a minute isn't a real limit.",
    "iostat showed the NVMe 98% busy at 2,100 profiles a minute, so disk is the cap.",
  ]) assert.deepEqual(unmeasured(reply), [], reply);
});

test("c43: a For you todo that states an unmeasured limit is refused; t28 is the 10-12 text the owner answered", () => {
  assert.deepEqual(boardLimitClaims([{ op: "todo_add", text: TODO_T28 }]), ['"caps new profiles near 2,200 a minute."']);
  assert.deepEqual(boardLimitClaims([{ op: "todo_update", id: "t28", text: TODO_T28 }]).length, 1);
  assert.deepEqual(boardLimitClaims([{ op: "todo_add", text: "OK to switch census to us-08 now?" }, { op: "scratch_add", text: TODO_T28 }]), [],
    "scratch notes record what others said");
});

test("c43: the chat_board tool refuses todo_add t28 and writes nothing; a plain todo goes on the board", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "c43-todo-"));
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>();
  const pi = { on() {}, registerFlag() {}, registerCommand() {}, registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); },
    getFlag: (name: string) => name === "agent-chat-data-dir" ? dataDir : undefined };
  historyExtension(pi as never);
  const board = tools.get("chat_board")!;
  const ctx = { sessionManager: { getSessionId: () => "s-c43" } };
  await assert.rejects(board.execute("c1", { ops: [{ op: "todo_add", text: TODO_T28, choices: ["Cut it", "Keep it"] }] }, undefined, undefined, ctx),
    /a todo or plan step states a limit with no evidence "caps new profiles near 2,200 a minute\."/);
  assert.equal(await new BoardStore(dataDir).read("s-c43"), null);
  const added = await board.execute("c2", { ops: [{ op: "todo_add", text: "OK to switch census to us-08 now?" }] }, undefined, undefined, ctx);
  assert.match(added.content[0]!.text, /^Added a todo t1/);
});
