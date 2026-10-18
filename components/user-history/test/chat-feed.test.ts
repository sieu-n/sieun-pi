import assert from "node:assert/strict";
import { test } from "node:test";
import { chatFeed, chatLines, collapseUpdates, ownerMessageId, unreadCount, senderName, settledPending, splitReplyTo, turnStarter, updatesLabel, PENDING_SKEW_MS, type ChatItem, type ChatLine, type PendingSend } from "../src/shared/chat-feed.ts";
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

test("a stale-step nudge from another chat is a server note: its turn is not the owner's, and its sender is the asking chat", () => {
  const nudge = '[from Crawler VP] your step p46 "Build snapshot tables" has waited 3 h: what is left, and when?';
  const messages: ThreadMessage[] = [user(nudge, 1000), assistant([{ type: "text", text: "These are my notes. Nothing needs the owner." }], 1100)];
  assert.equal(turnStarter(messages), "agent");
  const lines = chatLines(messages);
  assert.deepEqual(kinds(lines), ["job", "notes"]);
  assert.equal(lines[0]?.kind === "job" ? lines[0].from : "", "Crawler VP");
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

test("two tell_owner calls in one turn are two agent lines, and a long reply shows whole (c97)", () => {
  const words = (count: number) => Array.from({ length: count }, (_, index) => `w${index + 1}`).join(" ");
  const lines = chatLines([user("status?", 1000), assistant([tell("t1", words(120)), tell("t2", "```mermaid\nflowchart LR\n  a --> b\n```")], 1100)]);
  assert.deepEqual(lines.flatMap(line => line.kind === "agent" ? [[line.text, line.told ?? false]] : []), [[words(120), true], ["```mermaid\nflowchart LR\n  a --> b\n```", true]]);
});

test("unreadCount: the chat's replies and folded update runs after the read marker count once each; the owner's own messages and older rows do not (owner 10-09)", () => {
  const user = (text: string, at: number): UserMessage => ({ role: "user", content: text, timestamp: at } as UserMessage);
  const reply = (text: string, at: number): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], timestamp: at, stopReason: "stop" } as unknown as AssistantMessage);
  const job = (from: string, text: string, at: number): CustomMessage => ({ role: "custom", customType: "agent_message", content: `[agent-message from ${from}]\n\n${text}`, display: true, timestamp: at } as unknown as CustomMessage);
  const messages: ThreadMessage[] = [user("go", 1), reply("on it", 2), user("and this", 10), reply("sure", 11), job("w1", "done", 12), job("w2", "done", 13), reply("both done", 14)];
  assert.equal(unreadCount(messages, 5), 2, "a reply, then one folded run (two job messages and the chat's notes on that agent turn)");
  assert.equal(unreadCount(messages, 14), 0);
  assert.equal(unreadCount(messages, 0), 3);
});

test("a long, structured job report stays folded in the updates line; the feed shows only owner messages and what the chat sends (owner 10-09)", () => {
  const long = "## Result\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n" + "Detail line. ".repeat(60);
  const items = chatFeed({ messages: [report("posthog key setup", long, 5)], streaming: null, wait: null } as never);
  assert.deepEqual(items.map(item => item.kind), ["updates"]);
});

test("reply_to: a text reply's marker line and tell_owner's reply_to quote an earlier owner message, which lists them for See reply; an unknown id is dropped", () => {
  const first = 1_760_000_000_000, second = first + 60_000;
  const id = ownerMessageId(first);
  assert.equal(id, "mgj6k3cw");
  const messages: ThreadMessage[] = [
    user("> the chat said this\n\nwhy is CI slow?", first),
    user("and the deploy?", second),
    assistant([{ type: "text", text: `reply_to: ${id}\n\nOne runner for all jobs.` }], second + 100),
    report("child:ci", "Two runners now.", second + 200),
    assistant([tell("t1", "CI has two runners now."), { type: "toolCall", id: "t2", name: "tell_owner", arguments: { text: "Deploy is green.", reply_to: "zzzz" } }], second + 300, "toolUse"),
    { role: "toolResult", toolCallId: "t1", toolName: "tell_owner", content: [{ type: "text", text: "told the owner" }], isError: false, timestamp: second + 310 },
    assistant([{ type: "toolCall", id: "t3", name: "tell_owner", arguments: { text: "Runner count doubled.", reply_to: id } }], second + 400, "toolUse"),
    assistant([{ type: "text", text: `reply_to: ${ownerMessageId(second)}\nNotes only.` }], second + 500),
  ];
  const lines = chatLines(messages);
  const quote = { id: "m0", text: "> the chat said this\n\nwhy is CI slow?" };
  assert.deepEqual(lines[2], { kind: "agent", id: "m2", text: "One runner for all jobs.", at: second + 100, replyTo: quote }, "the marker line is gone and the reply quotes the owner");
  assert.deepEqual(lines.filter(line => line.kind === "agent").map(line => [line.id, line.kind === "agent" ? line.replyTo?.id ?? null : null]),
    [["m2", "m0"], ["m4-t0", null], ["m4-t1", null], ["m6-t0", "m0"]], "tell_owner's reply_to links; no reply_to or an unknown id, no quote");
  assert.deepEqual(lines[0]?.kind === "user" ? lines[0].replies : null, ["m2", "m6-t0"], "the owner message lists its answers in order");
  assert.ok(lines[1]?.kind === "user" && lines[1].replies === undefined, "an unanswered owner message has no replies");
  assert.deepEqual(lines.at(-1), { kind: "notes", id: "m7", text: "Notes only.", at: second + 500 }, "a wake-up's notes lose the marker and link nothing");
});

test("reply_to: a streaming reply hides a marker line it is still writing, then quotes the owner message once the line is whole", () => {
  const at = 1_760_000_000_000;
  const messages: ThreadMessage[] = [user("why is CI slow?", at), user("ok?", at + 10)];
  const streamed = (text: string) => chatFeed({ messages, streaming: assistant([{ type: "text", text }], at + 20) }).at(-1);
  assert.equal(streamed("reply_t")?.kind, "user", "a partial marker shows nothing yet");
  assert.equal(streamed(`reply_to: ${ownerMessageId(at)}`)?.kind, "user", "a marker with no text yet shows nothing");
  const line = streamed(`reply_to: ${ownerMessageId(at)}\nOne runner.`);
  assert.deepEqual(line, { kind: "agent", id: "streaming", text: "One runner.", at: at + 20, streaming: true, replyTo: { id: "m0", text: "why is CI slow?" } });
  assert.equal(streamed("replying now")?.kind, "agent", "text that only starts like the marker shows");
  assert.deepEqual(splitReplyTo("reply_to: abc"), { replyTo: "abc", text: "" });
  assert.deepEqual(splitReplyTo("no marker\nreply_to: abc"), { replyTo: null, text: "no marker\nreply_to: abc" });
});

test("an owner turn answered with tell_owner shows the told text as the reply and the chat's own text as notes (W59, 04:33 KST 120-word reply)", () => {
  const told = (id: string, at: number): ThreadMessage => ({ role: "toolResult", toolCallId: id, toolName: "tell_owner", content: [{ type: "text", text: "told the owner" }], isError: false, timestamp: at });
  const messages: ThreadMessage[] = [
    user("Duties when are you going to add", 1000),
    assistant([{ type: "text", text: "Checking the duty runner first." }, call("c1")], 1100, "toolUse"),
    result("c1", 1150),
    assistant([tell("t1", "Duties land tonight; I started three jobs.")], 1200, "toolUse"),
    told("t1", 1210),
    assistant([{ type: "text", text: "Long notes on what each job does, the files, and the plan for the rest of the evening." }], 1300),
    user("ok", 2000),
    assistant([{ type: "text", text: "Thanks." }], 2100),
  ];
  const lines = chatLines(messages);
  assert.deepEqual(lines.map(line => `${line.kind} ${line.id}`), ["user m0", "notes m1", "agent m3-t0", "notes m5", "user m6", "agent m7"],
    "the turn with an accepted tell_owner: every text line in it is notes; the next owner turn with text only keeps its text as the reply");
  const refused: ThreadMessage[] = [user("status?", 1), assistant([tell("t2", "x")], 2, "toolUse"),
    { role: "toolResult", toolCallId: "t2", toolName: "tell_owner", content: [{ type: "text", text: "Refused" }], isError: true, timestamp: 3 },
    assistant([{ type: "text", text: "All green." }], 4)];
  assert.deepEqual(chatLines(refused).map(line => line.kind), ["user", "agent"], "a refused tell_owner does not count: the text stays the reply, so the owner never gets silence");
  const streaming = assistant([{ type: "text", text: "More detail while it streams" }], 1400);
  assert.deepEqual(kinds(chatFeed({ messages: messages.slice(0, 5), streaming })), ["user", "updates", "agent"],
    "text streaming after an accepted tell_owner on the same turn is not shown as a reply bubble");
  assert.deepEqual(kinds(chatFeed({ messages: messages.slice(0, 1), streaming })), ["user", "agent"], "an owner turn with no tell_owner yet still streams its reply");
});
