import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord, checkInSettings } from "../src/chat-checkin.ts";
import { CHAT_BRIEF, Chats, chatGuard, type ChatThreads, chatModeAt, type CheckInSource, createSessionNames, extensionBuild, fileChatName, fileHasChatMarker, hasChatMarker, jobOf, jobRegistry,
  jobReplyGuideline, judgeChatCode, loadRecord, OLD_CHECK_IN, reloadAction, TELL_OWNER_LIMIT, tellOwner, withChatTool } from "../src/chats.ts";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { isThreadBusy, isTurnRunning } from "../src/shared/thread-state.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatBoard, ChildAgent, SessionRow, ThreadMessage, ThreadState } from "../src/shared/types.ts";
import { fileOrigin, ThreadOrigins } from "../src/thread-origin.ts";

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
  "handle = await rlm.spawn(brief, name='readme-lines')",
  'await rlm.create_session(brief, name="readme-lines", cwd="/Users/sieunpark/Documents/Github/auto-sns-agent")',
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

test("tell_owner takes up to the limit and refuses longer or empty text", () => {
  assert.deepEqual(tellOwner("The audit is done; nothing failed."), { ok: true, text: "told the owner" });
  assert.deepEqual(tellOwner("x".repeat(TELL_OWNER_LIMIT)), { ok: true, text: "told the owner" });
  assert.deepEqual(tellOwner("x".repeat(TELL_OWNER_LIMIT + 1)), { ok: false, text: "shorter: one or two sentences" });
  assert.equal(tellOwner("   ").ok, false);
  assert.equal(tellOwner(undefined).ok, false);
});

const child = (status: ChildAgent["status"]): ChildAgent => ({ id: status, label: status, status });

test("brief: the board shape and corrections-stick bullets, and the check-in bullet that reads the server digest", () => {
  const brief = CHAT_BRIEF.join("\n");
  assert.match(brief, /Board shape: every goal gets its phases as child steps from the start: Plan \(research or design\), Decide \(only when the owner must choose\), Build, Verify\./);
  assert.match(brief, /including blocked steps nobody works on yet/);
  assert.match(brief, /Link a job on the step it does, not on the goal\./);
  assert.match(brief, /Plan \(doing, job messenger-bridge-research\), Decide \(blocked\), Build \(blocked\), Verify \(todo\)/);
  assert.match(brief, /Corrections stick: when the owner corrects how you work/);
  assert.match(brief, /receiver_role="sibling", receiver_name="realtime layer"/);
  assert.match(brief, /await refine\.run\(\)/);
  assert.match(brief, /never have to give the same correction twice/);
  assert.match(brief, /A `\[check-in\]` message lists what changed, then every open step with its owner/);
  assert.match(brief, /Your one goal is to drive every board item to done\. Every open step names its owner \(a job, or another thread as `thread:<id>` or its session name\) and its next action; otherwise mark it blocked with the exact thing that unblocks it\. A step that waits on someone else is still yours to chase\. Before you mark a step done, check the real state \(the commit, the live service, the report\), never an old note\./);
  assert.match(brief, /On a `\[check-in\]`, act on every open step, not only the one that changed: start what can start, re-brief, replace or unblock a stuck owner, do or assign the commit, restart or check a step waits on, and if a step truly waits on the owner make sure exactly one owner todo exists for it\. Watching and reporting alone is not progress\./);
  assert.match(brief, /Make the board match reality/);
  assert.match(brief, /send a job only its own plan item, not the whole board/);
  assert.match(brief, /Refer to board items by their id \(p7, s3\); the page turns them into links\./);
  // Audit 2026-10-08 (0409-chat-usage-audit): each line names the counter it should lower at the next audit.
  // Stalls and owner corrections: one chase, then a job.
  assert.ok(brief.includes("A stuck owner gets at most one message. If it has not moved by the next check-in, or its last turn ended in an error, replace it with a job in that check-in. " +
    "A takeover you promised for the next check-in is due at that check-in: do it, do not restate it. Never ask the owner to relay a message to another thread."));
  // Plain text on non-owner wakes, tell_owner repeats and relay lines (the job notices counter's noise).
  assert.ok(brief.includes("On any wake-up that is not an owner message, end the turn with no text. If a goal finished, something is blocked or you need a decision, call tell_owner once " +
    "and then end with no text. Never write 'nothing needs you', 'already handled', or a relay line."));
  // Replies over 60 words.
  assert.ok(brief.includes("Owner replies: at most 60 words including bullets; a status answer is one line per goal."));
  assert.doesNotMatch(brief, /15 to 60 words/, "the old count, which bullets slipped past, is gone");
  assert.doesNotMatch(brief, /—/, "no em dashes");
});

test("job reply: a direct subagent of a chat and a root the chat started get the guideline; nothing else does", async () => {
  assert.deepEqual(jobOf({ depth: 1, marked: false, parentChat: "chat-ab12" }), { chat: "chat-ab12", root: false });
  assert.deepEqual(jobOf({ depth: 1, marked: false, parentChat: "" }), { chat: "", root: false }, "a chat with no name still gets the guideline");
  assert.equal(jobOf({ depth: 1, marked: false, parentChat: null }), null, "the parent is a plain thread");
  assert.equal(jobOf({ depth: 2, marked: false, parentChat: "chat-ab12" }), null, "a job's own subagent reports to the job");
  assert.deepEqual(jobOf({ depth: 0, marked: false, registered: "Feature X" }), { chat: "Feature X", root: true });
  assert.equal(jobOf({ depth: 0, marked: true, registered: "Feature X" }), null, "a chat is never a job");
  assert.equal(jobOf({ depth: 0, marked: false, registered: undefined }), null);
  assert.match(jobReplyGuideline({ chat: "chat-ab12", root: false }), /^You are a job of the chat chat-ab12\. When you are done, failed or blocked, send it one report with `await agent_message\.send\(report, receiver_role="parent"\)`\. Send at most one progress message before that\.$/);
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

  const lines = (entries: object[]) => entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  const chatFile = join(dir, "chat.jsonl");
  const plainFile = join(dir, "plain.jsonl");
  await writeFile(chatFile, lines([{ type: "session", id: "c" }, { type: "session_info", id: "i", name: "chat-ab12" }, { type: "session_state", id: "s" },
    { type: "custom", customType: "chat_mode", data: { v: 1 } }, { type: "session_info", id: "j", name: "renamed later" }]));
  await writeFile(plainFile, lines([{ type: "session", id: "p" }, { type: "session_info", id: "i", name: "plain" }]));
  assert.equal(await fileChatName(chatFile), "chat-ab12");
  assert.equal(await fileChatName(plainFile), null);
  assert.equal(await fileChatName(join(dir, "missing.jsonl")), null);
});

type Observer = Parameters<ChatThreads["observe"]>[0];
/** A check-in source with no timer: an empty board unless one is given, no catalog rows, and its memory in `dir`. */
function source(dir: string, boards: Record<string, ChatBoard> = {}, now = () => 0, rows: () => SessionRow[] = () => []): CheckInSource {
  return { board: async id => boards[id] ?? null, rows: async () => rows(), memory: checkInRecord(join(dir, "check-ins.json")),
    settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0, now, noReportGraceMs: 0 };
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
    state(id: string) { const messages = transcripts.get(id); return messages ? { messages } : undefined; },
    async restart(id: string, message: string) { calls.push(`restart ${id} ${message}`); },
    fire: () => observer!,
    busy(id: string) { return busyIds.has(id) || queuedIds.has(id); },
    running(id: string) { return busyIds.has(id); },
    async reload(id: string) { calls.push(`reload ${id}`); },
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

test("chats: a job that goes quiet with no message is told once per end, after the grace; a job that asked is waiting; a report, a first task, a deleted or cancelled job and a plain thread get nothing", async () => {
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
  assert.deepEqual(calls, ["steer c1 [job] api-audit ended with no report"], "flicker within one end is one line");
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
  assert.deepEqual(calls, ['steer c1 [job] api-audit is waiting for you (last message: "Two questions before I go on: keep the old route?")'], "it asked: waiting, not dead");
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

test("chats: the check-in tick steers only what changed, stays quiet with no change, and pauses with no job and no open step", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [{ id: "p1", text: "Reach chats from Slack", status: "doing", children: [
    { id: "p2", text: "Plan", status: "doing", job: "api-audit", children: [] }, { id: "p3", text: "Build", status: "blocked", children: [] }] }] };
  let now = 1_000_000;
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir, { c1: board }, () => now));
  await chats.adopt();
  const job = (working: boolean): ChildAgent => ({ id: "k1", label: "audit", sessionName: "api-audit", status: working ? "running" : "done", lastActivityAt: now, repliedSinceTask: true });
  threads.fire().live("c1", [job(true)]);
  await chats.settled();
  calls.length = 0;
  assert.deepEqual(await chats.checkIn("c1"), [], "the first tick only takes the baseline");
  now += 60_000;
  assert.deepEqual(await chats.checkIn("c1"), [], "no change, no steer");
  threads.fire().children("c1", [job(false)]);
  await chats.settled();
  now += 60_000;
  const lines = await chats.checkIn("c1");
  assert.deepEqual(lines, ["p2 (job api-audit) finished; the board still says doing"]);
  assert.deepEqual(calls, ["steer c1 [check-in] What changed:\n- p2 (job api-audit) finished; the board still says doing\n\nOpen steps, oldest change first:\n" +
    '- p2 "Plan" doing, owner job api-audit (idle), last change 2 min ago\n- p3 "Build" blocked, no owner, last change 2 min ago'], "the goal p1 has open steps below it and is not listed");
  calls.length = 0;
  assert.deepEqual(await chats.checkIn("c1"), [], "reported once");
  board.plan = [{ ...board.plan[0]!, status: "done", children: board.plan[0]!.children.map(step => ({ ...step, status: "done" as const })) }];
  assert.deepEqual(await chats.checkIn("c1"), [], "no job at work and no open step: paused");
  assert.deepEqual(calls, []);
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
  assert.equal(await chats.setCheckIn("plain", { everyMs: 60_000 }), null);
  assert.deepEqual(await chats.checkInView("fast"), { everyMs: 300_000, paused: false, nextAt: now + 300_000, pausedUntil: null, lastAt: null }, "default 5 min from the start");
  await chats.setCheckIn("fast", { everyMs: 60_000 });
  await chats.setCheckIn("slow", { everyMs: 15 * 60_000 });
  const ran: Record<string, number> = { fast: 0, slow: 0 };
  for (let second = 30; second <= 30 * 60; second += 30) {
    now += 30_000;
    for (const id of await chats.tick()) ran[id]!++;
  }
  assert.deepEqual(ran, { fast: 30, slow: 2 }, "30 min: every 1 min and every 15 min");
  await chats.settled();
  assert.equal((await chats.checkInView("fast"))?.lastAt, now);

  await chats.setCheckIn("fast", { everyMs: 5 * 60_000 });
  const before = now;
  let fast = 0;
  for (let second = 30; second <= 10 * 60; second += 30) { now += 30_000; if ((await chats.tick()).includes("fast")) fast++; }
  assert.equal(fast, 2, "the new interval applies at the next wake");
  assert.equal((await chats.checkInView("fast"))?.lastAt, before + 10 * 60_000);

  const long = await chats.setCheckIn("slow", { pause: "1h" });
  assert.deepEqual([long?.pausedUntil, long?.nextAt], [now + 3_600_000, now + 3_600_000], "the pause end, then the run it allows");
  await chats.setCheckIn("slow", { pause: null });
  const paused = await chats.setCheckIn("fast", { pause: "1h" });
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

  await chats.setCheckIn("fast", { pause: "forever" });
  now += 24 * 3_600_000;
  assert.equal((await chats.tick()).includes("fast"), false, "paused until resumed");
  assert.deepEqual(await chats.checkIns(), new Map([["slow", { everyMs: 900_000, paused: false, pausedUntil: null, nextAt: (await chats.checkInView("slow"))!.nextAt }],
    ["fast", { everyMs: 300_000, paused: true, pausedUntil: "forever", nextAt: null }]]));
  await chats.settled();
  chats.close();

  const again = new Chats(index, fakeThreads(calls), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir, {}, () => now));
  assert.deepEqual(await again.checkInView("fast"), { everyMs: 300_000, paused: true, nextAt: null, pausedUntil: "forever", lastAt: null }, "the setting survives a restart");
  const resumed = await again.setCheckIn("fast", { pause: null });
  assert.deepEqual(resumed, { everyMs: 300_000, paused: false, nextAt: now + 300_000, pausedUntil: null, lastAt: null }, "resume keeps the interval");
  now += 300_000;
  assert.deepEqual(await again.tick(), ["fast"], "the slow chat waits 15 min after the restart, the resumed one 5");
  await again.settled();
  again.close();
});

test("chats: adopt pins what the daemon still lists, forgets archived and missing, keeps an unknown one while the daemon is down", async () => {
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
  assert.deepEqual(await chats.adopt(), { pinned: ["live", "down"], forgotten: ["archived", "gone"], adopted: [] }, "newest first, as the index lists them");
  assert.deepEqual(calls, ["pin live", "pin down", "unpin archived", "unpin gone"]);
  assert.deepEqual(await index.ids(), ["live", "down"]);
  const lines: string[] = [];
  const full = new Chats(index, fakeThreads([], 0), async () => ({ lifecycle: "live" }), "b1", loads, source(dir), line => lines.push(line));
  assert.deepEqual(await full.adopt(), { pinned: [], forgotten: [], adopted: [] });
  assert.equal(lines.length, 2, "the live limit is logged, not thrown");
  chats.close(); full.close();
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

test("chats: a chat whose last turn failed gets a new turn 5, 10, then every 20 min, even with nothing open; a good turn resets; a busy or paused chat waits; no check-in or notice queues behind it", async () => {
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
  threads.transcripts.set("c1", [ownerAsks("write the article", now), reply("error", now, "Provider rate limit exceeded (rate_limit_error, 429)")]);
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
  assert.equal(calls.find(call => call.startsWith("restart")), "restart c1 [check-in] Your last turn failed (Provider rate limit exceeded (rate_limit_error, 429)). Re-check the board and continue.");
  assert.deepEqual(calls.filter(call => call.startsWith("steer")), [], "no check-in steer queues into the failed chat");
  assert.match(lines.join("\n"), /chat c1: last turn failed \(Provider rate limit exceeded \(rate_limit_error, 429\)\); started a new turn, try 4/);

  const withBoard = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, { c1: board }, () => now), memory }, line => lines.push(line));
  assert.deepEqual(await withBoard.checkIn("c1"), [], "the digest waits for the restart");
  assert.equal(await memory.get("c1"), undefined, "its memory is not moved, so the changes are told after the restart");
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
  await chats.setCheckIn("c1", { pause: "forever" });
  restarted.length = 0;
  await run(60);
  assert.deepEqual(restarted, [], "the owner paused the chat");
  chats.close();
});

test("chats: a check-in waits while an owner turn runs and goes at the first wake after it; an agent turn does not hold it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = 1_000_000_000;
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [{ id: "p1", text: "Goal", status: "doing", children: [] }] };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir, { c1: board }, () => now));
  await chats.adopt();
  threads.transcripts.set("c1", [ownerAsks("hows this doing?", now)]);
  threads.busyIds.add("c1");
  now += 5 * 60_000;
  assert.deepEqual(await chats.tick(), [], "the owner's turn runs: held");
  assert.deepEqual(await chats.checkIn("c1"), [], "a direct call is held too");
  now += 30_000;
  assert.deepEqual(await chats.tick(), [], "still held");
  threads.busyIds.delete("c1");
  threads.transcripts.get("c1")!.push(reply("stop", now));
  now += 30_000;
  assert.deepEqual(await chats.tick(), ["c1"], "the turn ended: the held check-in goes at the next wake, not a whole interval later");
  await chats.settled();
  threads.transcripts.get("c1")!.push(ownerAsks("[check-in] What changed:\n- p1 ...", now));
  threads.busyIds.add("c1");
  now += 5 * 60_000;
  assert.deepEqual(await chats.tick(), ["c1"], "a turn a check-in started does not hold the next one");
  await chats.settled();
  chats.close();
});

test("chats: a board the server cannot read is a check-in line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const lines: string[] = [];
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir), board: async () => { throw new Error("Chat board file is malformed."); } }, line => lines.push(line));
  await chats.adopt();
  assert.deepEqual(await chats.checkIn("c1"), ["the board cannot be read: Chat board file is malformed.; call chat_board again"], "with no job and no step it still runs");
  assert.deepEqual(calls.filter(call => call.startsWith("steer")), ["steer c1 [check-in] What changed:\n- the board cannot be read: Chat board file is malformed.; call chat_board again"]);
  assert.deepEqual(await chats.checkIn("c1"), [], "once per error");
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
  await hub.close();
});
