import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CHAT_BRIEF } from "../src/chat-brief.ts";
import { TELL_OWNER_LIMIT } from "../src/chats.ts";
import { chatGuard, chatModeAt, hasChatMarker, judgeChatCode, REPLY_CAP_NOTE, tellOwner, withChatTool, withReplyCap } from "../src/chat-guard.ts";
import { lintOwnerReply } from "../src/shared/reply-lint.ts";
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
];
const BLOCKED: [string, RegExp][] = [
  ["await edit(path='a.py', old_str='x', new_str='y')", /edits no files/],
  ["open('/tmp/out.txt', 'w').write('x')", /writes no files/],
  ["with open(p, mode='a') as f: f.write(x)", /writes no files/],
  ["open(p, 'r+')", /writes no files/],
  ["Path(p).open('wb')", /writes no files/],
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
  ["await rlm.spawn(brief, name='readme-check')", /Name every job and thread like the owner names threads/],
  ["await rlm.create_session(brief, name='crawler_ops', cwd='/r')", /with no kebab-case, ids or numbered suffixes like -2\./],
  ["await rlm(brief, name='readme check 2')", /numbered suffixes/],
  ["await rlm.spawn(brief, name='readme check-2')", /numbered suffixes/],
  ["await rlm.spawn(brief, name='worker2')", /numbered suffixes/],
  ["await rlm.spawn(brief, name='w22-agents-card')", /numbered suffixes/],
  ["await rlm.spawn(brief, name='a thread name that goes on and on past forty')", /numbered suffixes/],
];

test("chat guard: the decision table, only in a marked root", () => {
  for (const code of ALLOWED) assert.equal(judgeChatCode(code), null, code);
  for (const [code, reason] of BLOCKED) assert.match(judgeChatCode(code) ?? "", reason, code);
  const at = (depth: number, marked: boolean, toolName: string, input: Record<string, unknown>) => chatGuard({ toolName, input, depth, marked });
  assert.equal(at(0, true, "ipython", { code: "await bash('git push')" })?.block, true);
  assert.equal(at(1, true, "ipython", { code: "await bash('git push')" }), undefined, "a job under the chat is not guarded");
  assert.equal(at(0, false, "ipython", { code: "await bash('git push')" }), undefined, "an unmarked root is not guarded");
  assert.equal(at(0, true, "ipython", { code: "await bash('prime-agent send a b')" }), undefined);
  assert.equal(at(0, true, "bash", { command: "prime-agent stop a" }), undefined);
  assert.equal(at(0, true, "bash", { command: "git status" }), undefined);
  assert.match(at(0, true, "bash", { command: "git checkout main" })?.reason ?? "", /the bash tool/);
  assert.match(at(0, true, "edit", { path: "a" })?.reason ?? "", /edits no files/);
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

test("the reply cap follows every message the owner typed, and no server note, wake, reply or tool result", () => {
  const cap = { type: "text", text: REPLY_CAP_NOTE };
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
  const view = withReplyCap(messages);
  const id = (text: string) => ({ type: "text", text: `[message id: ${text}]` });
  assert.deepEqual(view?.map(message => message.content), [
    [{ type: "text", text: "why is CI slow?" }, id("1"), cap], messages[1]!.content, messages[2]!.content, messages[3]!.content, messages[4]!.content, messages[5]!.content,
    [{ type: "text", text: "[board] Owner checked \"x\" and answered: close them" }, image, id("7"), cap],
  ]);
  assert.deepEqual(withReplyCap([{ role: "user", content: "hi", timestamp: 1760000000000 }])?.[0]?.content, [{ type: "text", text: "hi" }, id("mgj6k3cw"), cap],
    "the id is the message's timestamp in base 36");
  assert.deepEqual(withReplyCap([{ role: "user", content: "hi" }])?.[0]?.content, [{ type: "text", text: "hi" }, cap], "no timestamp, no id");
  assert.equal(messages[0]!.content, "why is CI slow?", "the transcript is not changed");
  assert.equal(withReplyCap(messages.slice(1, 6)), undefined, "no owner message, no new view");
  assert.match(REPLY_CAP_NOTE, /at most 60 words, bullets included/);
});

test("brief: a reply that answers an older owner message sets reply_to; one to the last message does not", async () => {
  const extension = await readFile(new URL("../extension/index.ts", import.meta.url), "utf8");
  assert.ok(extension.includes('reply_to: { type: "string", description: "[message id] of an older owner message it answers." }'), "tell_owner's reply_to says when to set it");
});

test("tell_owner takes up to the limit and refuses longer or empty text", () => {
  assert.deepEqual(tellOwner("The audit is done; nothing failed."), { ok: true, text: "told the owner" });
  assert.deepEqual(tellOwner("x".repeat(TELL_OWNER_LIMIT)), { ok: true, text: "told the owner" });
  assert.deepEqual(tellOwner("x".repeat(TELL_OWNER_LIMIT + 1)), { ok: false, text: "shorter: one or two sentences" });
  assert.equal(tellOwner("   ").ok, false);
  assert.equal(tellOwner(undefined).ok, false);
});

test("brief: a reply to the owner always goes through tell_owner, and every example sentence the brief and its owner reference tell chats to write passes the reply lint (W59)", async () => {
  const brief = CHAT_BRIEF.join("\n");
  assert.match(brief, /Reach the owner only through tell_owner, on every kind of turn/);
  assert.match(REPLY_CAP_NOTE, /Send the reply with tell_owner\./);
  const extension = await readFile(new URL("../extension/index.ts", import.meta.url), "utf8");
  assert.ok(!extension.includes("reply with text instead"), "tell_owner no longer tells the model to skip it on an owner turn");
  assert.match(extension, /The only text the owner reads/);
  const owner = await readFile(new URL("../../../skills/board/references/owner.md", import.meta.url), "utf8");
  const examples = [...`${brief}\n${owner}`.matchAll(/\blike "([^"]+)"/g)].map(match => match[1]!);
  assert.ok(examples.length >= 1, "the plural example is found");
  for (const example of examples) assert.deepEqual(lintOwnerReply(example), [], `the example "${example}" passes the lint a chat's reply must pass`);
  assert.ok(examples.includes("jobs now report to the chat when they finish"));
});
