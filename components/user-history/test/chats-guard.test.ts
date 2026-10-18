import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import historyExtension from "../extension/index.ts";
import { CHAT_BRIEF } from "../src/chat-brief.ts";
import { chatModeAt, chatShellNote, hasChatMarker, judgeChatCode, tellOwner, withChatTool, withMessageIds } from "../src/chat-guard.ts";
import { reply } from "./chats-helpers.ts";

const ALLOWED = [
  "await bash('prime-agent stop readme-lines')",
  'h = bash("prime-agent send --from chat md-count \'slack-green\'")',
  "await bash(f'prime-agent send {job} done')",
  "print(1 + 1)\nagents = await agent_observe.list_agents()",
  'r = await agent_message.send("Owner says: slack-green", receiver_role="child", receiver_name="md-count")',
  "handle = await rlm.spawn(brief, name='readme lines')",
  'await rlm.create_session(brief, name="readme lines", cwd="/Users/sieunpark/Documents/Github/auto-sns-agent")',
  "handle = await rlm(brief, name='stripe and payments', thinking='max')",
  "name = topic.lower()\nhandle = await rlm.spawn(brief, name=name)",
  'await rlm.spawn(brief, name=f"{topic} check")',
  "await rlm.spawn(brief, name='land 25 restack')",
  "await rlm.spawn(brief, name='readme check' + '')",
  "text = open('/tmp/x.txt').read()",
  "with open(path, 'r', encoding='utf8') as f: data = f.read()",
  "brief = 'Never call bash(\"git status\") in this job; use edit( only in your repo'",
  "# bash('git status') is not what we do here\nx = 1",
  "await rlm.collect([h], timeout_ms=0)",
  "!prime-agent stop readme-lines",
  "await bash('git status')",
  "bash(command='ls -la')",
  "await bash('git log --oneline -5')",
  "await bash(\"rg -n 'chat_board|CHAT_BRIEF' src\")",
  "await bash('cat README.md')",
  "await bash(f'tail -50 {path}')",
  "await bash('ls')",
  "!git diff --stat",
  "await edit(path='a.py', old_str='x', new_str='y')",
  "open('/tmp/out.txt', 'w').write('x')",
  "await rlm.spawn(brief, name='readme-check')",
];
const NOTED: [string, RegExp][] = [
  ["await bash('git commit -m x')", /quick look-ups/],
  ["await bash('git push')", /quick look-ups/],
  ["await bash('npm test')", /quick look-ups/],
  ["await bash('lsof -i :5182')", /quick look-ups/],
  ["await bash('cat a.txt > b.txt')", /quick look-ups/],
  ["await bash('cat a | sh')", /quick look-ups/],
  ["await bash('ls; rm -rf x')", /quick look-ups/],
  ["await bash('git status && git commit -am x')", /quick look-ups/],
  ["await bash('cat $(echo x)')", /quick look-ups/],
  ["cmd = 'prime-agent stop x'\nawait bash(cmd)", /computed bash\(\) command/],
  ["await bash('prime-agentx')", /quick look-ups/],
  ["%%bash\nprime-agent stop x", /a shell cell/],
  ["!npm install", /a ! line/],
];

test("chat shell note: the decision table, only in a marked root; the call runs either way and the note goes on its result", () => {
  for (const code of ALLOWED) assert.equal(judgeChatCode(code), null, code);
  for (const [code, reason] of NOTED) assert.match(judgeChatCode(code) ?? "", reason, code);
  const at = (depth: number, marked: boolean, toolName: string, input: Record<string, unknown>) => chatShellNote({ toolName, input, depth, marked });
  assert.match(at(0, true, "ipython", { code: "await bash('git push')" }) ?? "", /^\[soft cap\] This ran/);
  assert.equal(at(1, true, "ipython", { code: "await bash('git push')" }), undefined, "a job under the chat is not guarded");
  assert.equal(at(0, false, "ipython", { code: "await bash('git push')" }), undefined, "an unmarked root is not guarded");
  assert.equal(at(0, true, "ipython", { code: "await bash('prime-agent send a b')" }), undefined);
  assert.equal(at(0, true, "bash", { command: "prime-agent stop a" }), undefined);
  assert.equal(at(0, true, "bash", { command: "git status" }), undefined);
  assert.match(at(0, true, "bash", { command: "git checkout main" }) ?? "", /the bash tool/);
  assert.equal(at(0, true, "edit", { path: "a" }), undefined);
  assert.equal(at(0, true, "read", { path: "a" }), undefined);
  assert.equal(at(0, true, "ipython", { code: 42 }), undefined, "a non-string cell is left to the tool");
});

test("chat marker: written once in a flagged root, read back later, never in a child; the brief tool follows it", () => {
  assert.deepEqual(chatModeAt({ depth: 0, flagged: true, marked: false }), { mark: true, active: true }, "first start of a new chat");
  assert.deepEqual(chatModeAt({ depth: 0, flagged: false, marked: true }), { mark: false, active: true }, "a re-create passes no flag; the entry holds");
  assert.deepEqual(chatModeAt({ depth: 0, flagged: true, marked: true }), { mark: false, active: true }, "the entry is not written twice");
  assert.deepEqual(chatModeAt({ depth: 0, flagged: false, marked: false }), { mark: false, active: false }, "a plain thread");
  assert.deepEqual(chatModeAt({ depth: 1, flagged: true, marked: false }), { mark: false, active: false }, "a child inherits the flag and gets nothing");
  assert.equal(hasChatMarker([{ type: "message" }, { type: "custom", customType: "chat_mode" }]), true);
  assert.equal(hasChatMarker([{ type: "custom_message", customType: "chat_mode" }]), false, "a custom message is not the entry");
  assert.deepEqual(withChatTool(["ipython", "chat_board", "tell_owner"], true), null, "already active");
  assert.deepEqual(withChatTool(["ipython"], true), ["ipython", "chat_board", "tell_owner"]);
  assert.deepEqual(withChatTool(["ipython", "chat_board"], true), ["ipython", "chat_board", "tell_owner"], "a chat that loaded the pre-tell_owner build gets the new tool on reload");
  assert.deepEqual(withChatTool(["ipython", "chat_board", "bash", "tell_owner"], false), ["ipython", "bash"], "a child drops the inherited tools");
  assert.deepEqual(withChatTool(["ipython"], false), null);
});

test("each message the owner typed gets its id after it, and no server note, wake, reply or tool result does; nothing else is added", () => {
  const image = { type: "image", data: "x", mimeType: "image/png" };
  const messages = [
    { role: "user", content: "why is CI slow?", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "One runner." }], timestamp: 2 },
    { role: "user", content: [{ type: "text", text: "[check-in] What changed:\n- nothing new" }], timestamp: 3 },
    { role: "user", content: [{ type: "text", text: "[job] build-x finished" }], timestamp: 4 },
    { role: "custom", customType: "agent_message", content: "[agent-message from worker]\n\nDone.", timestamp: 5 },
    { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }], timestamp: 6 },
    { role: "user", content: [{ type: "text", text: "[board] Owner checked \"x\" and answered: close them" }, image], timestamp: 7 },
  ];
  const view = withMessageIds(messages);
  const id = (text: string) => ({ type: "text", text: `[message id: ${text}]` });
  assert.deepEqual(view?.map(message => message.content), [
    [{ type: "text", text: "why is CI slow?" }, id("1")], messages[1]!.content, messages[2]!.content, messages[3]!.content, messages[4]!.content, messages[5]!.content,
    [{ type: "text", text: "[board] Owner checked \"x\" and answered: close them" }, image, id("7")],
  ]);
  assert.deepEqual(withMessageIds([{ role: "user", content: "hi", timestamp: 1760000000000 }])?.[0]?.content, [{ type: "text", text: "hi" }, id("mgj6k3cw")],
    "the id is the message's timestamp in base 36");
  assert.equal(withMessageIds([{ role: "user", content: "hi" }]), undefined, "no timestamp, no id");
  assert.equal(messages[0]!.content, "why is CI slow?", "the transcript is not changed");
  assert.equal(withMessageIds(messages.slice(1, 6)), undefined, "no owner message, no new view");
});

test("brief: a reply that answers an older owner message sets reply_to; one to the last message does not", async () => {
  const extension = await readFile(new URL("../extension/index.ts", import.meta.url), "utf8");
  assert.ok(extension.includes('reply_to: { type: "string", description: "[message id] of an older owner message it answers." }'), "tell_owner's reply_to says when to set it");
});

test("tell_owner sends any text that is not empty, long, labeled or with a diagram, and refuses only empty text (c97)", () => {
  assert.deepEqual(tellOwner("The audit is done; nothing failed."), { ok: true, text: "told the owner" });
  const long = `Update: ${Array.from({ length: 100 }, (_, index) => `word${index}`).join(" ")} \u2014 the digest and the duty.`;
  assert.deepEqual(tellOwner(long), { ok: true, text: "told the owner" }, "a label opener, a dash, internal terms and 100 words go through");
  assert.deepEqual(tellOwner("Here is the flow:\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n- one\n- two\n- three\n- four"), { ok: true, text: "told the owner" });
  assert.equal(tellOwner("   ").ok, false);
  assert.equal(tellOwner(undefined).ok, false);
});

test("brief: the owner hears from a chat only through tell_owner, which may run 2 or more times a turn and carry diagrams and length (c97)", async () => {
  const brief = CHAT_BRIEF.join("\n");
  assert.match(brief, /Reach the owner only through tell_owner, on every kind of turn/);
  assert.match(brief, /split a long answer into 2 or 3 calls, and put a mermaid diagram/);
  assert.doesNotMatch(brief, /reply cap|60 words/);
  const extension = await readFile(new URL("../extension/index.ts", import.meta.url), "utf8");
  assert.match(extension, /again in the same turn to send a second message/);
});

test("extension: a chat's git push runs (no block) and its result gets the soft-cap note; a look-up gets none", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "chat-shell-note-"));
  try {
    const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    const pi = { registerFlag() {}, registerCommand() {}, registerTool() {}, getActiveTools: () => [], setActiveTools() {}, appendEntry() {},
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      getFlag: (name: string) => name === "agent-chat-data-dir" ? dataDir : undefined };
    historyExtension(pi as never);
    const ctx = (depth: number) => ({ sessionManager: { getHeader: () => ({ type: "session", rlmDepth: depth }), getEntries: () => [{ type: "custom", customType: "chat_mode" }],
      getBranch: () => [], getSessionId: () => "chat-1", getSessionName: () => "dev VP", getSessionFile: () => undefined } });
    const run = async (name: string, event: unknown, depth = 0) => {
      let last: unknown; for (const handler of handlers.get(name) ?? []) last = await handler(event, ctx(depth)) ?? last; return last;
    };
    await run("session_start", {});
    const call = async (id: string, command: string) => {
      const blocked = await run("tool_call", { type: "tool_call", toolCallId: id, toolName: "bash", input: { command } });
      const result = await run("tool_result", { type: "tool_result", toolCallId: id, toolName: "bash", input: { command }, content: [{ type: "text", text: "ok" }], isError: false });
      return { blocked, result: result as { content: { text: string }[] } | undefined };
    };
    const push = await call("t1", "git push");
    assert.equal(push.blocked, undefined, "the push is not blocked");
    assert.equal(push.result?.content[0]?.text, "ok");
    assert.match(push.result?.content[1]?.text ?? "", /\[soft cap\] This ran, but the chat brief keeps a chat's own shell to quick look-ups/);
    const look = await call("t2", "git status");
    assert.equal(look.blocked, undefined);
    assert.equal(look.result, undefined, "a look-up gets no note");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
