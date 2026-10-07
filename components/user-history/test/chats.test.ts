import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHECK_IN, CHECK_IN_SCHEDULE, Chats, chatGuard, type ChatThreads, chatModeAt, checkInAction, checkInWanted, extensionBuild, fileHasChatMarker, hasChatMarker, judgeChatCode, loadRecord, reloadAction, TELL_OWNER_LIMIT, tellOwner, withChatTool } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChildAgent } from "../src/shared/types.ts";
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

test("check-in: wanted only while a job runs or waits; the update is the step from the known state, nothing when already there", () => {
  assert.equal(checkInWanted([]), false);
  assert.equal(checkInWanted([child("done"), child("error"), child("cancelled")]), false);
  assert.equal(checkInWanted([child("done"), child("running")]), true);
  assert.equal(checkInWanted([child("queued")]), true);
  assert.equal(checkInAction(undefined, true), "resume", "after an attach the daemon state is unknown: send it");
  assert.equal(checkInAction(undefined, false), "pause");
  assert.equal(checkInAction("active", true), null);
  assert.equal(checkInAction("active", false), "pause");
  assert.equal(checkInAction("paused", false), null);
  assert.equal(checkInAction("paused", true), "resume");
});

type Observer = Parameters<ChatThreads["observe"]>[0];
function fakeThreads(calls: string[], pinLimit = 8) {
  let observer: Observer | undefined;
  let next = 1;
  const pinned = new Set<string>();
  const busyIds = new Set<string>();
  return {
    pinned,
    busyIds,
    fire: () => observer!,
    busy(id: string) { return busyIds.has(id); },
    async reload(id: string) { calls.push(`reload ${id}`); },
    async create(input: { cwd: string; name: string; kind: "chat"; thinkingLevel?: string }) { calls.push(`create ${input.kind} ${input.name} ${input.cwd}`); return { id: `s${next++}` }; },
    pin(id: string) { if (!pinned.has(id) && pinned.size >= pinLimit) return false; calls.push(`pin ${id}`); pinned.add(id); return true; },
    unpin(id: string) { calls.push(`unpin ${id}`); pinned.delete(id); },
    async setSteeringMode(id: string, mode: string) { calls.push(`steering ${id} ${mode}`); },
    async setHeartbeat(id: string, schedule: string, instruction: string, mode: string) { calls.push(`heartbeat ${id} ${schedule} ${mode} ${instruction === CHECK_IN ? "check-in" : "?"}`); },
    async updateHeartbeat(id: string, action: string) { calls.push(`heartbeat ${id} ${action}`); },
    observe(next: Observer) { observer = next; return () => { observer = undefined; }; },
  };
}

test("chats: create names, indexes, pins, sets steering all and a paused check-in; children toggle it; an attach re-applies steering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  const loads = loadRecord(join(dir, "extension-loads.json"));
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loads);
  const created = await chats.create({ cwd: "/repo", name: "  " });
  assert.equal(await loads.get("s1"), "b1", "a new chat loaded the build on disk");
  assert.equal(created.id, "s1");
  assert.match(created.name, /^chat-[0-9a-f]{4}$/, "a blank name becomes a generated one");
  assert.deepEqual(calls, [`create chat ${created.name} /repo`, "pin s1", "steering s1 all", `heartbeat s1 ${CHECK_IN_SCHEDULE} follow_up check-in`, "heartbeat s1 pause"]);
  assert.deepEqual(await index.ids(), ["s1"]);
  assert.deepEqual([...await chats.ids()], ["s1"]);
  assert.equal((await chats.create({ cwd: "/repo", name: "Feature X" })).name, "Feature X");

  calls.length = 0;
  threads.fire().children("s1", [child("queued")]);
  await chats.settled();
  assert.deepEqual(calls, ["heartbeat s1 resume"]);
  calls.length = 0;
  threads.fire().children("s1", [child("running")]);
  threads.fire().children("s1", [child("done")]);
  await chats.settled();
  assert.deepEqual(calls, ["heartbeat s1 pause"], "running after queued is no change; done pauses");
  calls.length = 0;
  threads.fire().children("s1", [child("running")]);
  threads.fire().children("s1", [child("done")]);
  await chats.settled();
  assert.deepEqual(calls, [], "each sync reads the newest children, so a burst that ends where it started sends nothing");

  calls.length = 0;
  threads.fire().live("s1", [child("done")]);
  await chats.settled();
  assert.deepEqual(calls, ["steering s1 all", "heartbeat s1 pause"], "after a re-create the runtime state is unknown: steering and the pause are sent again; the build matches, no reload");
  calls.length = 0;
  threads.fire().live("s2", [child("running")]);
  await chats.settled();
  assert.deepEqual(calls, ["steering s2 all", "heartbeat s2 resume"]);
  calls.length = 0;
  threads.fire().live("other", [child("running")]);
  threads.fire().children("other", []);
  await chats.settled();
  assert.deepEqual(calls, [], "a plain thread is not touched");

  calls.length = 0;
  await chats.forget("s1");
  assert.deepEqual(calls, ["unpin s1"]);
  assert.deepEqual(await index.ids(), ["s2"]);
  threads.fire().children("s1", [child("running")]);
  await chats.settled();
  assert.deepEqual(calls, ["unpin s1"], "a forgotten chat gets no heartbeat updates");
  chats.close();
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
  }, "b1", loads);
  assert.deepEqual(await chats.adopt(), { pinned: ["live", "down"], forgotten: ["archived", "gone"] }, "newest first, as the index lists them");
  assert.deepEqual(calls, ["pin live", "pin down", "unpin archived", "unpin gone"]);
  assert.deepEqual(await index.ids(), ["live", "down"]);
  const lines: string[] = [];
  const full = new Chats(index, fakeThreads([], 0), async () => ({ lifecycle: "live" }), "b1", loads, line => lines.push(line));
  assert.deepEqual(await full.adopt(), { pinned: [], forgotten: [] });
  assert.equal(lines.length, 2, "the live limit is logged, not thrown");
  chats.close(); full.close();
});

test("chats: undo after archive brings a chat back as a chat (index, pin, steering, check-in from its children); a plain thread stays plain", async () => {
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
  const chats = new Chats(index, threads, async id => files[id] ? { lifecycle: "live", sessionFile: files[id] } : undefined, "b1", loadRecord(join(dir, "extension-loads.json")));
  await chats.forget("chat1");
  assert.deepEqual(await index.ids(), []);
  calls.length = 0;
  threads.fire().children("chat1", [child("running")]);
  assert.equal(await chats.restore("chat1"), true);
  await chats.settled();
  assert.deepEqual(calls, ["pin chat1", "steering chat1 all", `heartbeat chat1 ${CHECK_IN_SCHEDULE} follow_up check-in`, "heartbeat chat1 resume"],
    "a job still runs, so the check-in resumes");
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
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b2", loads);
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
