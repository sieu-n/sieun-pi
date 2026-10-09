import assert from "node:assert/strict";
import { test } from "node:test";
import { chatFeed, chatLines, collapseUpdates, foldReply, isJobReport, REPORT_MIN_CHARS, REPLY_FOLD_WORDS, senderName, settledPending, turnStarter, updatesLabel, PENDING_SKEW_MS, type ChatItem, type ChatLine, type PendingSend } from "../src/shared/chat-feed.ts";
import type { AssistantMessage, CustomMessage, ThreadMessage, UserMessage } from "../src/shared/types.ts";

const user = (text: string, timestamp: number): UserMessage => ({ role: "user", content: text, timestamp });
const assistant = (parts: AssistantMessage["content"], timestamp: number, stopReason: AssistantMessage["stopReason"] = "stop", errorMessage?: string): AssistantMessage =>
  ({ role: "assistant", content: parts, provider: "p", model: "m", stopReason, timestamp, ...(errorMessage === undefined ? {} : { errorMessage }) });
const custom = (customType: string, content: string, timestamp: number): CustomMessage => ({ role: "custom", customType, content, timestamp });
const send = (id: string, text: string, at: number): PendingSend => ({ id, text, images: [], at });
const tell = (id: string, text: string): AssistantMessage["content"][number] => ({ type: "toolCall", id, name: "tell_owner", arguments: { text } });
const call = (id: string): AssistantMessage["content"][number] => ({ type: "toolCall", id, name: "ipython", arguments: {} });
const result = (toolCallId: string, timestamp: number): ThreadMessage => ({ role: "toolResult", toolCallId, toolName: "ipython", content: [{ type: "text", text: "ok" }], isError: false, timestamp });
const report = (from: string, text: string, timestamp: number) => custom("agent_message", `[agent-message from ${from}]\n${text}`, timestamp);
const kinds = (items: readonly (ChatItem | ChatLine)[]) => items.map(item => item.kind);

test("an owner turn shows the chat's text as bubbles, with interim text before a tool call too", () => {
  const messages: ThreadMessage[] = [
    user("start two jobs", 1000),
    assistant([{ type: "thinking", thinking: "plan" }, { type: "text", text: "One moment." }, call("c1")], 1100, "toolUse"),
    result("c1", 1200),
    assistant([{ type: "text", text: "Both started. I will tell you when they report." }], 1300),
    user("what is running?", 1600),
  ];
  const feed = chatFeed({ messages, streaming: null });
  assert.deepEqual(kinds(feed), ["user", "agent", "agent", "user"]);
  assert.deepEqual(feed.map(item => item.id), ["m0", "m1", "m3", "m4"]);
  assert.deepEqual(feed[1], { kind: "agent", id: "m1", text: "One moment.", at: 1100 });
  assert.equal(feed[0]?.kind === "user" ? feed[0].text : "", "start two jobs");
});

test("a turn another agent started hides the chat's text; only tell_owner reaches the feed, as an agent bubble", () => {
  const messages: ThreadMessage[] = [
    user("go", 1000),
    assistant([{ type: "text", text: "Started." }], 1100),
    report("child:readme-lines", "There is no README.md at the repo root.\nOnly AGENTS.md and CLAUDE.md.", 1400),
    assistant([{ type: "text", text: "Reading the report." }, call("c2")], 1500, "toolUse"),
    result("c2", 1510),
    assistant([{ type: "text", text: "I passed it on to the docs job." }], 1600),
    report("child:docs", "Done, README written.", 2000),
    assistant([tell("t1", "The README is written; both jobs are done."), call("c3")], 2100, "toolUse"),
    result("c3", 2110),
    assistant([{ type: "text", text: "Board updated." }], 2200),
  ];
  const lines = chatLines(messages);
  assert.deepEqual(kinds(lines), ["user", "agent", "job", "notes", "notes", "job", "agent", "notes"]);
  assert.deepEqual(lines[6], { kind: "agent", id: "m7-t0", text: "The README is written; both jobs are done.", at: 2100, told: true });
  const job = lines[2];
  assert.ok(job?.kind === "job");
  assert.deepEqual([job.from, job.title, job.body], ["readme-lines", "There is no README.md at the repo root.", "There is no README.md at the repo root.\nOnly AGENTS.md and CLAUDE.md."]);
  const feed = chatFeed({ messages, streaming: null });
  assert.deepEqual(kinds(feed), ["user", "agent", "updates", "agent", "updates"]);
  const updates = feed[2];
  assert.ok(updates?.kind === "updates");
  assert.deepEqual(updates.entries.map(entry => entry.id), ["m2", "m3", "m5", "m6"]);
  assert.deepEqual(updatesLabel(updates), { count: "4 updates", names: "readme-lines, docs" });
  assert.equal(updates.at, 1400);
  assert.equal(updates.id, "um2");
  const tail = feed[4];
  assert.ok(tail?.kind === "updates");
  assert.deepEqual(updatesLabel(tail), { count: "1 update", names: "" });
  const refused: ThreadMessage[] = [report("child:a", "x", 1), assistant([tell("t9", "way too long")], 2, "toolUse"),
    { role: "toolResult", toolCallId: "t9", toolName: "tell_owner", content: [{ type: "text", text: "shorter: one or two sentences" }], isError: true, timestamp: 3 },
    assistant([tell("t10", "Short.")], 4, "toolUse"), { role: "toolResult", toolCallId: "t10", toolName: "tell_owner", content: [{ type: "text", text: "told the owner" }], isError: false, timestamp: 5 }];
  assert.deepEqual(chatLines(refused).map(line => line.kind === "agent" ? line.text : line.kind), ["job", "Short."], "a refused tell_owner shows nothing");
});

test("a wake-up that lands mid-run joins the owner's turn, so the answer the owner waits for still shows", () => {
  const messages: ThreadMessage[] = [
    user("how far is the audit?", 1000),
    assistant([call("c1")], 1100, "toolUse"),
    report("child:audit", "Half done.", 1150),
    result("c1", 1200),
    assistant([{ type: "text", text: "Half done, the audit says." }], 1300),
  ];
  assert.deepEqual(kinds(chatFeed({ messages, streaming: null })), ["user", "updates", "agent"]);
  assert.equal(turnStarter(messages), "owner");
  assert.equal(turnStarter([...messages, custom("heartbeat_prompt", "[heartbeat: every 10m run#0]\nCheck-in.", 1400)]), "agent");
  assert.equal(turnStarter([...messages, custom("heartbeat_prompt", "[heartbeat: every 10m run#0]\nCheck-in.", 1400), user("[board] Owner chose \"Yes\" for \"Deploy?\"", 1500)]), "owner");
});

test("check-ins, job notices and background completions produce no line; errors, stops, restarts and compaction stay notices", () => {
  assert.deepEqual(chatLines([custom("heartbeat_prompt", "[heartbeat: every 10m run#0]\nCheck-in.", 1)]), []);
  assert.deepEqual(chatLines([custom("rlm_child_terminal_notice", "[child-exited: done child:w1]\nexited", 1)]), []);
  assert.deepEqual(chatLines([custom("async_bash_completion", "[async-bash exit:0]\nCommand: \"ls\"", 2)]), []);
  assert.deepEqual(chatLines([custom("system_note", "ignored", 1)]), []);
  assert.deepEqual(chatLines([custom("prime-agent.update_restart", "<restart>Prime Agent updated</restart>", 1)]), [{ kind: "notice", id: "m0", text: "Prime Agent restarted", at: 1 }]);
  assert.deepEqual(chatLines([{ role: "compactionSummary", summary: "s", tokensBefore: 10, timestamp: 3 }]), [{ kind: "notice", id: "m0", text: "Older messages were summarized to free space", at: 3 }]);
  assert.deepEqual(chatLines([assistant([{ type: "text", text: "" }], 7, "error", "Model request failed")]), [{ kind: "notice", id: "m0-error", text: "Error: Model request failed", at: 7 }]);
  assert.deepEqual(chatLines([assistant([{ type: "text", text: "Half an ans" }], 8, "aborted")]),
    [{ kind: "agent", id: "m0", text: "Half an ans", at: 8 }, { kind: "notice", id: "m0-stop", text: "Reply stopped", at: 8 }]);
  assert.deepEqual(chatLines([assistant([], 9, "error")]), [{ kind: "notice", id: "m0-error", text: "Error: the model returned an error", at: 9 }]);
  assert.deepEqual(chatLines([assistant([call("c1")], 1, "toolUse"), assistant([{ type: "text", text: "   " }], 1), result("c1", 1),
    { role: "bashExecution", command: "ls", output: "", cancelled: false, truncated: false, timestamp: 1 }, { role: "branchSummary", summary: "s", timestamp: 1 }]), []);
  const empty = chatLines([report("w1", "", 4)]);
  assert.ok(empty[0]?.kind === "job" && empty[0].title === "(empty message)" && empty[0].from === "w1");
});

test("sender names: a job by its name, a session by its catalog name, a raw id nobody lists as another thread", () => {
  const nameOf = (id: string) => id === "01a10810-34b5-710f-88fe-3d369f89a8c9" ? "sep-launch owner" : undefined;
  assert.equal(senderName("child:env-proxy-cutover"), "env-proxy-cutover");
  assert.equal(senderName("sibling:seo-todo"), "seo-todo");
  assert.equal(senderName("tidy instagram api"), "tidy instagram api");
  assert.equal(senderName("01a10810-34b5-710f-88fe-3d369f89a8c9", nameOf), "sep-launch owner");
  assert.equal(senderName("01a10810-34b5-710f-88fe-3d369f89a8c9"), "another thread");
  assert.equal(senderName("01a0cbc3-0000-7000-8000-000000000000", nameOf), "another thread");
  assert.equal(senderName(""), "another thread");
  const lines = chatLines([report("01a10810-34b5-710f-88fe-3d369f89a8c9", "State for your job.", 1)], nameOf);
  assert.equal(lines[0]?.kind === "job" ? lines[0].from : "", "sep-launch owner");
  const group = collapseUpdates([...lines, ...chatLines([report("child:a", "x", 2), report("b", "y", 3), report("child:a", "z", 4), report("c", "w", 5), report("d", "v", 6)])]);
  assert.ok(group[0]?.kind === "updates");
  assert.deepEqual(updatesLabel(group[0]), { count: "6 updates", names: "sep-launch owner, a, b and 2 more" });
  const long = collapseUpdates(chatLines([report("Look there are a bunch of prime agent threads in the sep launch", "x", 1)]));
  assert.ok(long[0]?.kind === "updates");
  assert.equal(updatesLabel(long[0]).names, "Look there are a bunch of prime\u2026", "a session titled by its first message is clipped on the line, whole in the reader");
});

test("a streaming reply is one agent line on an owner turn and nothing on an agent turn", () => {
  const messages: ThreadMessage[] = [user("hi", 1)];
  assert.deepEqual(kinds(chatFeed({ messages, streaming: assistant([{ type: "text", text: "" }], 2) })), ["user"]);
  const feed = chatFeed({ messages, streaming: assistant([{ type: "text", text: "Hel" }], 2) });
  assert.deepEqual(feed[1], { kind: "agent", id: "streaming", text: "Hel", at: 2, streaming: true });
  const stopped = chatFeed({ messages, streaming: assistant([{ type: "text", text: "Hel" }], 2, "aborted") });
  assert.equal(stopped.length, 2, "a streaming message never adds a notice; the committed message does");
  const quiet: ThreadMessage[] = [user("hi", 1), assistant([{ type: "text", text: "Hi." }], 2), report("w1", "Done.", 3)];
  assert.deepEqual(kinds(chatFeed({ messages: quiet, streaming: assistant([{ type: "text", text: "Reading" }, tell("t", "Done.")], 4) })), ["user", "agent", "updates"],
    "a tell_owner shows once the message commits");
});

test("a pending send shows as a pending user line until the thread echoes the same text after it", () => {
  const T = 10 * PENDING_SKEW_MS;
  const pending = [send("a", "ok", T + 5000), send("b", "ok", T + 6000)];
  const before = chatFeed({ messages: [user("ok", 1000)], streaming: null }, pending);
  assert.deepEqual(before.map(item => item.kind === "user" ? [item.id, item.pending ?? false] : null), [["m0", false], ["pa", true], ["pb", true]], "an older identical message does not settle a new send");
  const one = chatFeed({ messages: [user("ok", 1000), user("ok", T + 5100)], streaming: null }, pending);
  assert.deepEqual(one.map(item => item.id), ["m0", "m1", "pb"]);
  const both = chatFeed({ messages: [user("ok", 1000), user("ok", T + 5100), user("ok", T + 6100)], streaming: null }, pending);
  assert.deepEqual(both.map(item => item.id), ["m0", "m1", "m2"]);
  assert.deepEqual([...settledPending([user("ok", 5000 - PENDING_SKEW_MS)], [send("a", "ok", 5000)])], ["a"], "a daemon clock a little behind the phone still settles the send");
  assert.deepEqual([...settledPending([user("other", 5100)], [send("a", "ok", 5000)])], []);
});

test("a job message the snapshot clipped names where its full text is", () => {
  const clipped: CustomMessage = { role: "custom", customType: "agent_message", content: [{ type: "text", text: "[agent-message from w10]\nLong report", truncated: true }], timestamp: 1 };
  assert.deepEqual(chatLines([user("x", 0), clipped]).at(-1), { kind: "job", id: "m1", from: "w10", title: "Long report", body: "Long report", at: 1, clipped: { message: 1, part: 0 } });
  assert.equal("clipped" in chatLines([report("w10", "Short", 1)])[0]!, false);
});

test("a chat_board call that changed the chat's own check-in shows its first result line as a notice; a refused one shows nothing", () => {
  const board = (id: string): AssistantMessage["content"][number] => ({ type: "toolCall", id, name: "chat_board", arguments: { check_in: { pause: "1h" } } });
  const boardResult = (toolCallId: string, text: string, isError: boolean, timestamp: number): ThreadMessage =>
    ({ role: "toolResult", toolCallId, toolName: "chat_board", content: [{ type: "text", text }], isError, timestamp });
  const messages: ThreadMessage[] = [
    custom("agent_message", "[agent-message from child:docs]\nDone.", 1000),
    assistant([board("b1")], 1100, "toolUse"),
    boardResult("b1", "The chat set its check-in: paused until 2026-10-08 15:03\nPlan:\n- p1 Goal [doing]", false, 1110),
    assistant([board("b2")], 1200, "toolUse"),
    boardResult("b2", "check_in refused: the owner paused check-ins until they resume them; that stays", true, 1210),
  ];
  const notices = chatLines(messages).filter(line => line.kind === "notice");
  assert.deepEqual(notices, [{ kind: "notice", id: "m1-c0", text: "The chat set its check-in: paused until 2026-10-08 15:03", at: 1100 }]);
});

test("an owner-turn reply over 60 words folds after its 60th word; fences are not words and are never cut; tell_owner lines are marked", () => {
  const words = (count: number, from = 1) => Array.from({ length: count }, (_, index) => `w${from + index}`).join(" ");
  assert.equal(REPLY_FOLD_WORDS, 60);
  assert.deepEqual(foldReply(words(60)), { shown: words(60), folded: false }, "60 words stay whole");
  assert.deepEqual(foldReply(words(61)), { shown: `${words(60)}…`, folded: true });
  assert.deepEqual(foldReply(`- ${words(30)}\n- ${words(40, 31)}`), { shown: `- ${words(30)}\n- ${words(30, 31)}…`, folded: true }, "list marks are no words");
  const diagram = "```mermaid\nflowchart LR\n" + "  a --> b\n".repeat(80) + "```\n";
  assert.deepEqual(foldReply(`${words(20)}\n${diagram}${words(20, 21)}`).folded, false, "a diagram is not words");
  const long = `${words(50)}\n${diagram}${words(30, 51)}`;
  assert.deepEqual(foldReply(long), { shown: `${words(50)}\n${diagram}${words(10, 51)}…`, folded: true }, "the cut lands after the fence, in prose");
  assert.deepEqual(foldReply(`${words(59)} last, ${words(5, 61)}`), { shown: `${words(59)} last…`, folded: true }, "no trailing comma before the mark");
  const lines = chatLines([user("status?", 1000), assistant([{ type: "text", text: words(80) }, tell("t9", "Short note.")], 1100)]);
  assert.deepEqual(lines.slice(1).map(line => line.kind === "agent" ? [line.text.length > 20, line.told ?? false] : []), [[true, false], [false, true]], "the fold applies to the reply, not to tell_owner");
});

test("isJobReport: a long or structured message from one of the chat's own jobs shows open in the feed; pings, other threads and the chat's notes stay folded (owner 10-09)", () => {
  const jobs = new Set(["w31 board convergence"]);
  const job = (from: string, body: string) => ({ kind: "job" as const, id: "m1", from, title: body.split("\n")[0]!, body, at: 1 });
  const long = "Done. " + "The classifier now covers every open step. ".repeat(10);
  assert.ok(long.length >= REPORT_MIN_CHARS);
  assert.equal(isJobReport(job("w31 board convergence", long), jobs), true);
  assert.equal(isJobReport(job("w31 board convergence", "## Result\n\n| chat | orphan |\n|---|---|\n| VP | 0 |\n| CI | 0 |"), jobs), true, "a short table is a report");
  assert.equal(isJobReport(job("w31 board convergence", "Starting now."), jobs), false, "a ping stays folded");
  assert.equal(isJobReport(job("VP of CI", long), jobs), false, "a sibling thread is not this chat's job");
  assert.equal(isJobReport({ kind: "notes", id: "m2", text: long, at: 1 } as never, jobs), false);
});
