import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInRecord } from "../src/chat-checkin.ts";
import { clockTime } from "../src/checkin-settings.ts";
import { CHAT_BRIEF, loadRecord } from "../src/chat-brief.ts";
import { Chats, OLD_CHECK_IN } from "../src/chats.ts";
import { fileHasChatMarker } from "../src/chat-guard.ts";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { inSidebar } from "../src/client/organize.ts";
import { IdIndex } from "../src/id-index.ts";
import type { ChatAgent, ChatBoard, ChildAgent, SessionRow, ThreadMessage } from "../src/shared/types.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { source, fakeThreads, row, ownerAsks, reply, TOKEN_FAILURE } from "./chats-helpers.ts";

// Notice times are the owner's local HH:MM; the expected strings are written for Seoul.
process.env.TZ = "Asia/Seoul";

const child = (status: ChildAgent["status"]): ChildAgent => ({ id: status, label: status, status });

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
  chats.close();
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

test("chats: the scan never takes back a chat archived while it ran or a clean-room test chat; a session whose file ends archived still comes back, and the owner's unarchive still does", async () => {
  // Plan-and-duties run-1 on 10-18: the scan read archived-chats.json, waited on slow session copies from the Mac, and at 14:29:52Z re-adopted
  // the chat the clean-room teardown had archived at 14:28:11Z, which dropped it from archived-chats.json.
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const head = [{ type: "session", id: "c" }, { type: "custom", customType: "chat_mode", data: { v: 1 } }, { type: "message", id: "m" }];
  const jsonl = (entries: object[]) => entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  const files: Record<string, string> = {};
  for (const id of ["slow", "run1", "test", "ended"]) {
    files[id] = join(dir, `${id}.jsonl`);
    await writeFile(files[id]!, jsonl(id === "ended" ? [...head, { type: "session_state", id: "a", state: { status: "archived" } }, { type: "agent_status", id: "b" }] : head));
  }
  const now = Date.parse("2026-10-18T14:28:00Z");
  const rows = ["slow", "run1", "test", "ended"].map(id => row(id, new Date(now - 60_000).toISOString()));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  const archived = new IdIndex(join(dir, "archived-chats.json"), "Archived chat index");
  const cleanRoomChats = new IdIndex(join(dir, "clean-room-chats.json"), "Clean-room chat index");
  await cleanRoomChats.add("test");
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  let release = () => {};
  const copied = new Promise<void>(resolve => { release = resolve; });
  let reached = () => {};
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const summary = async (id: string) => {
    if (id === "slow") { reached(); await copied; }
    return { lifecycle: "live" as const, sessionFile: files[id]! };
  };
  const lines: string[] = [];
  const chats = new Chats(index, threads, summary, "b1", loadRecord(join(dir, "extension-loads.json")),
    { ...source(dir, {}, () => now, () => rows), archived, cleanRoomChats }, line => lines.push(line));
  const scan = chats.rescan();
  await waiting;
  await chats.archive("run1", "owner");
  release();
  assert.deepEqual(await scan, ["slow", "ended"], "an archived session_state comes from the daemon's eviction or the Mac copy too, so it is no owner archive");
  assert.deepEqual(await archived.ids(), ["run1"], "the owner's archive stands");
  assert.deepEqual((await index.ids()).sort(), ["ended", "slow"]);
  for (const id of ["run1", "test"]) assert.equal(calls.some(call => call === `pin ${id}` || call.startsWith(`steering ${id}`)), false, `${id} is not pinned or steered`);
  assert.match(lines.join("\n"), /chat run1: not re-adopted: the owner archived it/);

  assert.equal(await chats.restore("run1"), true, "the owner's unarchive takes it back");
  assert.deepEqual(await archived.ids(), []);
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
  await chats.archive("stripe", "owner");
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

test("chats: a finished job (reported, done, its report in the chat, no open step) is deleted once at the first check; a job a step keeps stays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const calls: string[] = [];
  const lines: string[] = [];
  const threads = fakeThreads(calls);
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  let now = 10_000_000;
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [
    { id: "p1", text: "Build", status: "doing", job: "builder", children: [] },
    { id: "p2", text: "Ship", status: "blocked", waitFor: "reviewer's go on PR 12", children: [] },
    { id: "p3", text: "Audit", status: "done", job: "auditor", children: [] }] };
  const chats = new Chats(index, threads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")),
    source(dir, { c1: board }, () => now), line => lines.push(line));
  await chats.adopt();
  const job = (id: string, name: string, at: number, extra: Partial<ChildAgent> = {}): ChildAgent =>
    ({ id, label: name, sessionName: name, status: "done", repliedSinceTask: true, lastActivityAt: at, ...extra });
  const old = now - 61 * 60_000;
  threads.transcripts.set("c1", ["auditor", "builder", "reviewer", "fresh", "silent", "busy", "nested"].map(name =>
    ({ role: "custom", customType: "agent_message", content: `[agent-message from child:${name}]\nDone.`, display: true, timestamp: old }) as ThreadMessage));
  threads.fire().live("c1", [job("k1", "auditor", old), job("k2", "builder", old), job("k3", "reviewer", old), job("k4", "fresh", now - 10 * 60_000),
    job("k5", "silent", old, { repliedSinceTask: false }), job("k6", "busy", old, { activity: { kind: "writing" } }), job("k7", "nested", old, { parentId: "k1" })]);
  await chats.settled();
  const deletes = async () => { calls.length = 0; await chats.tick(); await chats.settled(); return calls.filter(call => call.startsWith("delete")); };
  assert.deepEqual(await deletes(), ["delete c1 k1", "delete c1 k4"], "the reported, idle jobs no open step names, however long they have been quiet");
  assert.deepEqual(lines.filter(line => line.includes("finished job")), ["chat c1: deleted finished job auditor (reported, quiet 61 min, no open step)",
    "chat c1: deleted finished job fresh (reported, quiet 10 min, no open step)"]);
  now += 5 * 60_000;
  assert.deepEqual(await deletes(), [], "not checked again within 10 min");
  now += 6 * 60_000;
  assert.deepEqual(await deletes(), [], "each job once");
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
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: "", todos: [], plan: [{ id: "p1", text: "Goal", status: "doing", children: [
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
  const apiText = `api audit stopped on a provider error (rate limit 429) at ${clockTime(endAt)} and sent no report`;
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

test("chat brief: a task's owner comes from the owner's own message, progress counts done checks, answers are plain (c150, c151, c152)", () => {
  const line = (id: string) => CHAT_BRIEF.find(entry => entry.includes(`(${id})`)) ?? "";
  assert.match(line("c150"), /find his own message that gave it to them/);
  assert.match(line("c150"), /that it is not confirmed/);
  assert.match(line("c150"), /A board step, parked or not, a handover note or a job name is no proof/);
  assert.match(line("c151"), /give done over total, the scope/);
  assert.match(line("c151"), /activity, commits and tokens are not progress/);
  assert.match(line("c152"), /Lead with no metric label he did not ask about/);
  assert.match(line("c153"), /led by an aggregate measurement and its scope/);
  assert.match(line("c153"), /never by one observation or one complaint/);
  assert.match(line("c153"), /one or two sentences of at most 25 words each/);
  assert.match(line("c18"), /best as one dry, plain sentence and at most 2/);
  assert.match(line("c172"), /plain, normal measure/);
  assert.match(line("c172"), /never propose or ask in For you about a bespoke counting rule, baseline or exception/);
  assert.match(line("c18"), /each of at most 25 words with one fact or ask/);
  assert.match(line("c18"), /the rest stays on the board, named by the ids of the steps that hold it, or on a wiki page a job writes/);
  assert.match(line("c132"), /lead with one real example: a saved row with its actual field values/);
  assert.match(line("c155"), /show the real code path, each buffer and each wait point/);
  assert.match(line("c157"), /never call a large cached volume waste/);
  assert.match(line("c157"), /In a cost estimate for model calls, price the shared system prompt and instructions at each model's cache-read rate/);
  assert.match(line("c162"), /answer every part of his original request/);
  assert.match(line("c162"), /never swap in a telemetry redesign, an experimental program or a question about which metric/);
  assert.match(line("c153"), /End that tell_owner at the number or at the missing baseline; the job you started, the next step, a question or a link goes in a second tell_owner/);
});
