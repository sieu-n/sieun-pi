// Guards the c18 clean-room judge (owner 10-22: "dry simple message."): one dry sentence with the detail written to the board passes, a
// long, formatted status message fails, a statement packed with a question is two points, the detail must reach the board or a wiki page, the
// chat's own check-in job is no one stepping in, a typed turn voids the run, and a window with no model turn is void. Run3's two real messages
// replay the two holes chat-2572 found in its pass: three owner decisions in one message, and step ids the judge never looked up. Run5's
// t61 message replays the third: two facts joined by "and" in one sentence.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("dry-message: one dry sentence with the detail on the board passes, a long status message fails, a typed turn voids", async t => {
  const home = mkdtempSync(join(tmpdir(), "dry-message-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  const { judge, TASK, sentences, faults, detailWrite, joinsFacts } = await import("./../scripts/clean-room/dry-message.ts");
  const start = Date.parse("2026-10-22T12:00:00.000Z");
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const user = (minutes: number, text: string) => ({ type: "message", timestamp: at(minutes), message: { role: "user", content: [{ type: "text", text }] } });
  const call = (minutes: number, name: string, args: object) => ({ type: "message", timestamp: at(minutes), message: { role: "assistant", content: [{ type: "toolCall", id: `c${minutes}${name}`, name, arguments: args }] } });
  const tell = (minutes: number, text: string) => call(minutes, "tell_owner", { text, why: "answer" });
  const board = (minutes: number) => call(minutes, "chat_board", { ops: [{ op: "plan_add", text: "Crawler status today", note: "reads 41,200 of 50,000; 3 accounts on login redirects" }] });
  const boardDir = join(home, ".prime", "agent", "browser-chat", "boards");
  const run = async (name: string, entries: object[], minutes = 90, boards: Record<string, object[]> = {}) => {
    const chat = `01a16400-0000-7000-8000-${name.padStart(12, "0")}`;
    rmSync(boardDir, { recursive: true, force: true });
    mkdirSync(boardDir, { recursive: true });
    for (const [id, plan] of Object.entries(boards)) writeFileSync(join(boardDir, `${id === "own" ? chat : id}.json`), JSON.stringify({ v: 2, rev: 1, plan, todos: [], updatedAt: at(0) }));
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

  const ownBoard = { own: [{ id: "p1", text: "Crawler reads on pace today", status: "doing", note: "reads 41,200 of 50,000; 3 accounts on login redirects", children: [] }] };
  const good = await run("1", [board(4), tell(5, "The crawler is on pace today, so nothing needs you, with the numbers in p1.")], 90, ownBoard);
  assert.equal(good.verdict, "pass", ["a", "b", "c", "d", "e"].map(good.line).join("\n"));

  // The c18 failure: a status message with several points, bullets, bold and the operational detail in chat.
  const slop = await run("2", [board(3), tell(6, "**Crawler status today:** mostly healthy, but a few things to flag.\n\n" +
    "- Reads are at 41,200 of the 50,000 daily target, about 82%, because 3 accounts hit login redirects this morning around 09:10 KST.\n" +
    "- The census lane is at 128 slots and the disk is at 71%.\n\nNothing urgent for you, but do you want me to raise the cap?")]);
  assert.equal(slop.verdict, "fail");
  assert.match(slop.line("a"), /^- a not met.*sentences.*paragraphs.*statement and a question/);
  assert.match(slop.line("b"), /^- b not met.*bullets.*bold/);

  const nowhere = await run("3", [tell(5, "The crawler is on pace today, so nothing needs you.")]);
  assert.equal(nowhere.verdict, "fail", "the detail never reached the board or a wiki page");
  assert.match(nowhere.line("c"), /^- c not met/);
  const pointed = await run("b", [tell(5, "The crawler is on pace today, so nothing needs you, with the numbers in p1.")], 90, ownBoard);
  assert.equal(pointed.verdict, "pass", "naming the board step that holds the rest puts the detail on the board");
  assert.match(pointed.line("c"), /^- c met.*names the board steps that hold the rest, p1 on board 01a16400/);
  const linked = await run("4", [tell(5, "The crawler is on pace today, so nothing needs you."), tell(6, "The breakdown is on wiki:ops/crawler-today.html for when you want it.")]);
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
  const own = await run("8", [board(4), tell(5, "The crawler is on pace today, so nothing needs you."), checkIn]);
  assert.equal(own.verdict, "pass", own.line("d"));
  const typed = await run("9", [user(5, "and the proxies?"), board(6), tell(8, "The proxies are fine.")]);
  assert.equal(typed.verdict, "void");
  assert.match(typed.line("d"), /^- d not met.*and the proxies/);

  // c18 run3 on 10-22: the chat read the Crawler VP board with board.open, sent these two messages, and was judged pass. The second asks for
  // three owner decisions (t92, t61, t62), and the first passes c only because p826 and p912 on that board hold its detail.
  const vp = "01a115e2-9544-7204-b8db-8ce4d5319048";
  const status = "The Instagram crawl runs at about 9,600 profiles a minute, short of the 10,000 goal (p826). The fixes that close that gap can't reach " +
    "prod until a Claude account frees up to ship them (p912).";
  const picks = "Answer t92 on the AI harness chat, because only 2 of 31 Claude accounts work and that blocks the crawler release. Two smaller picks " +
    "wait for you on the Crawler VP board, t61 on Meta ad images and t62 on the census fallback.";
  const p826 = { id: "p826", text: "Instagram profiles crawl at 10,000 a minute, held 6 h straight (owner 10-19, p1)", status: "doing", note: "Done when census holds " +
    "10,000 good a minute every hour for 6 h in a row, then it moves to the d9 duty. It first passed 10k at 19:55-20:10Z (about 12,000 a minute at 128 slots).", children: [] as object[] };
  const p912 = { id: "p912", text: "Ship the waiting crawler fixes to prod in a crawler-only release", status: "todo", note: "Done when prod crawler.virev.ai/health " +
    "serves a crawler-only release carrying the census race fix, the story fix, the image fixes and the TikTok exit reuse.", waitFor: "the AI harness VP's job " +
    "'smooth account queue' gives 'crawler only release' the next free Claude account slot; the owner has the capacity question on the AI harness chat's t92", children: [] };
  const read = call(1, "ipython", { code: `cv='${vp}'\no=board.open(chat=cv); print(o[:8000])` });
  assert.deepEqual(faults(status).size, []);
  assert.deepEqual(faults(picks).size, ["3 owner decisions or questions (t92, t61, t62)",
    'a sentence that joins two facts with "and" ("Answer t92 on the AI harness chat, because only 2 of 31 Claude accounts work an\u2026")']);
  assert.deepEqual(faults("Should we raise the cap? And keep the fallback?").size, ["2 owner decisions or questions"]);
  const run3 = await run("c", [read, tell(2, status), tell(2, picks)], 90, { [vp]: [{ ...p826, children: [p912] }] });
  assert.equal(run3.verdict, "fail");
  assert.match(run3.line("a"), /^- a not met.*3 owner decisions or questions \(t92, t61, t62\).*Answer t92/);
  assert.match(run3.line("c"), /^- c met.*p826 on board 01a115e2.*p912 on board 01a115e2/);
  const held3 = await run("d", [read, tell(2, status)], 90, { [vp]: [{ ...p826, children: [p912] }] });
  assert.equal(held3.verdict, "pass", ["a", "b", "c"].map(held3.line).join("\n"));
  const missing = await run("e", [read, tell(2, status)], 90, { [vp]: [p826] });
  assert.equal(missing.verdict, "fail", "a cited step the board does not hold puts no detail anywhere");
  assert.match(missing.line("c"), /^- c not met.*p912, a step on none of the 1 boards the chat read/);
  const unread = await run("f", [tell(2, status)], 90, { [vp]: [{ ...p826, children: [p912] }] });
  assert.match(unread.line("c"), /^- c not met.*p826, a step on none of the 0 boards/, "a step id alone, on no board the chat read, is no detail");
  const offTopic = await run("0", [read, tell(2, status)], 90, { [vp]: [p826, { id: "p912", text: "Rotate the TikTok residential exits", status: "todo",
    note: "Swap the 40 exits that GeoNode flagged on 10-21 for fresh ones from the Seoul pool.", children: [] }] });
  assert.equal(offTopic.verdict, "fail");
  assert.match(offTopic.line("c"), /^- c not met.*p912 on board 01a115e2 \("Rotate the TikTok residential exits"\) shares [01] topic words/);
  const thin = await run("10", [read, tell(2, status)], 90, { [vp]: [p826, { id: "p912", text: "Ship the fixes to prod once a Claude account frees up", status: "todo", children: [] }] });
  assert.match(thin.line("c"), /^- c not met.*p912 .* holds [0-4] words the message leaves out/, "a step that only repeats the sentence holds no detail");
  const early3 = await run("11", [read, tell(2, status)], 30, { [vp]: [p826] });
  assert.equal(early3.verdict, "open", "a cited step may still be written before the window ends");

  // c150 run4 on 10-22 answered in one long message: two sentences of 49 and 39 words.
  const run4 = await run("a", [board(1), tell(2, "mac-management has it, through its job 5180 into the real app (p34 on its board), which you gave it on 10-19 with \"YOU TAKE " +
    "OWNERSHIP, and ship it\" and asked about again today with \"why is 5174 like old version nothing changed?\". That job is running right now with one builder " +
    "per page, 2 of the 8 pages (watchlist and connections) are built but none is on staging or virev.ai yet, and it checks staging again at 12:40 KST.")]);
  assert.equal(run4.verdict, "fail");
  assert.match(run4.line("a"), /^- a not met.*a sentence of \d+ words/);

  // c18 run5 on 10-22 passed with its t61 message, whose second sentence joins two facts with "and"; c18 run4's first sentence did the same.
  const facts = ["They are about 70% of its work, and its queue keeps growing.",
    "Instagram census runs at about 8,900 profiles a minute against the 10k goal, and most crawler fixes are built but waiting on one prod release, p912.",
    "Instagram profiles crawl at about 8,955 a minute toward the 10k goal in p826, and most finished fixes are waiting on the crawler-only release p912.",
    "Census runs at 8,900 a minute and the fixes wait on p912.", "The crawler is fine and it's on pace."];
  for (const sentence of facts) assert.ok(joinsFacts(sentence), sentence);
  const one = ["Census runs at about 10,900 Instagram profiles a minute, above the 10k goal.",
    "Most other crawler fixes still wait on one prod release, p912, which has not shipped yet.", "Please answer t61, whether the image worker keeps saving Meta ad creatives.",
    "Please answer t62, whether census keeps its grid-page fallback.", "My pick is keep it, since without it about 1.3M reads a day end blocked.",
    "Two smaller picks wait for you on the Crawler VP board, t61 on Meta ad images and t62 on the census fallback.", "t61 and t62 wait on you.",
    "Census and the image worker are slow.", "Census runs at 10,900 a minute and still keeps its fallback.", "Search and Rescue runs fine today.",
    "Please answer t61 and t62, which are both small.", "2 of the 8 pages (watchlist and connections) are built."];
  for (const sentence of one) assert.ok(!joinsFacts(sentence), sentence);
  assert.deepEqual(faults("The crawler is on pace today and nothing needs you.").size, ['a sentence that joins two facts with "and" ("The crawler is on pace today and nothing needs you.")']);
  const run5 = [tell(2, "Census runs at about 10,900 Instagram profiles a minute, above the 10k goal. Most other crawler fixes still wait on one prod release, p912, which has not shipped yet."),
    tell(2, "Please answer t61, whether the image worker keeps saving Meta ad creatives. They are about 70% of its work, and its queue keeps growing."),
    tell(2, "Please answer t62, whether census keeps its grid-page fallback. My pick is keep it, since without it about 1.3M reads a day end blocked.")];
  const fifth = await run("12", [read, ...run5], 90, { [vp]: [{ ...p826, children: [p912] }] });
  assert.equal(fifth.verdict, "fail");
  assert.match(fifth.line("a"), /^- a not met: \S+ has a sentence that joins two facts with "and" \("They are about 70% of its work, and its queue keeps growing\."\)[^;]*$/);
  const fifthFixed = await run("13", [read, run5[0]!, tell(2, "Please answer t61, whether the image worker keeps saving Meta ad creatives. They are about 70% of its work."), run5[2]!], 90,
    { [vp]: [{ ...p826, children: [p912] }] });
  assert.equal(fifthFixed.verdict, "pass", ["a", "b", "c"].map(fifthFixed.line).join("\n"));
});
