import assert from "node:assert/strict";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord, checkInSettings, clockTime, localTime, OWNER_UI } from "../src/chat-checkin.ts";
import type { Ledger } from "../src/chat-corrections.ts";
import { BRIEF_CHECK_MAX_AGE_MS, briefCheckRecord, CHAT_BRIEF, Chats, chatGuard, type ChatThreads, chatModeAt, type CheckInSource, createSessionNames, extensionBuild, fileHasChatMarker, hasChatMarker, jobNameLiterals, jobOf, jobRegistry,
  jobPersonaGuideline, jobReplyGuideline, judgeChatCode, loadRecord, OLD_CHECK_IN, reloadAction, REPLY_CAP_NOTE, REPLY_CHECK_MAX_AGE_MS, replyCheckRecord, TELL_OWNER_LIMIT, tellOwner, type ThreadView, topSession, withChatTool, withReplyCap } from "../src/chats.ts";
import { SessionManager } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { inSidebar } from "../src/client/organize.ts";
import { AttachQueue, ThreadHub } from "../src/chat-threads.ts";
import { isThreadBusy, isTurnRunning } from "../src/shared/thread-state.ts";
import { type CheckInRun, Duties } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatAgent, ChatBoard, ChatWait, ChildAgent, ModelInfo, SessionRow, ThreadMessage, ThreadState } from "../src/shared/types.ts";
import { fileOrigin, ThreadOrigins } from "../src/thread-origin.ts";
import { lintOwnerReply } from "../src/shared/reply-lint.ts";
import { MERGE_RULE_SHORT } from "../src/shared/chat-board.ts";

// Notice times are the owner's local HH:MM; the expected strings are written for Seoul.
process.env.TZ = "Asia/Seoul";

test("id index: add puts the newest first once, forget removes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  assert.deepEqual(await index.ids(), []);
  await index.add("a");
  await index.add("b");
  await index.add("a");
  assert.deepEqual(await index.ids(), ["b", "a"]);
  await index.forget("b");
  await index.forget("zzz");
  assert.deepEqual(await index.ids(), ["a"]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "chats.json"), "utf8")), { ids: ["a"] });
});

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

const child = (status: ChildAgent["status"]): ChildAgent => ({ id: status, label: status, status });

/** The board skill and its references, which the brief points to for the rules of one kind of action. */
const boardSkill = async (file: string): Promise<string> => readFile(new URL(`../../../skills/board/${file}`, import.meta.url), "utf8");
const SKILL_FILES = ["SKILL.md", "references/jobs.md", "references/check-ins.md", "references/git.md", "references/owner.md", "references/corrections.md"];

test("brief: the core rules stay in the prompt in one short line each, and the brief points to every board skill file", async () => {
  const brief = CHAT_BRIEF.join("\n");
  assert.equal(CHAT_BRIEF[1], "Mark a step done or a feature live only from the real state you checked (a feature on the real screen), and say what you checked.",
    "live means seen, the item after the first");
  assert.ok(CHAT_BRIEF.includes("Name every job and thread like the owner names threads: a few plain lowercase words naming the topic (stripe and payments), with no " +
    "kebab-case, ids or numbered suffixes like -2."), "the naming line, verbatim");
  assert.match(brief, /Your one goal is to drive every board item to done\. Every open step names its owner \(a job, or a thread as `thread:<id>`\) and its next action, or is blocked with the exact thing that unblocks it\. A step waiting on someone else is still yours: chase a stuck owner once, then replace it with a job\./);
  assert.match(brief, /Reach the owner only through tell_owner, on every kind of turn, within the \[reply cap\]\./);
  assert.match(brief, /On a wake-up the owner did not start, call it once when a goal finished, something is blocked or you need a decision, with several updates in one call; never write 'nothing needs you', 'already handled' or a relay line\./);
  assert.match(brief, /A brief, in English, opens with `Owner's words \(verbatim\):` and the 1 or 2 owner messages that started it, numbered, timed and exact \(or `Owner's words: none, started by <who>`\), then `My read:`, a `Split:` line/);
  assert.match(brief, /End state: every open step is done, moved by a live owner \(a job at work, or a thread active in the last 2 h\), or blocked only by an open For you todo\./);
  assert.match(brief, /Never ask the owner to relay a message to another thread\./);
  assert.match(brief, /Delete heartbeats and watcher loops the check-in already covers\./);
  assert.match(brief, /anthropic\/claude-opus-5-5", thinking=\\?"high\\?"\)`, the model of this chat and every job unless the owner says otherwise \(c31\)/);
  assert.match(brief, /Act directly and ship; invent no waiting rules, review rounds or safety gates unless the owner asks for caution \(c47\)\./);
  assert.match(brief, /Nothing goes outside \(an email, a ticket or support reply, a customer message, a post\) until the owner approves the draft on a For you todo \(c37\)\./);
  assert.match(brief, /record it with `correction_add` in the same turn\./);
  assert.doesNotMatch(brief, /—/, "no em dashes");
  assert.ok(!/board convergence/i.test(brief), "no separate Board convergence duty: the check-in owns board convergence (correction c15)");
  for (const file of SKILL_FILES) {
    assert.ok(brief.includes(file === "SKILL.md" ? "SKILL.md before a board write" : file), `the brief points to ${file}`);
    assert.ok((await boardSkill(file)).length > 0, file);
  }
});

test("brief: every rule that left the prompt sits in the board skill file the brief points to, once", async () => {
  const brief = CHAT_BRIEF.join("\n");
  const homes: [string, string, string][] = [
    ["SKILL.md", "Every goal gets its phases as child steps from the start: Plan (research or design), Decide (only when the owner must choose), Build and Verify.", "board shape"],
    ["SKILL.md", "including blocked steps nobody works on yet", "blocked steps show"],
    ["SKILL.md", "Link a job on the step it does, not on the goal.", "jobs on steps"],
    ["SKILL.md", "Plan (doing, job messenger-bridge-research), Decide (blocked), Build (blocked), Verify (todo)", "the board shape example"],
    ["SKILL.md", "A goal that is a feature of one app goes under that app's goal as a child, not as a new top-level goal.", "app features nest"],
    ["SKILL.md", "give it a new waitUntil, the job's result, done or dropped in that turn", "plan upkeep (c44)"],
    ["SKILL.md", "fold the goal in the same turn (c46)", "fold a goal (c46)"],
    ["SKILL.md", "remove it with plan_remove and add one scratch note naming its new owner", "hand-off (c8)"],
    ["SKILL.md", "does not stay open (c45)", "a goal that only waits closes (c45)"],
    ["SKILL.md", "Send a job only its own plan item, never the whole board.", "a job gets its own item"],
    ["SKILL.md", "no all-caps labels (SECURITY:, URGENT:), no slash-joined names, and no repo jargon (origin/main, xoxb, HEAD)", "plain board notes"],
    ["SKILL.md", "A go said in chat does not count", "the go gate"],
    ["SKILL.md", "Push the step that closes the largest gap, because waiting steps are not progress (c23).", "goal targets drive the check-in"],
    ["references/jobs.md", "cut only with \"...\" between exact pieces", "brief quotes"],
    ["references/jobs.md", "`receiver_role=\"sibling\", receiver_name=<your session name>`", "root reply line"],
    ["references/jobs.md", "translate any Korean (c2)", "relays in English"],
    ["references/jobs.md", "never one context writing 10 articles", "one subagent per output"],
    ["references/jobs.md", "Work of 1 to 3 tool calls stays inline", "inline small work"],
    ["references/jobs.md", "never start a \"-2\" or \"finish\" copy of it", "steer a live job"],
    ["references/jobs.md", "`[job] <name> ended at <time> with no report` or `[job] <name> stopped ... and sent no report` means", "silent job ends"],
    ["references/jobs.md", "`[job] <name> is waiting for you since <time>` means the job waits on you", "waiting jobs"],
    ["references/jobs.md", "delete the job with `await rlm.delete_subagent(name)` unless a step keeps it waiting on purpose", "delete finished jobs"],
    ["references/jobs.md", "`node apps/llm-wiki/scripts/prose-lint.mjs <page>` pass", "wiki pages (c20)"],
    ["references/check-ins.md", "named like `check-in 14:00`, with the precheck as context", "duty jobs"],
    ["references/check-ins.md", "like \"Chat system\" or \"Skills and harness\"", "duty names"],
    ["references/check-ins.md", "the server refuses size metrics (c39)", "duty metrics"],
    ["references/git.md", "rebase, amend) before a push needs no owner ask (c21)", "unpushed sieun-pi commits"],
    ["references/git.md", "run `git add -- <your files>` on the shared index afterwards", "private index commits"],
    ["references/owner.md", "ask yourself whether the CTO would be annoyed to be asked", "few asks"],
    ["references/owner.md", "one screenshot per variant inline in the chat message itself", "UI picks inline (c3)"],
    ["references/owner.md", "complete the Google or GitHub sign-in there", "logins through Aside (c4)"],
    ["references/owner.md", "If the owner says talk first, reply with your proposal and the default you start at your next wake-up", "talk first"],
    ["references/owner.md", "like [secrets walkthrough](job:secrets walkthrough)", "job links"],
    ["references/owner.md", "mermaid diagrams", "images and diagrams"],
    ["references/corrections.md", "receiver_role=\"sibling\", receiver_name=\"realtime layer\"", "corrections change the brief"],
    ["references/corrections.md", "await refine.run()", "corrections change a skill"],
    ["references/corrections.md", "pass `handoff: {to, topics, with?}`", "correction handoff"],
    ["references/jobs.md", "sends `[brief check]` when one breaks these rules; fix it in the job with a message", "brief check"],
    ["SKILL.md", "Give 2 to 4 short choices, your recommendation first.", "todo choices"],
  ];
  const texts = new Map(await Promise.all(SKILL_FILES.map(async file => [file, await boardSkill(file)] as const)));
  for (const [file, phrase, why] of homes) {
    assert.ok(texts.get(file)!.includes(phrase), `${why}: in ${file}`);
    assert.ok(!brief.includes(phrase), `${why}: not repeated in the brief`);
    assert.deepEqual(SKILL_FILES.filter(other => texts.get(other)!.includes(phrase)), [file], `${why}: in one file`);
  }
});

test("job reply: a direct subagent of a chat and a root the chat started get the guideline; nothing else does", async () => {
  assert.deepEqual(jobOf({ depth: 1, marked: false, parentChat: "chat-ab12" }), { chat: "chat-ab12", root: false });
  assert.deepEqual(jobOf({ depth: 1, marked: false, parentChat: "" }), { chat: "", root: false }, "a chat with no name still gets the guideline");
  assert.equal(jobOf({ depth: 1, marked: false, parentChat: null }), null, "the parent is a plain thread");
  assert.equal(jobOf({ depth: 2, marked: false, parentChat: "chat-ab12" }), null, "a job's own subagent reports to the job");
  assert.deepEqual(jobOf({ depth: 0, marked: false, registered: "Feature X" }), { chat: "Feature X", root: true });
  assert.equal(jobOf({ depth: 0, marked: true, registered: "Feature X" }), null, "a chat is never a job");
  assert.equal(jobOf({ depth: 0, marked: false, registered: undefined }), null);
  assert.equal(jobReplyGuideline({ chat: "chat-ab12", root: false }), 'You are a job of the chat chat-ab12. When you finish, fail or get blocked, send your report ' +
    `first with \`await agent_message.send(report, receiver_role="parent")\`, and lead it with the answer. ${MERGE_RULE_SHORT} No cap, throttle, timeout, rate or caution line without a measurement, a vendor limit or an incident cited next to the number; remove unbacked ones.`);
  assert.ok(CHAT_BRIEF.join(" ").includes("Add no cap, throttle, timeout, rate or 'caution line' unless a measurement, a vendor limit or an incident backs it"), "no unbacked limits (owner 10-12, c43)");
  assert.match(jobReplyGuideline({ chat: "Feature X", root: true }), /receiver_role="sibling", receiver_name="Feature X"/);
  assert.match(jobReplyGuideline({ chat: "", root: false }), /^You are a job of the chat\. /);

  assert.deepEqual(createSessionNames('await rlm.create_session(brief, name="api-audit", cwd="/repo")'), ["api-audit"]);
  assert.deepEqual(createSessionNames("h = await rlm.create_session(f'Owner said {x}', cwd=c, name='w2')\nawait rlm.create_session(b, name=n)"), ["w2"], "a computed name is not found");
  assert.deepEqual(createSessionNames("brief = 'call rlm.create_session(b, name=\"x\")'\nawait rlm.spawn(brief, name='y')"), [], "a call inside a string and a spawn are not roots");
  assert.deepEqual(createSessionNames('await rlm.create_session(b, cwd=c, name=f"job-{n}")'), [], "an f-string with a field is computed");
  assert.deepEqual(createSessionNames('await rlm.create_session(b + "receiver_name=\'z\'", name="ok")'), ["ok"]);

  const dir = await mkdtemp(join(tmpdir(), "jobs-"));
  let now = 1_000;
  const registry = jobRegistry(join(dir, "chat-jobs.json"), () => now);
  await registry.add(["old"], "chat-a");
  now += 31 * 24 * 60 * 60_000;
  await registry.add(["api-audit"], "chat-b");
  assert.equal(await registry.chatOf("api-audit"), "chat-b");
  assert.equal(await registry.chatOf("old"), undefined, "entries older than 30 days go on the next add");
  assert.equal(await registry.chatOf("nobody"), undefined);
  await registry.add(["seo daily"], "chat-b");
  assert.deepEqual(await registry.rootsOf(["01a1-b", "chat-b"]), ["api-audit", "seo daily"], "the roots a chat started, by any of its names");
  assert.deepEqual(await registry.rootsOf(["chat-a"]), []);
  assert.deepEqual(jobNameLiterals("h = await rlm(b, name='readme check')\nawait rlm.spawn(b, name=\"x-y\")\nawait rlm.create_session(b, name='r', cwd=c)"),
    [{ call: "rlm", name: "readme check" }, { call: "rlm.spawn", name: "x-y" }, { call: "rlm.create_session", name: "r" }]);

  const lines = (entries: object[]) => entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  const chatFile = join(dir, "chat.jsonl");
  const plainFile = join(dir, "plain.jsonl");
  await writeFile(chatFile, lines([{ type: "session", id: "c" }, { type: "session_info", id: "i", name: "chat-ab12" }, { type: "session_state", id: "s" },
    { type: "custom", customType: "chat_mode", data: { v: 1 } }, { type: "session_info", id: "j", name: "renamed later" }]));
  await writeFile(plainFile, lines([{ type: "session", id: "p" }, { type: "session_info", id: "i", name: "plain" }]));
  assert.deepEqual(await topSession(chatFile), { id: "c", name: "chat-ab12", chat: true });
  assert.deepEqual(await topSession(plainFile), { id: "p", name: "plain", chat: false });
  assert.equal(await topSession(join(dir, "missing.jsonl")), null);
  const jobFile = join(dir, "job.jsonl");
  const helperFile = join(dir, "helper.jsonl");
  await writeFile(jobFile, lines([{ type: "session", id: "j", parentSession: chatFile, rlmDepth: 1 }, { type: "session_info", id: "i", name: "job" }]));
  await writeFile(helperFile, lines([{ type: "session", id: "h", parentSession: jobFile, rlmDepth: 2 }]));
  assert.deepEqual(await topSession(helperFile), { id: "c", name: "chat-ab12", chat: true }, "a job's own subagent finds the chat at the top");
  await writeFile(join(dir, "orphan.jsonl"), lines([{ type: "session", id: "o", parentSession: join(dir, "missing.jsonl") }]));
  assert.equal(await topSession(join(dir, "orphan.jsonl")), null);
});

type Observer = Parameters<ChatThreads["observe"]>[0];
/** A check-in source with no timer: an empty board unless one is given, no catalog rows, and its memory in `dir`. */
function source(dir: string, boards: Record<string, ChatBoard> = {}, now = () => 0, rows: () => SessionRow[] = () => []): CheckInSource {
  return { board: async id => boards[id] ?? null, rows: async () => rows(), memory: checkInRecord(join(dir, "check-ins.json")),
    replyChecks: replyCheckRecord(join(dir, "reply-checks.json")), settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now, noReportGraceMs: 0 };
}
function fakeThreads(calls: string[], pinLimit = 8) {
  let observer: Observer | undefined;
  let next = 1;
  const pinned = new Set<string>();
  const busyIds = new Set<string>();
  /** Threads with input queued and nothing running: `busy` but not `running`. */
  const queuedIds = new Set<string>();
  const transcripts = new Map<string, ThreadMessage[]>();
  return {
    pinned,
    busyIds,
    queuedIds,
    transcripts,
    /** Info, queue and retry the hub would hold next to the transcript. */
    extras: new Map<string, Omit<ThreadView, "messages">>(),
    state(id: string): ThreadView | undefined { const messages = transcripts.get(id); return messages ? { messages, ...this.extras.get(id) } : undefined; },
    async restart(id: string, message: string, abort?: boolean) { calls.push(`restart ${id} ${message}${abort ? " (abort)" : ""}`); },
    async abort(id: string) { calls.push(`abort ${id}`); },
    async resumeQueue(id: string) { calls.push(`resume ${id}`); },
    async deleteSubagent(id: string, childId: string) { calls.push(`delete ${id} ${childId}`); },
    async unarchive(id: string) { calls.push(`unarchive ${id}`); },
    async archive(id: string) { calls.push(`archive ${id}`); },
    catalog: { models: [] as ModelInfo[], configuredProviders: [] as string[] },
    async models(_id: string) { return { ...this.catalog, current: null, thinkingLevel: null, availableThinkingLevels: [] }; },
    async setModel(id: string, provider: string, modelId: string) { calls.push(`model ${id} ${provider}/${modelId}`); },
    async setThinking(id: string, level: string) { calls.push(`thinking ${id} ${level}`); },
    async notice(id: string, text: string) { calls.push(`notice ${id} ${text}`); },
    waits: new Map<string, ChatWait | null>(),
    setWait(id: string, wait: ChatWait | null) { this.waits.set(id, wait); },
    views: new Map<string, ThreadView>(),
    async view(id: string) { return this.views.get(id) ?? null; },
    fire: () => observer!,
    busy(id: string) { return busyIds.has(id) || queuedIds.has(id); },
    running(id: string) { return busyIds.has(id); },
    async reload(id: string) { calls.push(`reload ${id}`); },
    /** Job threads whose daemon state shows work (a turn, a background bash, queued input), and the jobs `reloadIdle` reloaded. */
    sessionBusy: new Set<string>(),
    reloaded: [] as string[],
    async reloadIdle(id: string): Promise<"reloaded" | "busy" | "saved"> { if (this.sessionBusy.has(id)) return "busy"; this.reloaded.push(id); return "reloaded"; },
    async create(input: { cwd: string; name: string; kind: "chat"; thinkingLevel?: string }) { calls.push(`create ${input.kind} ${input.name} ${input.cwd}`); return { id: `s${next++}` }; },
    pin(id: string) { if (!pinned.has(id) && pinned.size >= pinLimit) return false; calls.push(`pin ${id}`); pinned.add(id); return true; },
    unpin(id: string) { calls.push(`unpin ${id}`); pinned.delete(id); },
    async setSteeringMode(id: string, mode: string) { calls.push(`steering ${id} ${mode}`); },
    heartbeats: new Map<string, string>(),
    async heartbeat(id: string) { return this.heartbeats.get(id); },
    async clearHeartbeat(id: string) { calls.push(`heartbeat ${id} clear`); this.heartbeats.delete(id); },
    async prompt(id: string, input: { message: string; mode: string }) { calls.push(`${input.mode} ${id} ${input.message}`); },
    observe(next: Observer) { observer = next; return () => { observer = undefined; }; },
  };
}

test("chats: create names, indexes, pins and sets steering all; an attach re-applies steering and clears the old check-in heartbeat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  const loads = loadRecord(join(dir, "extension-loads.json"));
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loads, source(dir));
  const created = await chats.create({ cwd: "/repo", name: "  " });
  assert.equal(await loads.get("s1"), "b1", "a new chat loaded the build on disk");
  assert.equal(created.id, "s1");
  assert.match(created.name, /^chat-[0-9a-f]{4}$/, "a blank name becomes a generated one");
  assert.deepEqual(calls, [`create chat ${created.name} /repo`, "pin s1", "steering s1 all"], "no heartbeat: the server tick does the check-in");
  assert.deepEqual(await index.ids(), ["s1"]);
  assert.deepEqual([...await chats.ids()], ["s1"]);
  assert.equal((await chats.create({ cwd: "/repo", name: "Feature X" })).name, "Feature X");

  calls.length = 0;
  threads.heartbeats.set("s1", OLD_CHECK_IN + " (chat_board with no ops) and what each job is doing.");
  threads.heartbeats.set("s2", "Owner's own heartbeat: summarize the inbox");
  threads.fire().live("s1", [child("done")]);
  threads.fire().live("s2", [child("running")]);
  await chats.settled();
  assert.deepEqual(calls.sort(), ["heartbeat s1 clear", "steering s1 all", "steering s2 all"], "only the old check-in heartbeat is cleared; another heartbeat stays");
  calls.length = 0;
  threads.fire().live("s1", []);
  await chats.settled();
  assert.deepEqual(calls, ["steering s1 all"], "cleared once");
  calls.length = 0;
  threads.fire().live("other", [child("running")]);
  threads.fire().children("other", []);
  await chats.settled();
  assert.deepEqual(calls, [], "a plain thread is not touched");

  calls.length = 0;
  await chats.forget("s1");
  assert.deepEqual(calls, ["unpin s1"]);
  assert.deepEqual(await index.ids(), ["s2"]);
  chats.close();
});

test("chats: a job that goes quiet with no message since its wake is told once per end, after the grace; a message, a report, a first task, a deleted or cancelled job and a plain thread get nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const messages: ThreadMessage[] = [];
  let clock = 1000;
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const chats = new Chats(index, { ...threads, state: () => ({ messages }) }, async () => ({ lifecycle: "live" }), "b1",
    loadRecord(join(dir, "extension-loads.json")), source(dir, {}, () => clock));
  await chats.adopt();
  const flush = async () => { await new Promise(resolve => setTimeout(resolve, 5)); await chats.settled(); };
  const job = (status: ChildAgent["status"], working: boolean, replied?: boolean, at?: number): ChildAgent =>
    ({ id: "k1", label: "audit", sessionName: "api-audit", status, ...(working ? { activity: { kind: "writing" as const } } : {}),
      ...(replied === undefined ? {} : { repliedSinceTask: replied }), ...(at ? { lastActivityAt: at } : {}) });
  threads.fire().live("c1", [job("running", true, false)]);
  await flush();
  calls.length = 0;
  threads.fire().children("c1", [job("done", false, false)]);
  await flush();
  assert.deepEqual(calls, [], "a first task that ends: the daemon's own notice covers it");

  threads.fire().children("c1", [job("done", true, false, 100)]);
  threads.fire().children("c1", [job("done", false, false, 100)]);
  threads.fire().children("c1", [job("done", true, false, 100)]);
  threads.fire().children("c1", [job("done", false, false, 100)]);
  await flush();
  assert.deepEqual(calls, ["steer c1 [job] api-audit ended at 09:00 with no report"], "flicker within one end is one line");
  calls.length = 0;
  threads.fire().children("c1", [job("done", true, false, 100)]);
  threads.fire().children("c1", [job("done", false, false, 100)]);
  await flush();
  assert.deepEqual(calls, [], "the same end is never told twice");

  clock = 5000;
  threads.fire().children("c1", [job("done", true, false, 200)]);
  messages.push({ role: "custom", customType: "agent_message", content: "[agent-message from child:api-audit]\n\nTwo questions before I go on: keep the old route?", timestamp: 6000 });
  threads.fire().children("c1", [job("done", false, false, 200)]);
  await flush();
  assert.deepEqual(calls, ['steer c1 [job] api-audit is waiting for you since 09:00 (last message: "Two questions before I go on: keep the old route?")'],
    "a message since its last wake: the job waits for the chat, since that message");
  calls.length = 0;
  clock = 10_000_000;
  threads.fire().children("c1", [job("done", true, false, 9_000_000)]);
  threads.fire().children("c1", [job("done", false, false, 9_000_000)]);
  threads.fire().children("c1", [job("done", true, false, 9_003_000)]);
  threads.fire().children("c1", [job("done", false, false, 9_003_000)]);
  await flush();
  assert.deepEqual(calls, ["steer c1 [job] api-audit ended at 11:30 with no report"], "two ends 3 s apart are one end: one line, and a message before the wake is no report");
  calls.length = 0;

  threads.fire().children("c1", [job("done", true, false, 300)]);
  threads.fire().children("c1", [job("done", false, false, 300)]);
  threads.fire().children("c1", []);
  await flush();
  assert.deepEqual(calls, [], "deleted before the grace ended");
  threads.fire().children("c1", [job("done", true, false, 400)]);
  threads.fire().children("c1", [job("cancelled", false, false, 400)]);
  threads.fire().children("c1", [job("done", true, false, 500)]);
  threads.fire().children("c1", [job("done", false, true, 500)]);
  threads.fire().children("c1", [job("done", true, false, 600)]);
  threads.fire().children("c1", [job("done", false, undefined, 600)]);
  await flush();
  assert.deepEqual(calls, [], "cancelled, reported, or an unknown reply state");
  threads.fire().children("plain", [job("done", true, false, 700)]);
  threads.fire().children("plain", [job("done", false, false, 700)]);
  await flush();
  assert.deepEqual(calls, [], "a plain thread gets nothing");
  chats.close();
});

/** A duty runner fake for Chats: the check-in runs it was handed, by chat. */
function dutySink() {
  const runs: { id: string; run: CheckInRun }[] = [];
  return { runs, duty: { async checkIn(id: string, run: CheckInRun) { runs.push({ id, run }); } } };
}

test("chats: every scheduled check-in hands one run with the precheck to the duty runner, all targets met included; it sends the chat nothing; a chat with nothing open starts none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [{ id: "p1", text: "Reach chats from Slack", status: "doing", children: [
    { id: "p2", text: "Plan", status: "doing", job: "api-audit", children: [] },
    { id: "p3", text: "Build", status: "blocked", waitUntil: new Date(1_000_000 + 86_400_000).toISOString(), children: [] }] }] };
  let now = 1_000_000;
  const sink = dutySink();
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: board }, () => now), duty: sink.duty });
  await chats.adopt();
  const job = (working: boolean): ChildAgent => ({ id: "k1", label: "audit", sessionName: "api-audit", status: working ? "running" : "done", lastActivityAt: now, repliedSinceTask: true });
  threads.fire().live("c1", [job(true)]);
  await chats.settled();
  calls.length = 0;
  now += 15 * 60_000;
  assert.deepEqual(await chats.tick(), ["c1"]);
  await chats.settled();
  assert.equal(sink.runs.length, 1, "exactly one run");
  const [{ id, run }] = sink.runs as [{ id: string; run: CheckInRun }];
  assert.equal(id, "c1");
  assert.deepEqual(Object.values(run.output.metrics).filter(value => Number(value) > 0), [], "every target met, and the run still goes to a job");
  assert.deepEqual([run.at, run.trigger, run.classes.live, run.classes.waiting], [now, "schedule", 1, 1]);
  assert.equal(run.findings, `### Jobs\n- job api-audit: working, last activity 15 min ago, on p2 "Plan" (doing)\n\n### Every open step, oldest change first\n` +
    `- p2 (live) "Plan" doing, owner job api-audit (working), last change 0 min ago\n- p3 (waiting) "Build" blocked, no owner, waits until ${localTime(1_000_000 + 86_400_000)}, last change 0 min ago`);
  assert.deepEqual(calls, [], "no steer, no nudge, no note: the duty job decides");
  assert.deepEqual(await chats.tick(), [], "a second wake in the same slot does not run it again");
  threads.fire().children("c1", [job(false)]);
  await chats.settled();
  now += 15 * 60_000;
  await chats.tick();
  await chats.settled();
  assert.match(sink.runs[1]!.run.findings, /### Steps whose class needs action\n- p2 "Plan" has no live owner \(job api-audit idle\): start a job, take it yourself, or ask the owner in For you/);
  assert.equal(sink.runs[1]!.run.output.metrics.orphan_steps, 1);
  board.plan = [{ ...board.plan[0]!, status: "done", children: board.plan[0]!.children.map(step => ({ ...step, status: "done" as const })) }];
  now += 15 * 60_000;
  await chats.tick();
  await chats.settled();
  assert.equal(sink.runs.length, 2, "no job at work and no open step: nothing to check");
  assert.deepEqual(calls, []);
  chats.close();
});


test("chats: the check-in reads the ledger's handoffs: a step on another thread's work is in the duty job's findings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const now = 100_000_000;
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [],
    plan: [{ id: "p1", text: "Find what eats swap", status: "doing", job: "c1", note: "at 12 GB", children: [] }] };
  const ledger: Ledger = { corrections: [{ id: "c7", at: "", chat: { id: "vp", name: "dev VP" }, words: "w", rule: "Machine work goes to ops guy.", enforcedBy: "code",
    ref: "pending commit", status: "reopened", theme: ["mac"], repeats: [], handoff: { to: "ops guy (+observability)", topics: ["swap", "M1 Air"] } }] };
  const sink = dutySink();
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: board }, () => now), corrections: async () => ledger, duty: sink.duty });
  await chats.adopt();
  threads.fire().live("c1", []);
  await chats.settled();
  await chats.checkIn("c1");
  assert.match(sink.runs[0]!.run.findings, /### Owned by another thread by an owner ruling\n- p1 "Find what eats swap" belongs to ops guy \(\+observability\) \(correction c7\): hand it off/);
  assert.equal(sink.runs[0]!.run.output.metrics.scope_misses, 1);
  chats.close();
});



test("chats: the scheduler runs each chat at its own interval, skips a paused one, resumes it when the pause ends, and keeps the setting across a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of ["slow", "fast"]) await index.add(id);
  let now = new Date(2026, 9, 8, 14, 0).getTime();
  const chats = new Chats(index, fakeThreads(calls), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir, {}, () => now));
  assert.equal(await chats.checkInView("plain"), null, "not a chat");
  assert.equal(await chats.setCheckIn("plain", { everyMs: 60_000 }, OWNER_UI), null);
  assert.deepEqual(await chats.checkInView("fast"), { everyMs: 900_000, paused: false, nextAt: now, pausedUntil: null, lastAt: null },
    "a chat with no check-in on record is due at once, not one interval after the service started");
  await chats.setCheckIn("fast", { everyMs: 60_000 }, OWNER_UI);
  await chats.setCheckIn("slow", { everyMs: 15 * 60_000 }, OWNER_UI);
  const ran: Record<string, number> = { fast: 0, slow: 0 };
  for (let second = 30; second <= 30 * 60; second += 30) {
    now += 30_000;
    for (const id of await chats.tick()) ran[id]!++;
  }
  assert.deepEqual(ran, { fast: 30, slow: 2 }, "30 min: every 1 min and every 15 min");
  await chats.settled();
  assert.equal((await chats.checkInView("fast"))?.lastAt, now - 30_000, "due at the first wake, then every minute");

  await chats.setCheckIn("fast", { everyMs: 5 * 60_000 }, OWNER_UI);
  const before = now;
  let fast = 0;
  for (let second = 30; second <= 10 * 60; second += 30) { now += 30_000; if ((await chats.tick()).includes("fast")) fast++; }
  assert.equal(fast, 2, "the new interval applies at the next wake");
  assert.equal((await chats.checkInView("fast"))?.lastAt, before + 9.5 * 60_000);

  const long = await chats.setCheckIn("slow", { pause: "1h" }, OWNER_UI);
  assert.deepEqual([long?.pausedUntil, long?.nextAt], [now + 3_600_000, now + 3_600_000], "the pause end, then the run it allows");
  await chats.setCheckIn("slow", { pause: null }, OWNER_UI);
  const paused = await chats.setCheckIn("fast", { pause: "1h" }, OWNER_UI);
  assert.equal(paused?.paused, true);
  assert.equal(paused?.pausedUntil, now + 3_600_000);
  assert.equal(paused?.nextAt, now + 3_600_000);
  const pausedAt = now;
  fast = 0;
  for (let second = 30; second < 60 * 60; second += 30) { now += 30_000; if ((await chats.tick()).includes("fast")) fast++; }
  assert.equal(fast, 0, "no check-in while paused");
  now = pausedAt + 3_600_000;
  assert.deepEqual((await chats.tick()).includes("fast"), true, "the pause ended: it runs at once");
  assert.equal((await chats.checkInView("fast"))?.paused, false);

  await chats.setCheckIn("fast", { pause: "forever" }, OWNER_UI);
  now += 24 * 3_600_000;
  assert.equal((await chats.tick()).includes("fast"), false, "paused until resumed");
  assert.deepEqual(await chats.checkIns(), new Map([["slow", { everyMs: 900_000, paused: false, pausedUntil: null, nextAt: (await chats.checkInView("slow"))!.nextAt }],
    ["fast", { everyMs: 300_000, paused: true, pausedUntil: "forever", nextAt: null }]]));
  await chats.settled();
  chats.close();

  const again = new Chats(index, fakeThreads(calls), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir, {}, () => now));
  assert.deepEqual(await again.checkInView("fast"), { everyMs: 300_000, paused: true, nextAt: null, pausedUntil: "forever", lastAt: null }, "the setting survives a restart");
  const resumed = await again.setCheckIn("fast", { pause: null }, OWNER_UI);
  assert.deepEqual(resumed, { everyMs: 300_000, paused: false, nextAt: now, pausedUntil: null, lastAt: null }, "resume keeps the interval; with no check-in on record it is due at once");
  now += 300_000;
  assert.deepEqual(await again.tick(), ["fast", "slow"], "neither has a check-in on record in this service (their boards had nothing to check), so both are due at the first wake");
  await again.settled();
  again.close();
});

test("chats: a check-in whose job could not start runs again 5 min later, not a whole interval later (slack green guy 10-12)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("sg");
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [{ id: "p1", text: "Goal", status: "doing", children: [
    { id: "p2", text: "Build", status: "doing", children: [] }] }] };
  let now = 10 * 60 * 60_000;
  const starts: string[] = [];
  const duty = { async checkIn(id: string, run: CheckInRun) { starts.push(`${id} ${(run.at - 10 * 60 * 60_000) / 60_000}`); return starts.length === 1 ? "failed" as const : "done" as const; } };
  const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), { ...source(dir, { sg: board }, () => now), duty });
  await chats.setCheckIn("sg", { everyMs: 60 * 60_000 }, OWNER_UI);
  await chats.tick(); await chats.settled();
  now += 5 * 60_000;
  await chats.tick(); await chats.settled();
  now += 5 * 60_000;
  await chats.tick(); await chats.settled();
  assert.deepEqual(starts, ["sg 0", "sg 5"], "retried after 5 min, then back on its hourly schedule");
  chats.close();
});

test("chats: a service restart keeps each chat's check-in schedule from its memory; an owner turn holds no check-in; adopting a chat creates no duty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of ["vp", "fresh"]) await index.add(id);
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [{ id: "p1", text: "Goal", status: "doing", children: [
    { id: "p7", text: "Check the load", status: "doing", job: "vp", waitUntil: new Date(1_000_000).toISOString(), children: [] }] }] };
  let now = 10 * 60 * 60_000;
  await checkInRecord(join(dir, "check-ins.json")).set("vp", { at: now - 20 * 60_000, steps: { p7: { sig: JSON.stringify(["doing", "Check the load", "vp", new Date(1_000_000).toISOString(), ""]), at: 0 } } });
  const store = new DutyStore(dir);
  const started: string[] = [];
  const duties = new Duties(store, { isChat: async () => true, tickMs: 0, now: () => now,
    jobs: { chat: async id => ({ id, name: id, cwd: "/repo", board: "/b.json" }), working: async () => false, retire: async () => {},
      start: async (chat, name, brief) => { started.push(`${chat.id} ${name}`); assert.match(brief, /p7 "Check the load" is due since/); return { id: `job-${chat.id}`, name }; } } });
  const chats = new Chats(index, fakeThreads(calls), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { vp: board, fresh: board }, () => now), duty: duties });
  await chats.adopt();
  assert.deepEqual([await store.chats(), await store.list("vp")], [[], []], "no Board convergence duty: the check-in is the chat's one built-in duty");
  assert.deepEqual(await chats.tick(), ["fresh", "vp"], "the chat checked in 20 min before the restart is due at the first wake, and so is one with " +
    "no check-in on record (ops guy 10-12: each release restart pushed its 2 h check-in back again)");
  await chats.settled();
  assert.deepEqual(started.sort(), [`fresh check-in fresh ${clockTime(now)}`, `vp check-in vp ${clockTime(now)}`]);
  assert.deepEqual([(await store.read("vp")).duties, (await store.read("vp")).checkIn?.runCount], [[], 1], "the run is a run of the built-in duty, and no standing duty appears");
  const threads = fakeThreads(calls);
  const busy = new Chats(index, { ...threads, running: () => true, state: () => ({ messages: [{ role: "user", content: "hi", timestamp: now }] }) }, async () => ({ lifecycle: "live" }), "b1",
    loadRecord(join(dir, "extension-loads.json")), source(dir, { vp: board, fresh: board }, () => now));
  now += 15 * 60_000;
  assert.deepEqual((await busy.tick()).sort(), ["fresh", "vp"], "the duty job runs beside the owner's turn: no hold");
  await busy.settled();
  chats.close();
  busy.close();
});

test("chats: adopt pins what the daemon still lists, unarchives what the daemon archived, forgets missing, keeps an unknown one while the daemon is down", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of ["gone", "archived", "down", "live"]) await index.add(id);
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const loads = loadRecord(join(dir, "extension-loads.json"));
  const chats = new Chats(index, threads, async id => {
    if (id === "gone") return undefined;
    if (id === "archived") return { lifecycle: "archived" };
    if (id === "down") throw new Error("Prime Agent daemon is not reachable.");
    return { lifecycle: "live" };
  }, "b1", loads, source(dir));
  assert.deepEqual(await chats.adopt(), { pinned: ["live", "down", "archived"], forgotten: ["gone"], adopted: [] }, "newest first, as the index lists them");
  assert.deepEqual(calls, ["pin live", "pin down", "unarchive archived", "pin archived", "unpin gone"]);
  assert.deepEqual(await index.ids(), ["live", "down", "archived"]);
  const lines: string[] = [];
  const full = new Chats(index, fakeThreads([], 0), async () => ({ lifecycle: "live" }), "b1", loads, source(dir), line => lines.push(line));
  assert.deepEqual(await full.adopt(), { pinned: [], forgotten: [], adopted: [] });
  assert.equal(lines.length, 3, "the live limit is logged, not thrown");
  chats.close(); full.close();
});

test("chats: a forced daemon shutdown archives every live session; the next serve start keeps every chat in the index and the next create adds to it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  const old = ["vp", "ops", "ci", "crawler"];
  for (const id of [...old].reverse()) await index.add(id);
  const calls: string[] = [];
  const lines: string[] = [];
  const chats = new Chats(index, fakeThreads(calls), async () => ({ lifecycle: "archived" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir), line => lines.push(line));
  const adopted = await chats.adopt();
  assert.deepEqual(adopted.forgotten, [], "an archived state the chat list did not write never drops a chat");
  assert.deepEqual(await index.ids(), old);
  assert.deepEqual(calls.filter(call => call.startsWith("unarchive")), old.map(id => `unarchive ${id}`));
  assert.match(lines.join("\n"), /chat vp: unarchived: the daemon archived it, the chat list did not/);
  const { id } = await chats.create({ cwd: "/repo" });
  assert.deepEqual(await index.ids(), [id, ...old], "the new chat goes first and every old one stays");
  chats.close();
});

test("id index: a file it cannot parse fails the write and stays on disk; it is never replaced by an empty list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const path = join(dir, "chats.json");
  await writeFile(path, '{"ids":["a","b"');
  const index = new IdIndex(path, "Chat index");
  await assert.rejects(index.add("c"));
  await assert.rejects(index.ids());
  assert.equal(await readFile(path, "utf8"), '{"ids":["a","b"');
});

test("chats: undo after archive brings a chat back as a chat (index, pin, steering); a plain thread stays plain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const lines = (entries: object[]) => entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  const chatFile = join(dir, "chat.jsonl");
  const plainFile = join(dir, "plain.jsonl");
  await writeFile(chatFile, lines([{ type: "session", id: "c" }, { type: "custom", customType: "chat_mode", data: { v: 1 } }, { type: "message", id: "m" }]));
  await writeFile(plainFile, lines([{ type: "session", id: "p" },
    { type: "message", id: "m", message: { role: "user", content: '{"type":"custom","customType":"chat_mode"}' } }]));
  assert.equal(await fileHasChatMarker(chatFile), true);
  assert.equal(await fileHasChatMarker(plainFile), false, "the entry quoted inside a message is not the entry");
  assert.equal(await fileHasChatMarker(join(dir, "missing.jsonl")), false);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("chat1");
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const files: Record<string, string> = { chat1: chatFile, plain: plainFile };
  const chats = new Chats(index, threads, async id => files[id] ? { lifecycle: "live", sessionFile: files[id] } : undefined, "b1", loadRecord(join(dir, "extension-loads.json")), source(dir));
  await chats.forget("chat1");
  assert.deepEqual(await index.ids(), []);
  calls.length = 0;
  threads.fire().children("chat1", [child("running")]);
  assert.equal(await chats.restore("chat1"), true);
  await chats.settled();
  assert.deepEqual(calls, ["pin chat1", "steering chat1 all"]);
  assert.deepEqual(await index.ids(), ["chat1"]);
  assert.ok((await chats.ids()).has("chat1"));
  calls.length = 0;
  assert.equal(await chats.restore("plain"), false);
  assert.equal(await chats.restore("nofile"), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(await index.ids(), ["chat1"]);
  chats.close();
});

test("stale extension: the decision, and the reload once a chat attaches (now when idle, at the end of its turn when busy; never twice for one build)", async () => {
  assert.equal(reloadAction(undefined, "b2", false), "reload", "no record: the chat may run any build");
  assert.equal(reloadAction("b1", "b2", false), "reload");
  assert.equal(reloadAction("b1", "b2", true), "wait");
  assert.equal(reloadAction("b2", "b2", false), null);
  assert.equal(reloadAction("b2", "b2", true), null);
  const build = extensionBuild();
  assert.match(build, /^[0-9a-f]{16}$/);
  assert.equal(extensionBuild(), build, "the same sources hash the same");
  const tree = await mkdtemp(join(tmpdir(), "build-"));
  const src = join(tree, "components", "user-history", "src");
  await cp(join(import.meta.dirname, "..", "src"), src, { recursive: true });
  await cp(join(import.meta.dirname, "..", "extension"), join(tree, "components", "user-history", "extension"), { recursive: true });
  await cp(join(import.meta.dirname, "..", "..", "global-rules"), join(tree, "components", "global-rules"), { recursive: true });
  let before = extensionBuild(src);
  // The context hook (correction-delivery, prime-notices, context-images, the reply cap's reply-lint notes and turns text), the board tool's schema
  // (chat-board, types) and global-rules, which runs in every session.
  for (const file of ["correction-delivery.ts", "prime-notices.ts", "context-images.ts", "shared/reply-lint.ts", "shared/turns.ts", "shared/types.ts", "shared/chat-board.ts",
    "../../global-rules/index.ts"]) {
    await appendFile(join(src, file), "\n");
    const after = extensionBuild(src);
    assert.notEqual(after, before, `${file} shapes a session's requests, so a change to it reloads the chat and its jobs`);
    before = after;
  }
  await rm(tree, { recursive: true, force: true });

  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of ["old", "busy", "fresh", "plain"]) if (id !== "plain") await index.add(id);
  const loads = loadRecord(join(dir, "extension-loads.json"));
  await loads.set("fresh", "b2");
  await loads.set("busy", "b1");
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  threads.busyIds.add("busy");
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b2", loads, source(dir));
  await chats.adopt();
  calls.length = 0;
  for (const id of ["old", "busy", "fresh", "plain"]) threads.fire().live(id, []);
  await chats.settled();
  assert.deepEqual(calls.filter(call => call.startsWith("reload")), ["reload old"], "no record reloads; a matching record, a busy chat and a plain thread do not");
  assert.equal(await loads.get("old"), "b2");
  assert.equal(await loads.get("busy"), "b1", "still waiting for the turn to end");
  calls.length = 0;
  threads.fire().idle("fresh");
  threads.fire().idle("plain");
  await chats.settled();
  assert.equal(calls.length, 0, "a turn ending in a chat that is not waiting does nothing");
  threads.busyIds.delete("busy");
  threads.fire().idle("busy");
  await chats.settled();
  assert.deepEqual(calls, ["reload busy"]);
  assert.equal(await loads.get("busy"), "b2");
  calls.length = 0;
  threads.fire().live("old", []);
  threads.fire().live("busy", []);
  await chats.settled();
  assert.deepEqual(calls.filter(call => call.startsWith("reload")), [], "a plain restart with the same build reloads nothing");
  await chats.forget("old");
  assert.equal(await loads.get("old"), undefined, "a forgotten chat drops its record");
  chats.close();
});

test("stale extension in a job: a job of a chat that runs an older build than the one on disk is reloaded once it runs nothing, one job at a time, never twice for one build", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const loads = loadRecord(join(dir, "extension-loads.json"));
  await loads.set("old", "b1");
  await loads.set("current", "b2");
  await loads.set("kernel", "b1");
  await loads.set("working", "b1");
  const threads = fakeThreads([]);
  threads.sessionBusy.add("kernel");
  const agent = (sessionId: string, link: ChatAgent["link"], state: ChatAgent["state"] = "done"): ChatAgent =>
    ({ key: `thread:${sessionId}`, sessionId, name: sessionId, job: sessionId, sender: sessionId, link, state, lastActivityAt: new Date(0).toISOString(), steps: [] });
  let agents: ChatAgent[] = [agent("old", "subagent"), agent("unknown", "root"), agent("current", "subagent"), agent("kernel", "subagent"),
    agent("working", "subagent", "working"), agent("t3", "step")];
  const rows = (): SessionRow[] => [row("c1", new Date(0).toISOString(), { chat: true, agents })];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b2", loads, { ...source(dir, {}, () => 0, rows), tickMs: 0 });
  await chats.adopt();
  await chats.tick();
  await chats.settled();
  assert.deepEqual(threads.reloaded, ["old", "unknown"],
    "a job on an older build, or one already running at the first look, keeps stale prompt-shaping code unless it is reloaded; a step owner is no job");
  assert.equal(await loads.get("old"), "b2");
  assert.equal(await loads.get("unknown"), "b2");
  assert.equal(await loads.get("kernel"), "b1", "background work in its kernel: the reload waits, a reload would drop it");
  assert.equal(await loads.get("working"), "b1", "a working job is not reloaded mid-turn");

  threads.reloaded.length = 0;
  threads.sessionBusy.delete("kernel");
  agents = [...agents.filter(item => item.sessionId !== "working"), agent("working", "subagent"), agent("fresh", "subagent")];
  await chats.tick();
  await chats.settled();
  assert.deepEqual(threads.reloaded, ["kernel", "working"], "each reloads once it runs nothing; the ones done before are not reloaded again");
  assert.equal(await loads.get("fresh"), "b2", "a job that shows up after the first look started on this build: recorded, not reloaded");

  threads.reloaded.length = 0;
  await chats.tick();
  await chats.settled();
  assert.deepEqual(threads.reloaded, [], "the same build reloads nothing");
  chats.close();
});

const header = JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2026-10-03T10:23:48Z", cwd: "/repo", rlmDepth: 0 });
const info = JSON.stringify({ type: "session_info", id: "i", timestamp: "2026-10-03T10:23:50Z", name: "md-count" });
const state = JSON.stringify({ type: "session_state", id: "s", timestamp: "2026-10-03T10:23:50Z", state: { status: "active" } });
const digest = JSON.stringify({ type: "custom_message", id: "d", customType: "harness_digest", content: "x".repeat(70000) });
const message = JSON.stringify({ type: "message", id: "m", message: { role: "user", content: "Job: count the Markdown files", timestamp: 1 } });

test("origin: a root named at create (rlm.create_session) is the agent's; one named after its state entry or never named is the person's", async () => {
  const dir = await mkdtemp(join(tmpdir(), "origin-"));
  const file = (name: string, lines: string[]) => { const path = join(dir, name); return writeFile(path, lines.join("\n") + "\n").then(() => path); };
  const agent = await file("agent.jsonl", [header, info, state, digest, message]);
  const renamed = await file("renamed.jsonl", [header, state, info, digest, message]);
  const unnamed = await file("unnamed.jsonl", [header, state, digest, message]);
  const legacyAgent = await file("legacy-agent.jsonl", [header, info, message]);
  const legacyUser = await file("legacy-user.jsonl", [header, message, info]);
  const fresh = await file("fresh.jsonl", [header, info]);
  assert.deepEqual(fileOrigin(agent), { origin: "agent", final: true });
  assert.deepEqual(fileOrigin(renamed), { origin: "user", final: true }, "a name after session_state is a rename");
  assert.deepEqual(fileOrigin(unnamed), { origin: "user", final: true });
  assert.deepEqual(fileOrigin(legacyAgent), { origin: "agent", final: true }, "no session_state: the name precedes the first message");
  assert.deepEqual(fileOrigin(legacyUser), { origin: "user", final: true });
  assert.deepEqual(fileOrigin(fresh), { origin: "agent", final: false }, "no state or message yet: asked again next time");
  assert.deepEqual(fileOrigin(join(dir, "missing.jsonl")), { origin: "user", final: false });

  const created = new IdIndex(join(dir, "threads.json"), "Thread index");
  await created.add("own");
  const origins = new ThreadOrigins(created);
  let resolve = await origins.resolver(new Set(["chat"]));
  assert.equal(resolve({ sessionId: "own", sessionFile: agent }), "user", "a thread this server created wins over its file");
  assert.equal(resolve({ sessionId: "chat", sessionFile: agent }), "user", "a chat is named at create and still the person's");
  assert.equal(resolve({ sessionId: "a", sessionFile: agent }), "agent");
  assert.equal(resolve({ sessionId: "f", sessionFile: fresh }), "agent");
  assert.equal(resolve({ sessionId: "n" }), "user", "no file, nothing says otherwise");
  await writeFile(agent, [header, state, info, message].join("\n") + "\n");
  await writeFile(fresh, [header, info, state, message].join("\n") + "\n");
  resolve = await origins.resolver(new Set());
  assert.equal(resolve({ sessionId: "a", sessionFile: agent }), "agent", "a final decision is kept; the head of a session file does not change");
  assert.equal(resolve({ sessionId: "f", sessionFile: fresh }), "agent", "an open decision is read again");
  assert.deepEqual(fileOrigin(fresh), { origin: "agent", final: true });
});

const row = (id: string, lastActivityAt: string, extra: Partial<SessionRow> = {}): SessionRow => ({ id, name: id, cwd: "/repo", kind: "live", status: "idle", archived: false,
  messageCount: 3, working: false, subagentsRunning: 0, unread: false, tags: [], priority: 0, progress: "none", origin: "user", lastActivityAt, ...extra });
const ownerAsks = (text: string, at: number): ThreadMessage => ({ role: "user", content: text, timestamp: at });
const reply = (stopReason: "stop" | "error", at: number, errorMessage?: string): ThreadMessage =>
  ({ role: "assistant", content: [], provider: "p", model: "m", stopReason, timestamp: at, ...(errorMessage ? { errorMessage } : {}) });

test("chats: a chat whose last turn failed gets a new turn 5, 10, then every 20 min, even with nothing open; a good turn resets; a busy or paused chat waits; no notice queues behind it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = 1_000_000_000;
  const lines: string[] = [];
  const memory = checkInRecord(join(dir, "check-ins.json"));
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [{ id: "p1", text: "Goal", status: "doing", children: [] }] };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir, {}, () => now), line => lines.push(line));
  await chats.adopt();
  threads.transcripts.set("c1", [ownerAsks("[check-in] What changed: p1 finished", now), reply("error", now, "Provider rate limit exceeded (rate_limit_error, 429)")]);
  // The check-ins sent so far sit in its queue with nothing running: `busy`, not `running`. Waiting on `busy` is how 453e stayed dead for 2.6 h.
  threads.queuedIds.add("c1");
  const restarted: number[] = [];
  const run = async (minutes: number) => {
    for (let half = 0; half < minutes * 2; half++) {
      now += 30_000;
      const before = calls.length;
      await chats.tick();
      await chats.settled();
      if (calls.slice(before).some(call => call.startsWith("restart c1"))) restarted.push(Math.round((now - start) / 60_000));
    }
  };
  const start = now;
  await run(60);
  assert.deepEqual(restarted, [5, 15, 35, 55], "5 min after the failure, then 10, then 20, then 20");
  assert.equal(calls.find(call => call.startsWith("restart")), "restart c1 [check-in] Your last turn failed at 22:46 (Provider rate limit exceeded (rate_limit_error, 429)). Re-check the board and continue.");
  assert.deepEqual(calls.filter(call => call.startsWith("steer")), [], "no check-in steer queues into the failed chat");
  assert.match(lines.join("\n"), /chat c1: last turn failed \(Provider rate limit exceeded \(rate_limit_error, 429\)\); started a new turn, try 4/);

  const sink = dutySink();
  const withBoard = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: board }, () => now), memory, duty: sink.duty }, line => lines.push(line));
  await withBoard.checkIn("c1");
  assert.equal(sink.runs.length, 1, "the check-in job runs beside the restart schedule: it steers no chat, so it waits for nothing");
  const job = (working: boolean, at: number): ChildAgent => ({ id: "k1", label: "a", sessionName: "ai-risk-blog", status: "done", ...(working ? { activity: { kind: "writing" as const } } : {}),
    repliedSinceTask: false, lastActivityAt: at });
  threads.fire().live("c1", [job(true, 1)]);
  await withBoard.settled();
  calls.length = 0;
  threads.fire().children("c1", [job(false, 1)]);
  await new Promise(resolve => setTimeout(resolve, 5));
  await withBoard.settled();
  assert.deepEqual(calls.filter(call => call.startsWith("steer")), [], "no [job] notice piles up behind the failure");
  assert.match(lines.join("\n"), /no notice for ai-risk-blog: the chat's last turn failed/);
  withBoard.close();

  threads.transcripts.get("c1")!.push(ownerAsks("[check-in] Your last turn failed (429). Re-check the board and continue.", now), reply("stop", now + 1));
  restarted.length = 0;
  await run(10);
  assert.deepEqual(restarted, [], "the new turn ended well");
  const failedAgain = now;
  threads.transcripts.get("c1")!.push(ownerAsks("continue", now), reply("error", now, "Connection error."));
  threads.busyIds.add("c1");
  await run(30);
  assert.deepEqual(restarted, [], "a turn still running is not restarted");
  threads.busyIds.delete("c1");
  await run(1);
  assert.deepEqual(restarted, [Math.round((failedAgain - start) / 60_000) + 31], "the count started over: the first wait (5 min) has long passed");
  await chats.setCheckIn("c1", { pause: "forever" }, OWNER_UI);
  restarted.length = 0;
  await run(60);
  assert.deepEqual(restarted, [], "the owner paused the chat");
  chats.close();
});


test("chats: a board the server cannot read is a fact in the duty job's findings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const lines: string[] = [];
  const sink = dutySink();
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir), board: async () => { throw new Error("Chat board file is malformed."); }, duty: sink.duty }, line => lines.push(line));
  await chats.adopt();
  await chats.checkIn("c1");
  assert.equal(sink.runs[0]!.run.findings, "### Other facts\n- the board cannot be read: Chat board file is malformed.", "with no job and no step it still runs");
  assert.deepEqual(calls.filter(call => call.startsWith("steer")), []);
  assert.match(lines.join("\n"), /check-in board: Chat board file is malformed\./);
  chats.close();
});

test("chats: adopt and the scheduler's scan bring back a recent unarchived thread with the chat_mode entry that the index lost, and log it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const jsonl = (entries: object[]) => entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  const marked = jsonl([{ type: "session", id: "c" }, { type: "session_info", id: "i", name: "chat-6394" }, { type: "custom", customType: "chat_mode", data: { v: 1 } },
    { type: "session_state", id: "s", state: { status: "archived" } }, { type: "session_state", id: "t", state: { status: "active" } }, { type: "message", id: "m" }]);
  const files: Record<string, string> = {};
  for (const id of ["lost", "archived", "old", "later"]) { files[id] = join(dir, `${id}.jsonl`); await writeFile(files[id]!, marked); }
  files.plain = join(dir, "plain.jsonl");
  await writeFile(files.plain, jsonl([{ type: "session", id: "p" }, { type: "message", id: "m" }, { type: "custom", customType: "chat_mode", data: { v: 1 } }]));
  let now = Date.parse("2026-10-08T04:00:00Z");
  const recent = new Date(now - 60 * 60_000).toISOString();
  const rows = [row("lost", recent), row("plain", recent), row("archived", recent, { archived: true }), row("old", new Date(now - 8 * 24 * 3_600_000).toISOString()), row("kept", recent)];
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("kept");
  const calls: string[] = [];
  const lines: string[] = [];
  const read: string[] = [];
  const chats = new Chats(index, fakeThreads(calls), async id => { read.push(id); return { lifecycle: "live", ...(files[id] ? { sessionFile: files[id] } : {}) }; }, "b1",
    loadRecord(join(dir, "extension-loads.json")), source(dir, {}, () => now, () => rows), line => lines.push(line));
  assert.equal(await fileHasChatMarker(files.plain), false, "an entry after the first message is not the marker: the scan reads only the head");
  const adopted = await chats.adopt();
  assert.deepEqual(adopted, { pinned: ["kept"], forgotten: [], adopted: ["lost"] }, "archived, plain and older than 7 days stay out");
  assert.deepEqual(await index.ids(), ["lost", "kept"]);
  assert.ok(calls.includes("pin lost") && calls.includes("steering lost all"));
  assert.match(lines.join("\n"), /chat lost: re-adopted: its session file has the chat_mode entry, the chat index did not/);

  rows.push(row("later", new Date(now).toISOString()));
  read.length = 0;
  now += 9 * 60_000;
  await chats.tick();
  await chats.settled();
  assert.equal((await index.ids()).includes("later"), false, "the scan runs every 10 min");
  now += 60_000;
  await chats.tick();
  await chats.settled();
  assert.deepEqual(await index.ids(), ["later", "lost", "kept"], "the scheduler's scan finds it without a restart");
  assert.equal(read.includes("plain"), false, "a thread found plain is not read again");
  chats.close();
});

test("chats: a chat the owner archived may wake and answer an agent message but stays out of the chats and the sidebar, across a service restart; one the daemon archived still comes back", async t => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const marked = [{ type: "session", id: "c" }, { type: "custom", customType: "chat_mode", data: { v: 1 } }, { type: "message", id: "m" }].map(entry => JSON.stringify(entry)).join("\n") + "\n";
  const files: Record<string, string> = {};
  for (const id of ["stripe", "vp"]) { files[id] = join(dir, `${id}.jsonl`); await writeFile(files[id]!, marked); }
  let now = Date.parse("2026-10-12T07:31:41Z");
  const lifecycle: Record<string, "live" | "archived"> = { stripe: "live", vp: "live" };
  const rows = () => Object.keys(lifecycle).map(id => row(id, new Date(now - 60_000).toISOString(), { archived: lifecycle[id] === "archived" }));
  const summary = async (id: string) => ({ lifecycle: lifecycle[id]!, sessionFile: files[id]! });
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of ["vp", "stripe"]) await index.add(id);
  const archived = new IdIndex(join(dir, "archived-chats.json"), "Archived chat index");
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  threads.archive = async (id: string) => { calls.push(`archive ${id}`); lifecycle[id] = "archived"; };
  threads.unarchive = async (id: string) => { calls.push(`unarchive ${id}`); lifecycle[id] = "live"; };
  const serve = () => new Chats(index, threads, summary, "b1", loadRecord(join(dir, "extension-loads.json")), { ...source(dir, {}, () => now, rows), archived }, () => {});
  const sidebar = async (chats: Chats) => {
    const reads = new ChatReadState("unused");
    const labels = new ChatLabels("unused");
    t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
    t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
    const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
    Object.defineProperty(catalog.client, "isConnected", { get: () => true });
    t.mock.method(catalog.client, "reconnect", async () => {});
    t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
    t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list"
      ? { success: true, data: { sessions: Object.keys(lifecycle).map(id => ({ sessionId: id, cwd: "/repo", sessionName: id, messageCount: 3, lifecycle: lifecycle[id],
        ...(lifecycle[id] === "live" ? { activeSessionId: `a-${id}` } : {}) })) } }
      : { success: true, data: { jobs: [] } });
    await catalog.refresh();
    const event = await catalog.event();
    await catalog.close();
    return event.sessions.filter(shown => inSidebar(shown, { archived: false, agentCreated: false })).map(shown => shown.id).sort();
  };
  const chats = serve();
  await chats.adopt();
  await chats.archive("stripe");
  assert.deepEqual(await index.ids(), ["vp"], "the owner's archive leaves the index");

  // 20:38 KST: a relayed agent message resumes the archived session; it answers, and the daemon lists it unarchived again.
  lifecycle.stripe = "live";
  calls.length = 0;
  now += 4 * 60 * 60_000;
  const due = await chats.tick();
  await chats.settled();
  assert.deepEqual(await index.ids(), ["vp"], "the scan does not take it back as a chat");
  assert.equal(due.includes("stripe"), false, "no check-in");
  assert.deepEqual(calls.filter(call => call.includes("stripe")), [], "nothing archives, pins, steers or reloads it");
  assert.equal(lifecycle.stripe, "live", "its session stays awake to answer");
  assert.deepEqual(await sidebar(chats), ["vp"], "the sidebar still hides it");
  chats.close();

  // A forced daemon shutdown archives every live session, then the service restarts: the daemon's archive of vp is undone, the owner's is kept.
  lifecycle.vp = "archived";
  lifecycle.stripe = "live";
  calls.length = 0;
  const restarted = serve();
  const adopted = await restarted.adopt();
  assert.deepEqual(adopted, { pinned: ["vp"], forgotten: [], adopted: [] });
  assert.ok(calls.includes("unarchive vp") && !calls.includes("archive stripe") && !calls.includes("unarchive stripe"));
  assert.deepEqual(await index.ids(), ["vp"]);
  assert.deepEqual(await sidebar(restarted), ["vp"]);

  // The owner's own unarchive takes it back as a chat and ends the record, so it shows again.
  assert.equal(await restarted.restore("stripe"), true);
  assert.deepEqual([await index.ids(), await archived.ids()], [["stripe", "vp"], []]);
  assert.deepEqual(await sidebar(restarted), ["stripe", "vp"]);
  restarted.close();
});

test("chats: a serve that does not own the live chats pins, steers, reloads and checks in only the chats it created, even with a copy of the live chats.json; the main serve still adopts them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const found = join(dir, "found.jsonl");
  await writeFile(found, [{ type: "session", id: "f" }, { type: "custom", customType: "chat_mode", data: { v: 1 } }, { type: "message", id: "m" }].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  let now = Date.parse("2026-10-10T04:00:00Z");
  const recent = new Date(now - 60_000).toISOString();
  const rows = [row("vp", recent), row("dev", recent), row("found", recent)];
  const summary = async (id: string) => ({ lifecycle: "live" as const, ...(id === "found" ? { sessionFile: found } : {}) });
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of ["dev", "vp"]) await index.add(id);
  const owned = new IdIndex(join(dir, "own-chats.json"), "Own chat index");
  const loads = loadRecord(join(dir, "extension-loads.json"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  threads.transcripts.set("vp", [ownerAsks("go on", now - 120_000), reply("error", now - 90_000, "429 rate limit")]);
  const scratch = new Chats(index, threads, summary, "b2", loads, { ...source(dir, {}, () => now, () => rows), owned });
  assert.deepEqual(await scratch.adopt(), { pinned: [], forgotten: [], adopted: [] }, "no live chat pinned, and the session-file scan stays off");
  threads.fire().live("vp", []);
  threads.fire().idle("dev");
  now += 60 * 60_000;
  assert.deepEqual(await scratch.tick(), [], "no check-in, though every chat in the copied index is due");
  await scratch.settled();
  assert.equal(await scratch.restore("found"), false, "an unarchive of a chat it did not create is not taken");
  assert.deepEqual([calls, [...await scratch.ids()], await index.ids()], [[], [], ["vp", "dev"]], "nothing attached, steered, restarted or reloaded");

  const { id } = await scratch.create({ cwd: "/repo" });
  assert.deepEqual([await owned.ids(), [...await scratch.ids()]], [[id], [id]]);
  scratch.close();
  const againCalls: string[] = [];
  const again = new Chats(index, fakeThreads(againCalls), summary, "b2", loads, { ...source(dir, {}, () => now, () => rows), owned });
  assert.deepEqual(await again.adopt(), { pinned: [id], forgotten: [], adopted: [] }, "after a restart it adopts its own chat");
  again.close();

  const mainCalls: string[] = [];
  const mainThreads = fakeThreads(mainCalls);
  const main = new Chats(index, mainThreads, summary, "b2", loads, source(dir, {}, () => now, () => rows));
  assert.deepEqual(await main.adopt(), { pinned: [id, "vp", "dev"], forgotten: [], adopted: ["found"] });
  mainThreads.fire().live("vp", []);
  await main.settled();
  assert.ok(mainCalls.includes("steering vp all") && mainCalls.includes("reload vp"), "the main serve attaches and reloads as before");
  main.close();
});

test("thread hub: running ignores queued input that busy counts; restart sends the text, then resumes the session's queued input", async () => {
  const info = { isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, sessionAction: null, queuedActions: 2 } as unknown as ThreadState["info"];
  assert.equal(isTurnRunning(info), false, "two steers queued behind a failed turn, nothing running");
  assert.equal(isThreadBusy({ info, queue: { steering: [], followUp: [] }, children: [], tools: [] }), true);
  assert.equal(isTurnRunning({ ...info, retryAttempt: 1 }), true, "an auto-retry of a 429 is still the turn");
  assert.equal(isTurnRunning({ ...info, isStreaming: true }), true);
  const hub = new ThreadHub("/nonexistent.sock", {} as Catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const calls: string[] = [];
  hub.prompt = async (id, input) => { calls.push(`prompt ${id} ${input.mode} ${input.message}`); };
  hub.resumeQueue = async id => { calls.push(`resume ${id}`); };
  await hub.restart("c1", "[check-in] Your last turn failed (429). Re-check the board and continue.");
  assert.deepEqual(calls, ["prompt c1 steer [check-in] Your last turn failed (429). Re-check the board and continue.", "resume c1"]);
  calls.length = 0;
  hub.abort = async id => { calls.push(`abort ${id}`); };
  await hub.restart("t1", "continue", true);
  assert.deepEqual(calls, ["abort t1", "prompt t1 steer continue", "resume t1"], "the way the owner unstuck a session by hand: abort, a steer, resume the queue");
  await hub.close();
});

test("chats: a finished job (reported, done, quiet an hour, no open step) is deleted once, checked at most every 10 min; a job a step keeps stays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = 10_000_000;
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [
    { id: "p1", text: "Build", status: "doing", job: "builder", children: [] },
    { id: "p2", text: "Ship", status: "blocked", waitFor: "reviewer's go on PR 12", children: [] },
    { id: "p3", text: "Audit", status: "done", job: "auditor", children: [] }] };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    source(dir, { c1: board }, () => now), line => lines.push(line));
  await chats.adopt();
  const job = (id: string, name: string, at: number, extra: Partial<ChildAgent> = {}): ChildAgent =>
    ({ id, label: name, sessionName: name, status: "done", repliedSinceTask: true, lastActivityAt: at, ...extra });
  const old = now - 61 * 60_000;
  threads.fire().live("c1", [job("k1", "auditor", old), job("k2", "builder", old), job("k3", "reviewer", old), job("k4", "fresh", now - 10 * 60_000),
    job("k5", "silent", old, { repliedSinceTask: false }), job("k6", "busy", old, { activity: { kind: "writing" } }), job("k7", "nested", old, { parentId: "k1" })]);
  await chats.settled();
  const deletes = async () => { calls.length = 0; await chats.tick(); await chats.settled(); return calls.filter(call => call.startsWith("delete")); };
  assert.deepEqual(await deletes(), ["delete c1 k1"], "only the reported, idle job whose step is done");
  assert.deepEqual(lines.filter(line => line.includes("finished job")), ["chat c1: deleted finished job auditor (reported, quiet 61 min, no open step)"]);
  now += 5 * 60_000;
  assert.deepEqual(await deletes(), [], "not checked again within 10 min");
  now += 6 * 60_000;
  threads.fire().children("c1", [job("k1", "auditor", old), job("k4", "fresh", now - 70 * 60_000)]);
  await chats.settled();
  assert.deepEqual(await deletes(), ["delete c1 k4"], "each job once; a job quiet past the hour goes at the next check");
  chats.close();
});

test("attach queue: background attaches run two at a time in order; a foreground one starts at once and counts; promote starts a waiting one", async () => {
  const queue = new AttachQueue(2);
  const log: string[] = [];
  const gates = new Map<string, () => void>();
  const job = (key: string, background: boolean) => queue.run(key, background, () => new Promise<void>(done => { log.push(key); gates.set(key, done); }));
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  const runs = ["a", "b", "c", "d", "e"].map(key => job(key, true));
  await flush();
  assert.deepEqual(log, ["a", "b"], "two background attaches at a time");
  const tab = job("tab", false);
  await flush();
  assert.deepEqual(log, ["a", "b", "tab"], "a foreground attach does not wait");
  gates.get("a")!();
  await flush();
  assert.deepEqual(log, ["a", "b", "tab"], "the foreground one holds a slot");
  queue.promote("e");
  await flush();
  assert.deepEqual(log, ["a", "b", "tab", "e"], "a tab opening a waiting chat starts it");
  for (const key of ["b", "tab", "e"]) gates.get(key)!();
  await flush();
  assert.deepEqual(log, ["a", "b", "tab", "e", "c", "d"], "the rest in order");
  gates.get("c")!(); gates.get("d")!();
  await Promise.all([...runs, tab]);
});

test("thread hub: after a restart the pinned chats attach two at a time in pin order, an open tab goes first, and a failed attach waits before its retry", async () => {
  let fire: (event: { daemon: string }) => void = () => {};
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: "a-" + id, cwd: "/", lifecycle: "live" }),
    subscribe: (listener: typeof fire) => { fire = listener; return () => {}; } } as unknown as Catalog;
  const hub = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const started: string[] = [];
  const finish = new Map<string, (error?: Error) => void>();
  let running = 0, peak = 0;
  const connection = { subscribe: () => () => {}, dispose: async () => {} };
  const internals = hub as unknown as { attach(id: string): Promise<unknown>; liveSnapshot(): Promise<unknown> };
  internals.attach = id => new Promise((resolve, reject) => {
    started.push(id.slice(2));
    peak = Math.max(peak, ++running);
    finish.set(id.slice(2), error => { running--; if (error) reject(error); else resolve(connection); });
  });
  internals.liveSnapshot = async () => ({ kind: "live", info: {}, messages: [], streaming: null, queue: { steering: [], followUp: [] }, children: [], tools: [], retry: null, runStartedAt: null });
  const flush = () => new Promise(resolve => setTimeout(resolve, 5));
  const chats = ["c1", "c2", "c3", "c4", "c5", "c6"];
  for (const id of chats) assert.ok(hub.pin(id));
  fire({ daemon: "up" });
  await flush();
  assert.deepEqual(started, ["c1", "c2"], "two pins at a time, in pin order");
  const tab = hub.open("c6");
  await flush();
  assert.deepEqual(started, ["c1", "c2", "c6"], "the chat open in a tab does not wait behind the others");
  finish.get("c6")!();
  assert.equal((await tab).live !== null, true);
  finish.get("c1")!();
  await flush();
  assert.deepEqual(started, ["c1", "c2", "c6", "c3"]);
  finish.get("c3")!(new Error("Timed out after 30000ms waiting for the Prime Agent daemon response to \"attach\"."));
  await flush();
  assert.deepEqual(started, ["c1", "c2", "c6", "c3", "c4"]);
  fire({ daemon: "up" });
  await flush();
  assert.equal(started.filter(id => id === "c3").length, 1, "a timed-out pin is not tried again at once");
  for (const id of ["c2", "c4"]) finish.get(id)!();
  await flush();
  finish.get("c5")!();
  await flush();
  assert.equal(peak, 3, "two background attaches plus the tab's");
  assert.deepEqual(chats.map(id => hub.state(id)?.kind ?? "none"), ["live", "live", "none", "live", "live", "live"], "every pin attached but the one waiting for its retry");
  await hub.close();
});

test("thread hub: a session the daemon list calls active but the daemon does not hold opens saved, so a wake reads it as not live", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hub-"));
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "user", content: "build it", timestamp: 1000 });
  manager.flushNow();
  const summary = { sessionId: manager.getSessionId(), activeSessionId: "fa0261485da9", sessionFile: manager.getSessionFile(), cwd: dir };
  const hub = new ThreadHub("/nonexistent.sock", { summary: async () => summary } as unknown as Catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const attached: string[] = [];
  (hub as unknown as { attach(id: string): Promise<never> }).attach = async id => { attached.push(id); throw new Error(`Unknown active session: ${id}`); };
  assert.equal(await hub.view(summary.sessionId), null, "not live: no throw");
  assert.equal((await hub.open(summary.sessionId)).state.messages.length, 1, "the transcript from the session file");
  assert.deepEqual(attached, ["fa0261485da9"], "tried once; the saved thread is kept");
  (hub as unknown as { attach(id: string): Promise<never> }).attach = async () => { throw new Error("Timed out after 30000ms waiting for the Prime Agent daemon response to \"attach\"."); };
  await assert.rejects(hub.open("other"), /Timed out/, "a daemon timeout is still an error");
  await hub.close();
});

test("jobs of a chat work in poteto-mode when the skill is installed, and get nothing extra when it is not", () => {
  const skill = "/home/x/.prime/agent/skills/poteto-mode/SKILL.md";
  const line = jobPersonaGuideline(skill, path => path === skill);
  assert.equal(line, `Work in poteto-mode: read ${skill} before your first step.`);
  assert.equal(jobPersonaGuideline(skill, () => false), null, "no skill installed: no persona line");
});

const SOL = { provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol", input: ["text"], contextWindow: 0, reasoning: true } as ModelInfo;
const OPUS = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", input: ["text"], contextWindow: 0, reasoning: true } as ModelInfo;
const TOKEN_FAILURE = 'Failed to resolve API key for provider "anthropic" from shell command: /Users/sieunpark/.config/pi-pool/bin/pi-pool-token';
const RATE_LIMITED = "Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit.";
async function recoveryChat(claude: { serves: boolean; freeAt: number | null } | null) {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  threads.catalog = { models: [OPUS, SOL], configuredProviders: ["anthropic", "openai-codex"] };
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const clock = { now: 1_000_000_000, claude };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => clock.now), claude: async () => clock.claude }, line => lines.push(line));
  await chats.adopt();
  const info = (model: ModelInfo, extra: Partial<NonNullable<ThreadView["info"]>> = {}) =>
    threads.extras.set("c1", { info: { model, thinkingLevel: "high", availableThinkingLevels: ["low", "high"], retryAttempt: 0, queuedActions: 0, ...extra } });
  const step = async (seconds = 30) => { clock.now += seconds * 1000; calls.length = 0; await chats.tick(); await chats.settled(); return [...calls]; };
  return { chats, threads, calls, lines, clock, info, step };
}

test("chats: a token failure with no usable Claude account waits and retries on the selected model with unchanged effort", async () => {
  const { chats, threads, clock, info, step } = await recoveryChat({ serves: false, freeAt: clockTimeReset });
  info(OPUS);
  threads.transcripts.set("c1", [ownerAsks("what was the response to t5 question???", clock.now), reply("error", clock.now, TOKEN_FAILURE)]);
  assert.deepEqual(await step(10), []);
  assert.deepEqual(threads.waits.get("c1"), { kind: "account", until: clockTimeReset });
  assert.deepEqual(await step(20), [
    `restart c1 [check-in] Your last turn failed at 22:46 (${TOKEN_FAILURE}). The owner's message is still unanswered: "what was the response to t5 question???". Answer it first.`,
  ]);
  assert.deepEqual(threads.extras.get("c1")?.info?.model, OPUS);
  assert.equal(threads.extras.get("c1")?.info?.thinkingLevel, "high");
  chats.close();
});

const clockTimeReset = 1_000_000_000 + 45 * 60_000;

test("chats: 429 waits on the pinned model if no account serves; usable pool and chosen Codex use normal retry", async () => {
  for (const failure of [RATE_LIMITED, TOKEN_FAILURE]) {
    const down = await recoveryChat({ serves: false, freeAt: null });
    down.info(OPUS);
    down.threads.transcripts.set("c1", [ownerAsks("hi", down.clock.now), reply("error", down.clock.now, failure)]);
    assert.deepEqual(await down.step(10), []);
    assert.deepEqual(down.threads.waits.get("c1"), { kind: "account", until: down.clock.now + 20_000 });
    assert.deepEqual(await down.step(20), [`restart c1 [check-in] Your last turn failed at 22:46 (${failure}). The owner's message is still unanswered: "hi". Answer it first.`]);
    assert.deepEqual(down.threads.extras.get("c1")?.info?.model, OPUS);
    assert.equal(down.threads.extras.get("c1")?.info?.thinkingLevel, "high");
    down.chats.close();
  }

  const served = await recoveryChat({ serves: true, freeAt: null });
  served.info(OPUS);
  served.threads.transcripts.set("c1", [ownerAsks("hi", served.clock.now), reply("error", served.clock.now, RATE_LIMITED)]);
  assert.deepEqual(await served.step(10), []);
  assert.deepEqual(served.threads.waits.get("c1"), { kind: "retry", error: RATE_LIMITED, at: served.clock.now + 20_000 });
  assert.equal((await served.step(20))[0]?.startsWith("restart c1"), true);
  served.chats.close();

  const codex = await recoveryChat({ serves: false, freeAt: null });
  codex.info(SOL);
  codex.threads.transcripts.set("c1", [ownerAsks("hi", codex.clock.now), reply("error", codex.clock.now, TOKEN_FAILURE)]);
  assert.deepEqual(await codex.step(10), []);
  assert.deepEqual(codex.threads.waits.get("c1"), { kind: "retry", error: TOKEN_FAILURE, at: codex.clock.now + 20_000 });
  assert.equal((await codex.step(20))[0]?.startsWith("restart c1"), true);
  codex.chats.close();
});

test("chats: a provider no-account error shows account wait even if the pool cannot be read", async () => {
  const { chats, threads, clock, info, step } = await recoveryChat(null);
  info(OPUS);
  threads.transcripts.set("c1", [ownerAsks("hi", clock.now), reply("error", clock.now, "No Claude account")]);
  assert.deepEqual(await step(10), []);
  assert.deepEqual(threads.waits.get("c1"), { kind: "account", until: clock.now + 20_000 });
  assert.deepEqual(await step(20), [`restart c1 [check-in] Your last turn failed at 22:46 (No Claude account). The owner's message is still unanswered: "hi". Answer it first.`]);
  assert.deepEqual(threads.extras.get("c1")?.info?.model, OPUS);
  assert.equal(threads.extras.get("c1")?.info?.thinkingLevel, "high");
  chats.close();
});

test("chats: scheduler never switches the selected model or effort after a failure or recovery", async () => {
  for (const selected of [OPUS, SOL]) {
    const { chats, threads, clock, info, step } = await recoveryChat({ serves: false, freeAt: null });
    info(selected);
    threads.setModel = async () => { throw new Error("scheduled model change"); };
    threads.setThinking = async () => { throw new Error("scheduled effort change"); };
    threads.transcripts.set("c1", [ownerAsks("hi", clock.now), reply("error", clock.now, RATE_LIMITED)]);
    assert.deepEqual(await step(10), []);
    clock.claude = { serves: true, freeAt: null };
    await step(20);
    threads.transcripts.get("c1")!.push(reply("stop", clock.now));
    assert.deepEqual(await step(), []);
    assert.deepEqual(threads.extras.get("c1")?.info?.model, selected);
    assert.equal(threads.extras.get("c1")?.info?.thinkingLevel, "high");
    chats.close();
  }
});

test("chats: a provider retry that holds queued input is aborted and restarted; one with nothing queued is the session's own", async () => {
  const { chats, threads, clock, info, step } = await recoveryChat({ serves: true, freeAt: null });
  threads.transcripts.set("c1", [ownerAsks("[check-in] What changed: p1", clock.now), reply("error", clock.now, "Connection error.")]);
  threads.busyIds.add("c1");
  info(OPUS, { retryAttempt: 3 });
  for (let minute = 0; minute < 10; minute++) assert.deepEqual(await step(60), [], "no queue: the native retry runs");
  info(OPUS, { retryAttempt: 3, queuedActions: 2 });
  threads.extras.get("c1")!.queue = { steering: ["can you use gpt-sol subagents"], followUp: [] };
  assert.deepEqual(await step(), ["restart c1 [check-in] Your last turn failed at 22:46 (Connection error.). Re-check the board and continue. (abort)"],
    "5 min after the failure, the stranded input runs");
  chats.close();
});

test("chats: a step-owner thread whose last turn failed with input queued gets abort, a continue steer and a resumed queue, on the 5, 10, 20 min schedule", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = 1_000_000_000;
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [{ id: "p1", text: "Ship it", status: "doing", job: "thread:t1", children: [] }] };
  const rows = (): SessionRow[] => [{ id: "t1", name: "TPS thread", cwd: "/r", kind: "live", status: "idle", archived: false, messageCount: 9, failure: "429", lastActivityAt: new Date(now - 60_000).toISOString() } as SessionRow];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir, { c1: board }, () => now, rows));
  await chats.adopt();
  threads.transcripts.set("c1", [ownerAsks("go", now), reply("stop", now)]);
  const failed: ThreadView = { messages: [ownerAsks("continue", now - 60_000), reply("error", now - 60_000, "429")], queue: { steering: ["owner: status?"], followUp: [] } };
  threads.views.set("t1", failed);
  const wakes = async () => { calls.length = 0; await chats.checkIn("c1"); await chats.settled(); return calls.filter(call => call.startsWith("restart t1")); };
  assert.deepEqual(await wakes(), ["restart t1 continue (abort)"]);
  now += 60_000;
  assert.deepEqual(await wakes(), [], "not again within 5 min");
  now += 5 * 60_000;
  assert.deepEqual(await wakes(), ["restart t1 continue (abort)"]);
  threads.views.set("t1", { ...failed, queue: { steering: [], followUp: [] } });
  now += 30 * 60_000;
  assert.deepEqual(await wakes(), [], "nothing queued: the check-in line covers it, nothing is stranded");
  chats.close();
});

test("chats: after the owner changes the model or account, a stalled chat restarts now; a plain thread in a provider retry is aborted and resumed", async () => {
  const { chats, threads, clock, info, calls } = await recoveryChat({ serves: true, freeAt: null });
  const lastCalls = () => calls.splice(0);
  info(SOL);
  threads.transcripts.set("c1", [ownerAsks("hi", clock.now), reply("error", clock.now, RATE_LIMITED)]);
  lastCalls();
  await chats.retryNow("c1");
  assert.deepEqual(lastCalls(), [`restart c1 [check-in] Your last turn failed at 22:46 (${RATE_LIMITED}). The owner's message is still unanswered: "hi". Answer it first.`]);
  threads.views.set("t9", { messages: [ownerAsks("hi", 1), reply("error", 2, RATE_LIMITED)], info: { retryAttempt: 2 } });
  threads.busyIds.add("t9");
  await chats.retryNow("t9");
  assert.deepEqual(lastCalls(), ["abort t9", "resume t9"]);
  threads.views.set("t8", { messages: [ownerAsks("hi", 1), reply("stop", 2)] });
  await chats.retryNow("t8");
  assert.deepEqual(lastCalls(), [], "a turn that ended well: nothing to do");
  chats.close();
});

test("chats: the attach clears only the old daemon check-in heartbeat, never a duty heartbeat or the duty runner's [check-in] wake", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of ["d1", "d2", "d3"]) await index.add(id);
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir));
  await chats.adopt();
  threads.heartbeats.set("d1", "Duty: every hour, check the CI queue and post the result on the board.");
  threads.heartbeats.set("d2", "[check-in] Duty d4 is due: crawler health.");
  threads.heartbeats.set("d3", OLD_CHECK_IN + " (chat_board with no ops) and what each job is doing.");
  for (const id of ["d1", "d2", "d3"]) threads.fire().live(id, []);
  await chats.settled();
  assert.deepEqual(calls.filter(call => call.startsWith("heartbeat")), ["heartbeat d3 clear"]);
  chats.close();
});

test("chats: a token-command timeout restarts after 30 s, 1 min, 2 min with an unreadable pool (no account wait or model switch); a wake from sleep restarts at once and starts the schedule over", async () => {
  const { chats, threads, clock, info, step, lines } = await recoveryChat(null);
  info(OPUS);
  threads.transcripts.set("c1", [ownerAsks("[check-in] What changed: p1", clock.now), reply("error", clock.now, TOKEN_FAILURE)]);
  const start = clock.now;
  const restarts: number[] = [];
  for (let half = 0; half < 20; half++) if ((await step()).some(call => call.startsWith("restart c1"))) restarts.push((clock.now - start) / 1000);
  assert.deepEqual(restarts, [30, 90, 210, 510], "30 s, then 1 min, 2 min, 5 min after each restart");
  assert.deepEqual(await step(40 * 60), [`restart c1 [check-in] Your last turn failed at 22:46 (${TOKEN_FAILURE}). Re-check the board and continue.`], "the Mac slept 40 min: at once");
  assert.match(lines.join("\n"), /chats: woke after 2400 s; transient failures restart now/);
  assert.match(lines.join("\n"), /started a new turn, try 1 after a sleep/);
  assert.deepEqual(await step(), [], "the schedule starts over: 1 min after the wake restart");
  assert.equal((await step())[0]?.startsWith("restart c1"), true);
  chats.close();
});

test("chats: the subagents and roots of a chat whose last turn failed transiently get a continue on the fast schedule and at once after a sleep; step owners and plain threads do not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = 1_000_000_000;
  const failedAt = now;
  const agent = (sessionId: string, link: ChatAgent["link"], state: ChatAgent["state"] = "done", at = failedAt): ChatAgent =>
    ({ key: `thread:${sessionId}`, sessionId, name: sessionId, job: sessionId, sender: sessionId, link, state, lastActivityAt: new Date(at).toISOString(), steps: [] });
  let agents: ChatAgent[] = [agent("j1", "subagent"), agent("r1", "root"), agent("t3", "step"), agent("w1", "subagent", "working")];
  let working = false;
  const rows = (): SessionRow[] => [row("c1", new Date(now).toISOString(), { chat: true, working, agents }), row("u1", new Date(now).toISOString())];
  const awake: boolean[] = [];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => now, rows), awake: value => awake.push(value) }, line => lines.push(line));
  await chats.adopt();
  threads.transcripts.set("c1", [ownerAsks("go", now), reply("stop", now)]);
  const views: string[] = [];
  const view = threads.view.bind(threads);
  threads.view = async (id: string) => { views.push(id); return view(id); };
  const failed = (error: string, at: number): ThreadView => ({ messages: [ownerAsks("[task from parent] build it", at - 1), reply("error", at, error)] });
  threads.views.set("j1", failed(TOKEN_FAILURE, failedAt));
  threads.views.set("r1", failed("Connection error.", failedAt));
  threads.views.set("t3", failed(TOKEN_FAILURE, failedAt));
  threads.views.set("u1", failed(TOKEN_FAILURE, failedAt));
  threads.views.set("w1", failed(TOKEN_FAILURE, failedAt));
  const step = async (seconds = 30) => { now += seconds * 1000; calls.length = 0; await chats.tick(); await chats.settled(); return calls.filter(call => call.startsWith("restart")).sort(); };

  assert.deepEqual(await step(10), [], "10 s: wait");
  assert.deepEqual(await step(20), ["restart j1 continue", "restart r1 continue"], "30 s after the failure, with nothing queued");
  threads.views.set("j1", failed(TOKEN_FAILURE, now + 5_000));
  agents = [agent("j1", "subagent", "done", now + 5_000), ...agents.slice(1)];
  assert.deepEqual(await step(), [], "the woken turn failed again: not before 1 min after the last wake; r1 is not woken twice for one failure");
  assert.deepEqual(await step(), ["restart j1 continue"], "1 min after the last wake");
  assert.deepEqual(await step(5 * 60), [], "once per failure");
  views.length = 0;
  threads.views.set("j1", { messages: [ownerAsks("continue", now), reply("stop", now)] });
  agents = [agent("j1", "subagent", "done", now + 1), ...agents.slice(1)];
  await step();
  assert.deepEqual(views.filter(id => id === "j1"), ["j1"], "a changed job is read once");
  await step();
  assert.deepEqual(views.filter(id => id === "j1"), ["j1"], "a quiet job that ended well is not read again");
  threads.views.set("j1", failed(TOKEN_FAILURE, now));
  agents = [agent("j1", "subagent", "done", now), ...agents.slice(1)];
  assert.deepEqual(await step(40 * 60), ["restart j1 continue"], "a new failure found right after a 40 min sleep: at once");
  assert.match(lines.join("\n"), /job j1: last turn failed \(Failed to resolve API key.*\); woke it after a sleep, try 1/);
  assert.equal(calls.some(call => / (t3|u1|w1|c1) /.test(call)), false, "a step owner, a plain thread, a working job and the chat itself are not touched here");
  assert.deepEqual(awake.slice(-1), [true], "a working job keeps the Mac awake");
  agents = agents.filter(entry => entry.state !== "working");
  await step();
  assert.deepEqual(awake.slice(-1), [false]);
  working = true;
  await step();
  assert.deepEqual(awake.slice(-1), [true], "the chat's own turn counts");
  chats.close();
});

test("chats: a job whose session is gone (not in the catalog, or listed active with a session the daemon does not hold) is looked at once, logged once, and not again until it shows new activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = 1_000_000_000;
  const agent = (sessionId: string, at: number): ChatAgent =>
    ({ key: `child:${sessionId}`, sessionId, name: sessionId, job: sessionId, sender: sessionId, link: "subagent", state: "done", lastActivityAt: new Date(at).toISOString(), steps: [] });
  const before = now - 60_000;
  let agents: ChatAgent[] = [agent("deleted", before), agent("stale", before)];
  const rows = (): SessionRow[] => [row("c1", new Date(now).toISOString(), { chat: true, agents })];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    source(dir, {}, () => now, rows), line => lines.push(line));
  await chats.adopt();
  const views: string[] = [];
  threads.view = async (id: string) => {
    views.push(id);
    if (id === "deleted") throw Object.assign(new Error("This thread is not in the Prime Agent catalog."), { status: 404 });
    throw new Error("Unknown active session: fa0261485da9");
  };
  threads.reloadIdle = async () => "saved" as const;
  const step = async () => { now += 30_000; await chats.tick(); await chats.settled(); };
  for (let index = 0; index < 10; index++) await step();
  assert.deepEqual(views.sort(), ["deleted", "stale"], "each gone job is looked at once in ten ticks");
  assert.deepEqual(lines.filter(line => line.startsWith("job ")), [
    "job deleted: gone, not woken again: This thread is not in the Prime Agent catalog.",
    "job stale: gone, not woken again: Unknown active session: fa0261485da9"]);
  agents = [agent("deleted", before), agent("stale", now)];
  await step();
  assert.deepEqual(views.sort(), ["deleted", "stale", "stale"], "new activity: looked at again");
  chats.close();
});

test("chats: a job that ends on a provider error, an abort, a stop mid-tool or the length limit with no report is told to the chat at once as one plain [job] line; once per end, across a restart; a transient failure is woken instead, and a job that reported, a cancelled one and an old end are not told", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = 1_000_000_000;
  const endAt = now;
  const agent = (sessionId: string, sender: string, link: ChatAgent["link"], childId?: string, at = endAt): ChatAgent =>
    ({ key: childId ? `child:${childId}` : `thread:${sessionId}`, sessionId, ...(childId ? { childId } : {}), name: sender, job: sender, sender, link, state: "done",
      lastActivityAt: new Date(at).toISOString(), steps: [] });
  let agents: ChatAgent[] = [agent("j1", "api audit", "subagent", "sub-1"), agent("r1", "root work", "root"), agent("k1", "fixer", "subagent", "sub-k"),
    agent("rep1", "reporter", "subagent", "sub-rep"), agent("can1", "cancelled one", "subagent", "sub-can"), agent("r2", "talker", "root"),
    agent("old1", "old one", "subagent", "sub-old")];
  const rows = (): SessionRow[] => [row("c1", new Date(now).toISOString(), { chat: true, agents }), row("r1", new Date(endAt).toISOString(), { name: "root work", messageCount: 9 })];
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [{ id: "p1", text: "Goal", status: "doing", children: [
    { id: "p2", text: "Build the API", status: "doing", job: "api audit", note: "started 10:00", children: [] },
    { id: "p3", text: "Root work", status: "todo", job: "thread:r1", children: [] }] }] };
  const make = () => new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    source(dir, { c1: board }, () => now, rows), line => lines.push(line));
  let chats = make();
  await chats.adopt();
  const child = (id: string, name: string, extra: Partial<ChildAgent> = {}): ChildAgent =>
    ({ id, label: name, sessionName: name, status: "done", repliedSinceTask: false, lastActivityAt: endAt, ...extra });
  threads.fire().children("c1", [child("sub-1", "api audit"), child("sub-k", "fixer"), child("sub-rep", "reporter", { repliedSinceTask: true }),
    child("sub-can", "cancelled one", { status: "cancelled" }), child("sub-old", "old one")]);
  threads.transcripts.set("c1", [ownerAsks("go", endAt - 9_000),
    { role: "custom", customType: "agent_message", content: "[agent-message from talker]\nhalf done, here is what I have", timestamp: endAt - 1_000 }]);
  const task = (at: number): ThreadMessage => ownerAsks("[task from parent] build it", at);
  const said = (stopReason: "error" | "aborted" | "length" | "toolUse" | "stop", at: number, errorMessage?: string): ThreadMessage =>
    ({ role: "assistant", content: [], provider: "p", model: "m", stopReason, timestamp: at, ...(errorMessage ? { errorMessage } : {}) });
  const quota = "429 rate_limit_error: This request would exceed your account's rate limit. Please try again later.";
  threads.views.set("j1", { messages: [task(endAt - 5_000), said("error", endAt, quota)] });
  threads.views.set("r1", { messages: [task(endAt - 5_000), said("length", endAt)] });
  threads.views.set("k1", { messages: [task(endAt - 5_000), said("error", endAt, TOKEN_FAILURE)] });
  threads.views.set("rep1", { messages: [task(endAt - 5_000), said("aborted", endAt)] });
  threads.views.set("can1", { messages: [task(endAt - 5_000), said("aborted", endAt)] });
  threads.views.set("r2", { messages: [task(endAt - 5_000), said("toolUse", endAt)] });
  threads.views.set("old1", { messages: [task(endAt - 3 * 60 * 60_000), said("toolUse", endAt - 3 * 60 * 60_000)] });
  agents = agents.map(entry => entry.sessionId === "old1" ? agent("old1", "old one", "subagent", "sub-old", endAt - 3 * 60 * 60_000) : entry);
  const step = async (seconds = 30) => { now += seconds * 1000; calls.length = 0; await chats.tick(); await chats.settled(); return calls.filter(call => !call.startsWith("pin") && !call.startsWith("steering")); };
  const apiText = `api audit stopped on a provider error ("${quota}") at ${clockTime(endAt)} and sent no report`;
  const rootText = `root work hit the output length limit at ${clockTime(endAt)} and sent no report`;

  const first = await step();
  assert.deepEqual(first.sort(), [
    "restart k1 continue",
    `steer c1 [job] ${apiText}`,
    `steer c1 [job] ${rootText}`,
  ], "at once, as information: the error and the length limit; the transient failure is woken, not told; the reporter, the cancelled job, the root that wrote since its start and an end 3 h old are not told");
  assert.deepEqual(await step(), [], "once per end");
  assert.deepEqual(Object.keys(await checkInRecord(join(dir, "check-ins.json")).ends("c1")).sort(), ["sub-1", "thread:r1"]);

  threads.views.set("k1", { messages: [task(endAt - 5_000), said("error", endAt, TOKEN_FAILURE), ownerAsks("continue", now), said("stop", now)] });
  agents = agents.map(entry => entry.sessionId === "k1" ? agent("k1", "fixer", "subagent", "sub-k", now) : entry);
  assert.deepEqual(await step(), [], "the wake revived the job and it ended well: no note");

  chats.close();
  chats = make();
  await chats.adopt();
  threads.fire().children("c1", [child("sub-1", "api audit"), child("sub-rep", "reporter", { repliedSinceTask: true }), child("sub-can", "cancelled one", { status: "cancelled" })]);
  assert.deepEqual((await step()).filter(call => call.startsWith("steer")), [], "a service restart does not tell the same ends again");

  threads.views.set("j1", { messages: [task(endAt - 5_000), said("error", endAt, quota), { role: "custom", customType: "agent_message", content: "[agent-message from parent]\ntry again", timestamp: now },
    said("toolUse", now + 1_000)] });
  agents = agents.map(entry => entry.sessionId === "j1" ? agent("j1", "api audit", "subagent", "sub-1", now + 1_000) : entry);
  const again = await step();
  assert.deepEqual(again, [`steer c1 [job] api audit stopped in the middle of a tool call at ${clockTime(now - 29_000)} and sent no report`],
    "a new end after a re-brief is told once more");
  assert.match(lines.join("\n"), /chat c1: job api audit ended \(error\) with no report; told the chat$/m);
  chats.close();
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

test("reply check: kept on disk, so a restart right after a long reply still sends one [reply check], and no later server sends it again (W59, 19:34Z)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("vp");
  const replyAt = 1_000_000;
  let clock = replyAt + 30_000;
  const long = Array.from({ length: 80 }, (_, at) => `word${at}`).join(" ");
  const messages: ThreadMessage[] = [
    { role: "user", content: "youre so far back, push hard", timestamp: replyAt - 60_000 },
    { role: "assistant", content: [{ type: "text", text: long }], stopReason: "stop", timestamp: replyAt } as unknown as ThreadMessage,
  ];
  const start = () => {
    const calls: string[] = [];
    const threads = fakeThreads(calls);
    threads.transcripts.set("vp", messages);
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir, {}, () => clock));
    return { calls, threads, chats, checks: () => calls.filter(call => call.startsWith("steer vp [reply check]")) };
  };
  await loadRecord(join(dir, "extension-loads.json")).set("vp", "b1");
  const first = start();
  await first.chats.adopt();
  first.threads.fire().live("vp", []);
  await first.chats.settled();
  assert.equal(first.checks().length, 1, "a server started 30 s after the reply sends its check when the chat attaches");
  assert.match(first.checks()[0]!, /- 80 words: /);
  first.threads.fire().idle("vp");
  await first.chats.settled();
  assert.equal(first.checks().length, 1, "the turn end after it sends none");
  first.chats.close();
  const second = start();
  await second.chats.adopt();
  second.threads.fire().live("vp", []);
  second.threads.fire().idle("vp");
  await second.chats.settled();
  assert.deepEqual(second.checks(), [], "a second restart on the same data dir sends none");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "reply-checks.json"), "utf8")), { vp: replyAt });
  second.chats.close();

  await index.add("busy");
  const third = start();
  third.threads.transcripts.set("busy", messages);
  third.threads.busyIds.add("busy");
  await third.chats.adopt();
  third.threads.fire().live("busy", []);
  await third.chats.settled();
  assert.deepEqual(third.calls.filter(call => call.startsWith("steer busy")), [], "a chat attached mid-turn waits for its turn end");
  third.threads.busyIds.delete("busy");
  third.threads.fire().idle("busy");
  await third.chats.settled();
  assert.equal(third.calls.filter(call => call.startsWith("steer busy [reply check]")).length, 1);
  third.chats.close();

  await index.add("old");
  clock = replyAt + REPLY_CHECK_MAX_AGE_MS + 1;
  const fourth = start();
  fourth.threads.transcripts.set("old", messages);
  await fourth.chats.adopt();
  fourth.threads.fire().idle("old");
  await fourth.chats.settled();
  assert.deepEqual(fourth.calls.filter(call => call.startsWith("steer old")), [], "a reply over an hour old gets no check");
  assert.equal(await replyCheckRecord(join(dir, "reply-checks.json")).claim("old", replyAt), true, "and is not recorded as checked");
  fourth.chats.close();
});

test("brief check: a new job of a chat whose brief breaks the Jobs rule gets one [brief check] steer, once across restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brief-check-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("vp");
  await loadRecord(join(dir, "extension-loads.json")).set("vp", "b1");
  const sessionFile = join(dir, "sessions", "vp.jsonl");
  const spawn = async (childId: string, prompt: string, createdAt: number) => {
    await mkdir(join(dir, "session-artifacts", "vp", childId), { recursive: true });
    await writeFile(join(dir, "session-artifacts", "vp", childId, "rlm-subagent.json"), JSON.stringify({ type: "rlm_subagent", childId, sessionName: childId, prompt, createdAt }));
  };
  const askAt = 1_791_000_000_000;
  const clock = askAt + 120_000;
  const messages = [
    { role: "user", content: "can you simulate what you send to the agent?", timestamp: askAt },
    { role: "assistant", content: [{ type: "text", text: "on it" }], stopReason: "toolUse", timestamp: askAt + 1_000 },
  ] as unknown as ThreadMessage[];
  await spawn("bad", "Owner's words (verbatim):\n1. \"show me what you send to agents\"\nMy read: audit the briefs.\nDo it.", askAt + 2_000);
  await spawn("good", `Owner's words (verbatim):\n1. 10:00 "can you simulate what you send to the agent?"\nMy read: audit the briefs.\nSplit: inline, two reads.`, askAt + 3_000);
  await spawn("old", "no block", askAt - BRIEF_CHECK_MAX_AGE_MS - 1);
  const job = (id: string): ChildAgent => ({ id, label: id, sessionName: id, status: "running" });
  const start = () => {
    const calls: string[] = [];
    const threads = fakeThreads(calls);
    threads.transcripts.set("vp", messages);
    const chats = new Chats(index, threads, async () => ({ lifecycle: "live", sessionFile }), "b1", loadRecord(join(dir, "extension-loads.json")),
      { ...source(dir, {}, () => clock), briefChecks: briefCheckRecord(join(dir, "brief-checks.json"), () => clock) });
    return { threads, chats, checks: () => calls.filter(call => call.startsWith("steer vp [brief check]")) };
  };
  const first = start();
  await first.chats.adopt();
  first.threads.fire().live("vp", [job("old")]);
  first.threads.fire().children("vp", [job("old"), job("bad"), job("good")]);
  await first.chats.settled();
  assert.equal(first.checks().length, 1, "one steer: the good brief passes and the old job is skipped");
  assert.match(first.checks()[0]!, /^steer vp \[brief check\] Your brief for \[bad\]\(job:bad\) breaks the Jobs rule:\n- "show me what you send to agents" is not in any owner message/);
  assert.match(first.checks()[0]!, /- No `Split:` line\./);
  assert.match(first.checks()[0]!, /receiver_name="bad"/);
  first.threads.fire().children("vp", [job("old"), { ...job("bad"), status: "done" }, job("good")]);
  await first.chats.settled();
  assert.equal(first.checks().length, 1, "a second snapshot sends none");
  first.chats.close();
  const second = start();
  await second.chats.adopt();
  second.threads.fire().live("vp", [job("bad"), job("good")]);
  await second.chats.settled();
  assert.deepEqual(second.checks(), [], "a restart does not send it again");
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(dir, "brief-checks.json"), "utf8"))), ["bad"]);
  second.chats.close();
});
