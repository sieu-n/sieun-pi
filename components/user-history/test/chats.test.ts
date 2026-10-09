import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord, checkInSettings } from "../src/chat-checkin.ts";
import { fallbackRecord } from "../src/chat-fallback.ts";
import { CHAT_BRIEF, Chats, chatGuard, type ChatThreads, chatModeAt, type CheckInSource, createSessionNames, extensionBuild, fileChatName, fileHasChatMarker, hasChatMarker, jobNameLiterals, jobOf, jobRegistry,
  jobPersonaGuideline, jobReplyGuideline, judgeChatCode, loadRecord, OLD_CHECK_IN, reloadAction, TELL_OWNER_LIMIT, tellOwner, type ThreadView, withChatTool } from "../src/chats.ts";
import { SessionManager } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { AttachQueue, ThreadHub } from "../src/chat-threads.ts";
import { isThreadBusy, isTurnRunning } from "../src/shared/thread-state.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatAgent, ChatBoard, ChatWait, ChildAgent, ModelInfo, SessionRow, ThreadMessage, ThreadState } from "../src/shared/types.ts";
import { fileOrigin, ThreadOrigins } from "../src/thread-origin.ts";

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
  ["await rlm.spawn(brief, name='readme-check')", /Name every job and thread you start like the owner names threads/],
  ["await rlm.create_session(brief, name='crawler_ops', cwd='/r')", /No kebab-case, no ids, no numbered suffixes like -2\./],
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
  assert.ok(CHAT_BRIEF.includes("Name every job and thread you start like the owner names threads: a few plain lowercase words with spaces naming the topic (stripe and payments, " +
    "realtime layer, crawler ops, readme check). No kebab-case, no ids, no numbered suffixes like -2."), "the naming line, verbatim");
  assert.match(brief, /Board shape: every goal gets its phases as child steps from the start: Plan \(research or design\), Decide \(only when the owner must choose\), Build, Verify\./);
  assert.match(brief, /including blocked steps nobody works on yet/);
  assert.match(brief, /Link a job on the step it does, not on the goal\./);
  assert.match(brief, /Plan \(doing, job messenger-bridge-research\), Decide \(blocked\), Build \(blocked\), Verify \(todo\)/);
  assert.match(brief, /Corrections stick: when the owner corrects how you work/);
  assert.ok(brief.includes("A goal that is a feature of one app goes under that app's goal as a child, not as a new top-level goal."), "board shape: app features nest");
  assert.ok(brief.includes("A correction changes the brief or a skill, never only a local note: send the owner's exact words to the thread named `realtime layer` with " +
    '`await agent_message.send(..., receiver_role="sibling", receiver_name="realtime layer")` for a brief or code change, or call `await refine.run()` aimed at a global skill or prompt entry. ' +
    "A local memory alone does not count."), "corrections change the brief or a skill");
  assert.ok(CHAT_BRIEF.includes("Never wait on the owner for a choice you can make yourself; a step you own moves every check-in or you start a job for it."), "own steps move");
  assert.ok(CHAT_BRIEF.includes("If the owner says talk first, reply with your proposal and the default you start at the next check-in unless they object; at that check-in, start it."),
    "talk first is a proposal with a default that starts at the next check-in");
  assert.equal(CHAT_BRIEF[1], "Call a feature live only for what you saw on the real screen, and say what you checked.", "live means seen, the item after the first");
  assert.ok(CHAT_BRIEF.some(line => line.startsWith("When a plan step waits on the owner's choice or action, add one short owner todo in For you at once, with 2 to 4 choices and your recommendation first, " +
    "instead of leaving the step blocked with a note.")), "an owner wait is a For you ask");
  assert.match(brief, /receiver_role="sibling", receiver_name="realtime layer"/);
  assert.match(brief, /await refine\.run\(\)/);
  assert.match(brief, /never have to give the same correction twice/);
  assert.match(brief, /A `\[check-in\]` message lists what changed, then every open step with its owner/);
  assert.match(brief, /Your one goal is to drive every board item to done\. Every open step names its owner \(a job, or another thread as `thread:<id>` or its session name\) and its next action; otherwise mark it blocked with the exact thing that unblocks it\. A step that waits on someone else is still yours to chase\. Before you mark a step done, check the real state \(the commit, the live service, the report\), never an old note\./);
  assert.match(brief, /On a `\[check-in\]`, act on every open step, not only the one that changed: start what can start, re-brief, replace or unblock a stuck owner, do or assign the commit, restart or check a step waits on, and if a step truly waits on the owner make sure exactly one owner todo exists for it\. Watching and reporting alone is not progress\./);
  assert.match(brief, /Make the board match reality/);
  assert.match(brief, /send a job only its own plan item, not the whole board/);
  assert.ok(brief.includes("no board ids, commit hashes, model ids or internal names inside sentences, no parenthetical asides"), "replies read straight through (owner 10-08)");
  assert.ok(brief.includes("Write like a text message from a coworker: short, casual, a few lines, spoken style, no report formatting. Never open with a label or a colon lead-in (Live now:, Fixed X:, Update:, Done:); just say it in a normal sentence."), "casual spoken style (owner 10-08)");
  assert.ok(brief.includes("Everything you send another agent (briefs, relays, answers) is in English: after the owner's exact words, say in plain English what they mean and what to do, and translate any Korean."), "relays to agents in English with the meaning (owner 10-08)");
  assert.ok(brief.includes("When you ask the owner to review or pick a UI variant, put the clickable link and one screenshot per variant inline in the chat message itself"), "UI picks show links and screenshots inline (owner 10-09)");
  assert.ok(brief.includes("open it in the owner's Aside browser through the aside-browser skill and complete the Google or GitHub sign-in there. Ask the owner only when no OAuth path works"), "logins through Aside, not owner todos (owner 10-09)");
  assert.ok(brief.includes("No all-caps labels (SECURITY:, URGENT:), no slash-joined names, no repo jargon (origin/main, xoxb, HEAD) when a plain word works."), "plain board notes (owner correction 10-08)");
  // Audit 2026-10-08 (0409-chat-usage-audit): each line names the counter it should lower at the next audit.
  // Stalls and owner corrections: one chase, then a job.
  assert.ok(brief.includes("A stuck owner gets at most one message. If it has not moved by the next check-in, or its last turn ended in an error, replace it with a job in that check-in. " +
    "A takeover you promised for the next check-in is due at that check-in: do it, do not restate it. Never ask the owner to relay a message to another thread."));
  // Wake turns (chat health off_brief, 470 wake turns with text on 10-08): the brief matches the feed, which folds that text as notes.
  assert.ok(brief.includes("On a wake-up the owner did not start, your text is only your notes (the owner sees it folded); reach the owner only through tell_owner. " +
    "If a goal finished, something is blocked or you need a decision, call tell_owner once. Never write 'nothing needs you', 'already handled', or a relay line."));
  assert.doesNotMatch(brief, /end the turn with no text|end with no text/, "the old no-text rule is gone");
  // Replies over 60 words (chat health long_replies, 19 of 21 over 60 words after 22c3ba4): a concrete cap, and longer answers go to an article.
  assert.ok(brief.includes("Owner reply: at most 3 short sentences or 60 words, bullets included; a status answer is one line per goal. If the owner asks you to explain, " +
    "or the answer needs more, write a wiki article page (a job, or a scratch note with a link if one exists) and reply with one or two lines and the link."));
  // Stalled steps (chat health stalls_2h, 24 steps quiet 2 h or more after 7f24e91).
  assert.ok(CHAT_BRIEF.includes("A step stalled 2 h or more must change at this check-in: chase the blocker, start a job, add one owner todo, or set waitUntil/waitFor."));
  assert.match(brief, /`\[job\] <name> ended at <time> with no report` means/);
  assert.ok(CHAT_BRIEF.includes("After you read a job's final report and record it on the board, delete the job with `await rlm.delete_subagent(name)` unless a step keeps it waiting on purpose; finished jobs hold memory."));
  assert.match(brief, /`\[job\] <name> is waiting for you since <time>` or a check-in line `<step> \(job <name>\) waits: "\.\.\."` means the job waits on you/);
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
  assert.equal(jobReplyGuideline({ chat: "chat-ab12", root: false }), 'You are a job of the chat chat-ab12. When you are done, failed or blocked, send it one report with `await agent_message.send(report, receiver_role="parent")`. ' +
    "Send at most one progress message before that. Write the report for a reader: lead with the answer, use ## headers for its parts, a table for numbers, " +
    "and a ```mermaid diagram when there is a flow or structure. If you also wrote a wiki page, link it; the chat shows it next to your report.");
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
    /** Info, queue and retry the hub would hold next to the transcript. */
    extras: new Map<string, Omit<ThreadView, "messages">>(),
    state(id: string): ThreadView | undefined { const messages = transcripts.get(id); return messages ? { messages, ...this.extras.get(id) } : undefined; },
    async restart(id: string, message: string, abort?: boolean) { calls.push(`restart ${id} ${message}${abort ? " (abort)" : ""}`); },
    async abort(id: string) { calls.push(`abort ${id}`); },
    async resumeQueue(id: string) { calls.push(`resume ${id}`); },
    async deleteSubagent(id: string, childId: string) { calls.push(`delete ${id} ${childId}`); },
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

test("chats: a job told as waiting is not told again by the next check-in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const messages: ThreadMessage[] = [];
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [{ id: "p2", text: "Plan", status: "doing", job: "api-audit", children: [] }] };
  let now = 1_000_000;
  const chats = new Chats(index, { ...threads, state: () => ({ messages }) }, async () => ({ lifecycle: "live" }), "b1",
    loadRecord(join(dir, "extension-loads.json")), source(dir, { c1: board }, () => now));
  await chats.adopt();
  const job = (working: boolean): ChildAgent => ({ id: "k1", label: "audit", sessionName: "api-audit", status: "done",
    ...(working ? { activity: { kind: "writing" as const } } : {}), lastActivityAt: 1_000_000, repliedSinceTask: false });
  threads.fire().live("c1", [job(true)]);
  await chats.settled();
  assert.deepEqual(await chats.checkIn("c1"), [], "the first tick takes the baseline: the job works");
  calls.length = 0;
  now += 60_000;
  messages.push({ role: "custom", customType: "agent_message", content: "[agent-message from child:api-audit]\nReady for review, waiting for your go.", timestamp: now });
  threads.fire().children("c1", [job(false)]);
  await new Promise(resolve => setTimeout(resolve, 5));
  await chats.settled();
  assert.deepEqual(calls, ['steer c1 [job] api-audit is waiting for you since 09:17 (last message: "Ready for review, waiting for your go.")']);
  calls.length = 0;
  now += 120_000;
  const lines = await chats.checkIn("c1");
  assert.ok(!lines.some(line => line.includes("api-audit")), `the notice told this end: ${JSON.stringify(lines)}`);
  chats.close();
});

test("chats: a check-in less than 60 s after the last steer waits and joins the next one, at the first wake after the 60 s", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", scratch: [], todos: [], plan: [{ id: "p1", text: "Goal", status: "doing", children: [
    { id: "p2", text: "Plan", status: "doing", job: "api-audit", children: [] }, { id: "p3", text: "Docs", status: "doing", job: "docs", children: [] }] }] };
  let now = 1_000_000;
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir, { c1: board }, () => now));
  await chats.adopt();
  const job = (id: string, name: string, working: boolean): ChildAgent => ({ id, label: name, sessionName: name, status: working ? "running" : "done", lastActivityAt: now, repliedSinceTask: true });
  threads.fire().live("c1", [job("k1", "api-audit", true), job("k2", "docs", true)]);
  await chats.settled();
  await chats.checkIn("c1");
  threads.fire().children("c1", [job("k1", "api-audit", false), job("k2", "docs", true)]);
  now += 60_000;
  assert.deepEqual(await chats.checkIn("c1"), ["p2 (job api-audit) finished; the board still says doing"]);
  threads.fire().children("c1", [job("k1", "api-audit", false), job("k2", "docs", false)]);
  now += 10_000;
  calls.length = 0;
  assert.deepEqual(await chats.checkIn("c1"), [], "10 s after the last steer: it waits");
  now += 30_000;
  assert.deepEqual(await chats.tick(), [], "40 s: still waiting");
  now += 30_000;
  assert.deepEqual(await chats.tick(), ["c1"], "70 s: the waiting check-in runs");
  await chats.settled();
  assert.equal(calls.filter(call => call.startsWith("steer c1 [check-in]")).length, 1);
  assert.match(calls.find(call => call.startsWith("steer c1 [check-in]"))!, /p3 \(job docs\) finished/);
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
  assert.deepEqual(await chats.checkInView("fast"), { everyMs: 900_000, paused: false, nextAt: now + 900_000, pausedUntil: null, lastAt: null }, "default 15 min from the start");
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
  now += 15 * 60_000;
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
  now += 15 * 60_000;
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
  assert.ok(line?.startsWith(`Work in poteto-mode: read ${skill} in full before your first step`), String(line));
  assert.equal(jobPersonaGuideline(skill, () => false), null, "no skill installed: no persona line");
});

const SOL = { provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol", input: ["text"], contextWindow: 0, reasoning: true } as ModelInfo;
const OPUS = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", input: ["text"], contextWindow: 0, reasoning: true } as ModelInfo;
const TOKEN_FAILURE = 'Failed to resolve API key for provider "anthropic" from shell command: /Users/sieunpark/.config/pi-pool/bin/pi-pool-token';
const RATE_LIMITED = "Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit.";
async function fallbackChat(claude: { serves: boolean; freeAt: number | null } | null) {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  threads.catalog = { models: [OPUS, SOL], configuredProviders: ["anthropic", "openai-codex"] };
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  const clock = { now: 1_000_000_000, claude };
  const fallbacks = fallbackRecord(join(dir, "chat-fallbacks.json"));
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => clock.now), claude: async () => clock.claude, fallbacks }, line => lines.push(line));
  await chats.adopt();
  const info = (model: ModelInfo, extra: Partial<NonNullable<ThreadView["info"]>> = {}) =>
    threads.extras.set("c1", { info: { model, thinkingLevel: "high", availableThinkingLevels: ["low", "high"], retryAttempt: 0, queuedActions: 0, ...extra } });
  const step = async (seconds = 30) => { clock.now += seconds * 1000; calls.length = 0; await chats.tick(); await chats.settled(); return [...calls]; };
  return { chats, threads, calls, lines, clock, fallbacks, info, step };
}

test("chats: Claude cannot serve (the pool token failed): the chat moves to GPT-6 Sol at once with its thinking level, one notice, a restart quoting the owner; it moves back between turns once Claude serves", async () => {
  const { chats, threads, clock, fallbacks, info, step, lines } = await fallbackChat({ serves: false, freeAt: null });
  info(OPUS);
  threads.transcripts.set("c1", [ownerAsks("what was the response to t5 question???", clock.now), reply("error", clock.now, TOKEN_FAILURE)]);
  assert.deepEqual(await step(), [
    "model c1 openai-codex/gpt-6-sol",
    "notice c1 Claude has no free account; switched to GPT-6 Sol. I switch back when one frees up.",
    `restart c1 [check-in] Your last turn failed at 22:46 (${TOKEN_FAILURE}). The owner's message is still unanswered: "what was the response to t5 question???". Answer it first.`,
  ], "30 s after the failure, not 5 min");
  assert.deepEqual(await fallbacks.get("c1"), { original: { provider: "anthropic", id: "claude-opus-5-5", thinkingLevel: "high" }, fallback: { provider: "openai-codex", id: "gpt-6-sol" }, at: clock.now });
  assert.match(lines.join("\n"), /Claude cannot serve .*; switched anthropic\/claude-opus-5-5 to openai-codex\/gpt-6-sol/);

  info(SOL, { thinkingLevel: "medium" });
  threads.transcripts.get("c1")!.push(ownerAsks("[check-in] retry", clock.now), reply("stop", clock.now));
  assert.deepEqual(await step(), [], "the chat answered on Sol; Claude still has no account");
  clock.claude = { serves: true, freeAt: null };
  threads.queuedIds.add("c1");
  assert.deepEqual(await step(), [], "mid-turn: wait for the turn to end");
  threads.queuedIds.delete("c1");
  assert.deepEqual(await step(), ["model c1 anthropic/claude-opus-5-5", "thinking c1 high", "notice c1 A Claude account is free again; switched back to Claude Opus 5.5."],
    "back to Opus at the level it had");
  assert.equal(await fallbacks.get("c1"), undefined);
  chats.close();
});

test("chats: the switch keeps the thinking level the new model supports; a 429 switches only when the pool has no usable account; no Codex model: the owner sees the wait", async () => {
  const served = await fallbackChat({ serves: true, freeAt: null });
  served.info(OPUS);
  served.threads.transcripts.set("c1", [ownerAsks("hi", served.clock.now), reply("error", served.clock.now, RATE_LIMITED)]);
  assert.deepEqual(await served.step(), [`restart c1 [check-in] Your last turn failed at 22:46 (${RATE_LIMITED}). The owner's message is still unanswered: "hi". Answer it first.`],
    "another account serves: a plain restart after 30 s");
  served.chats.close();

  const down = await fallbackChat({ serves: false, freeAt: null });
  down.info(OPUS);
  const original = down.threads.setModel.bind(down.threads);
  down.threads.setModel = async (id, provider, modelId) => { await original(id, provider, modelId); down.info(SOL, { thinkingLevel: "low", availableThinkingLevels: ["low", "high"] }); };
  down.threads.transcripts.set("c1", [ownerAsks("hi", down.clock.now), reply("error", down.clock.now, RATE_LIMITED)]);
  assert.deepEqual((await down.step()).slice(0, 2), ["model c1 openai-codex/gpt-6-sol", "thinking c1 high"]);
  down.chats.close();

  const none = await fallbackChat({ serves: false, freeAt: 1_000_000_000 + 45 * 60_000 });
  none.threads.catalog = { models: [OPUS], configuredProviders: ["anthropic"] };
  none.info(OPUS);
  none.threads.transcripts.set("c1", [ownerAsks("hi", none.clock.now), reply("error", none.clock.now, TOKEN_FAILURE)]);
  assert.deepEqual(await none.step(10), []);
  assert.deepEqual(none.threads.waits.get("c1"), { kind: "account", until: 1_000_000_000 + 45 * 60_000 }, "the feed says when an account frees up");
  assert.equal((await none.step(30))[0]?.startsWith("restart c1"), true, "it still tries at 30 s");
  assert.equal(none.threads.waits.get("c1"), null);
  none.chats.close();

  const codex = await fallbackChat({ serves: false, freeAt: null });
  codex.info(SOL);
  codex.threads.transcripts.set("c1", [ownerAsks("hi", codex.clock.now), reply("error", codex.clock.now, TOKEN_FAILURE)]);
  assert.deepEqual(await codex.step(10), [], "the owner picked Codex: never switched");
  assert.deepEqual(codex.threads.waits.get("c1"), { kind: "retry", error: TOKEN_FAILURE, at: codex.clock.now + 20_000 });
  codex.chats.close();
});

test("chats: an owner who moved off the fallback keeps that model; the record is dropped", async () => {
  const { chats, threads, clock, fallbacks, info, step } = await fallbackChat({ serves: false, freeAt: null });
  info(OPUS);
  threads.transcripts.set("c1", [ownerAsks("hi", clock.now), reply("error", clock.now, TOKEN_FAILURE)]);
  await step();
  info({ ...SOL, id: "gpt-6-astra" });
  threads.transcripts.get("c1")!.push(ownerAsks("[check-in] retry", clock.now), reply("stop", clock.now));
  clock.claude = { serves: true, freeAt: null };
  assert.deepEqual(await step(), []);
  assert.equal(await fallbacks.get("c1"), undefined);
  chats.close();
});

test("chats: a provider retry that holds queued input is aborted and restarted; one with nothing queued is the session's own", async () => {
  const { chats, threads, clock, info, step } = await fallbackChat({ serves: true, freeAt: null });
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
  const { chats, threads, clock, info, calls } = await fallbackChat({ serves: true, freeAt: null });
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

test("chats: a token-command timeout restarts after 30 s, 1 min, 2 min with an unreadable pool (no switch to Codex); a wake from sleep restarts at once and starts the schedule over", async () => {
  const { chats, threads, clock, info, step, lines, fallbacks } = await fallbackChat(null);
  info(OPUS);
  threads.transcripts.set("c1", [ownerAsks("[check-in] What changed: p1", clock.now), reply("error", clock.now, TOKEN_FAILURE)]);
  const start = clock.now;
  const restarts: number[] = [];
  for (let half = 0; half < 20; half++) if ((await step()).some(call => call.startsWith("restart c1"))) restarts.push((clock.now - start) / 1000);
  assert.deepEqual(restarts, [30, 90, 210, 510], "30 s, then 1 min, 2 min, 5 min after each restart");
  assert.equal(await fallbacks.get("c1"), undefined, "never switched: the pool could not be read");
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

