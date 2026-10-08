import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatBackend } from "../src/chat-backend.ts";
import { checkInRecord, checkInSettings } from "../src/chat-checkin.ts";
import { startChatServer } from "../src/chat-server.ts";
import { BRIEF_NOTE_CHARS, briefChanges, briefNote, CHAT_BRIEF, chatBrief, Chats, type ChatThreads, type CheckInSource, loadRecord, reloadAction } from "../src/chats.ts";
import { briefRows, briefStatus, currentBrief } from "../src/client/brief.ts";
import { IdIndex } from "../src/id-index.ts";
import type { SessionRow } from "../src/shared/types.ts";

type Observer = Parameters<ChatThreads["observe"]>[0];
const source = (dir: string): CheckInSource => ({ board: async () => null, rows: async () => [], memory: checkInRecord(join(dir, "check-ins.json")),
  settings: checkInSettings(join(dir, "check-in-settings.json")), tickMs: 0 });
/** The hub calls a reload touches: reload, notice and every way to start a turn, logged in order. */
function fakeThreads(calls: string[]) {
  let observer: Observer | undefined;
  const busyIds = new Set<string>();
  const log = (line: string) => async () => { calls.push(line); };
  return {
    busyIds,
    fire: () => observer!,
    busy: (id: string) => busyIds.has(id),
    running: (id: string) => busyIds.has(id),
    reload: async (id: string) => { calls.push(`reload ${id}`); },
    notice: async (id: string, text: string) => { calls.push(`notice ${id} ${text}`); },
    prompt: async (id: string, input: { message: string }) => { calls.push(`prompt ${id} ${input.message}`); },
    restart: async (id: string, message: string) => { calls.push(`restart ${id} ${message}`); },
    setSteeringMode: log("steering"), heartbeat: async () => undefined, pin: () => true, unpin: () => {},
    observe(next: Observer) { observer = next; return () => { observer = undefined; }; },
  };
}
const old = (lines: readonly string[]) => lines.map(line => line.replace("Every open step names its owner", "Each open step has an owner"));

test("brief version: 8 hex, the same for the same bullets, another when one bullet changes", () => {
  const brief = chatBrief();
  assert.match(brief.version, /^[0-9a-f]{8}$/);
  assert.equal(chatBrief([...CHAT_BRIEF]).version, brief.version, "same text, same version");
  assert.deepEqual(brief.lines, CHAT_BRIEF);
  const edited = [...CHAT_BRIEF];
  edited[1] = edited[1] + " Also this.";
  assert.notEqual(chatBrief(edited).version, brief.version);
  assert.notEqual(chatBrief(CHAT_BRIEF.slice(1)).version, brief.version, "a removed bullet changes it too");
  assert.equal(reloadAction("b1", "b1", false, true), "reload", "the owner's update reloads a chat on the current build");
  assert.equal(reloadAction("b1", "b1", true, true), "wait");
});

test("brief diff: changed and added sentences in brief order, removed counted apart from edits; the note clips, caps at 6 and is null with no change", () => {
  const before = ["Rule one is here. Reply in 60 words at most.", "Old rule nobody needs any more."];
  const after = ["Rule one is here. Reply in 3 short sentences or 60 words at most.", "A brand new rule about wikis."];
  assert.deepEqual(briefChanges(before, after), { changed: ["Reply in 3 short sentences or 60 words at most.", "A brand new rule about wikis."], removed: 1 });
  assert.equal(briefNote(before, after),
    "[brief] Your chat rules changed: Reply in 3 short sentences or 60 words at most.; A brand new rule about wikis.; 1 removed. " +
    "Jobs you started keep their old instructions: re-brief a long-running job if this matters.");
  assert.equal(briefNote(CHAT_BRIEF, [...CHAT_BRIEF]), null);
  assert.equal(briefNote(["Keep it."], ["Keep it."]), null);
  const many = Array.from({ length: 8 }, (_, i) => `New rule number ${i} ${"x".repeat(200)}.`);
  const note = briefNote([], many)!;
  const quoted = note.slice(note.indexOf(": ") + 2, note.indexOf("; and"));
  assert.equal(quoted.split("; ").length, 6);
  for (const part of quoted.split("; ")) assert.ok(part.length <= BRIEF_NOTE_CHARS, part);
  assert.match(note, /; and 2 more; 0 removed\. /);
  assert.equal(briefNote(["Gone one. Kept."], ["Kept."]), "[brief] Your chat rules changed: 1 removed. Jobs you started keep their old instructions: re-brief a long-running job if this matters.");
});

test("load record: the brief text is kept per version, the old text comes back once on a change, unused texts go", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brief-"));
  const loads = loadRecord(join(dir, "extension-loads.json"));
  const v1 = chatBrief(old(CHAT_BRIEF));
  const v2 = chatBrief();
  assert.equal(await loads.set("c1", "b1"), null, "a build with no brief records no brief");
  assert.deepEqual(await loads.briefs(), {});
  assert.equal(await loads.set("c1", "b1", v1), null, "no brief on record: nothing to diff");
  assert.deepEqual(await loads.set("c1", "b2", v2), v1.lines);
  assert.equal(await loads.set("c1", "b2", v2), null, "the same brief again: no change");
  assert.deepEqual(await loads.briefs(), { c1: v2.version });
  assert.equal(await loads.get("c1"), "b2");
  await loads.forget("c1");
  assert.deepEqual(await loads.briefs(), {});
});

test("reload onto a changed brief: one notice line with the diff, no turn started; the next reload on the same brief adds none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brief-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  await index.add("c1");
  await index.add("legacy");
  const loads = loadRecord(join(dir, "extension-loads.json"));
  await loads.set("c1", "b1", chatBrief(old(CHAT_BRIEF)));
  await loads.set("legacy", "b1");
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const chats = new Chats(index, threads as unknown as ChatThreads, async () => ({ lifecycle: "live" }), "b2", loads, source(dir));
  let changed = 0;
  chats.briefChanged = () => { changed++; };
  const current = chatBrief().version;
  assert.deepEqual(await chats.briefs(), new Map([["c1", { version: chatBrief(old(CHAT_BRIEF)).version, current, updating: false }],
    ["legacy", { version: null, current, updating: false }]]));
  threads.fire().live("c1", []);
  threads.fire().live("legacy", []);
  await chats.settled();
  const notices = calls.filter(call => call.startsWith("notice"));
  assert.equal(notices.length, 1, calls.join("\n"));
  assert.match(notices[0]!, /^notice c1 \[brief\] Your chat rules changed: Every open step names its owner/);
  assert.match(notices[0]!, /re-brief a long-running job if this matters\.$/);
  assert.deepEqual(calls.filter(call => /^(prompt|restart)/.test(call)), [], "the note starts no turn");
  assert.ok(calls.indexOf("reload c1") < calls.indexOf(notices[0]!), "the notice follows the reload");
  assert.deepEqual([...(await chats.briefs()).values()].map(brief => [brief.version, brief.updating]), [[current, false], [current, false]]);
  assert.ok(changed >= 2, "the stream hears about each reload");
  calls.length = 0;
  await chats.updateAll();
  await chats.settled();
  assert.deepEqual(calls.sort(), ["reload c1", "reload legacy"], "the owner's update reloads again; the brief is the same, so no notice");
  chats.close();
});

test("update all: idle chats reload now, a busy one shows updating and reloads when its turn ends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brief-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of ["idle", "busy"]) await index.add(id);
  const loads = loadRecord(join(dir, "extension-loads.json"));
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  threads.busyIds.add("busy");
  const chats = new Chats(index, threads as unknown as ChatThreads, async () => ({ lifecycle: "live" }), "b1", loads, source(dir));
  for (const id of ["idle", "busy"]) await loads.set(id, "b1", chatBrief(old(CHAT_BRIEF)));
  assert.equal(await chats.updateAll(), 2);
  assert.ok((await chats.briefs()).get("idle")!.updating, "queued: updating until it runs");
  await chats.settled();
  assert.deepEqual(calls.filter(call => call.startsWith("reload")), ["reload idle"]);
  const states = await chats.briefs();
  assert.equal(briefStatus(states.get("idle")!), "up to date");
  assert.equal(briefStatus(states.get("busy")!), "updating");
  threads.busyIds.delete("busy");
  threads.fire().idle("busy");
  await chats.settled();
  assert.deepEqual(calls.filter(call => call.startsWith("reload")), ["reload idle", "reload busy"]);
  assert.equal(briefStatus((await chats.briefs()).get("busy")!), "up to date");
  assert.equal(calls.filter(call => call.startsWith("notice")).length, 2, "each got its one note");
  calls.length = 0;
  threads.fire().idle("busy");
  await chats.settled();
  assert.deepEqual(calls, [], "a later turn end reloads nothing");
  chats.close();
});

test("POST api/chats/update: needs the write token, reloads idle chats now and busy ones later, answers the chat count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brief-route-"));
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  for (const id of ["idle", "busy"]) await index.add(id);
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  threads.busyIds.add("busy");
  const chats = new Chats(index, threads as unknown as ChatThreads, async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), source(dir));
  const backend = { chats, catalog: { notify: async () => {} }, close: async () => {} } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "t" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {} });
  const origin = new URL(server.url).origin;
  const post = async (token: string) => {
    const res = await fetch(server.url + "api/chats/update", { method: "POST", body: "{}", headers: { "Content-Type": "application/json", "X-Chat-Token": token, Origin: origin } });
    return { status: res.status, body: await res.json() as unknown };
  };
  try {
    assert.equal((await post("wrong")).status, 403);
    await chats.settled();
    assert.deepEqual(calls, [], "a refused request reloads nothing");
    assert.deepEqual(await post("token"), { status: 200, body: { chats: 2 } });
    await chats.settled();
    assert.deepEqual(calls, ["reload idle"]);
    assert.equal((await chats.briefs()).get("busy")!.updating, true);
    threads.busyIds.delete("busy");
    threads.fire().idle("busy");
    await chats.settled();
    assert.deepEqual(calls, ["reload idle", "reload busy"]);
  } finally { await server.close(); chats.close(); }
});

test("Settings > Chats rows: unarchived chats with a brief, not up to date first, then by name; the current brief from any row", () => {
  const row = (id: string, name: string, brief: SessionRow["brief"], extra: Partial<SessionRow> = {}) => ({ id, name, chat: true, archived: false, ...(brief ? { brief } : {}), ...extra }) as SessionRow;
  const rows = [
    row("a", "zeta", { version: "cur00000", current: "cur00000", updating: false }),
    row("b", "alpha", { version: "cur00000", current: "cur00000", updating: false }),
    row("c", "old one", { version: null, current: "cur00000", updating: false }),
    row("d", "moving", { version: "old00000", current: "cur00000", updating: true }),
    row("e", "archived", { version: null, current: "cur00000", updating: false }, { archived: true }),
    { id: "f", name: "plain", archived: false } as SessionRow,
  ];
  assert.deepEqual(briefRows(rows).map(entry => [entry.name, entry.version, entry.status]),
    [["moving", "old00000", "updating"], ["old one", "unknown", "update pending"], ["alpha", "cur00000", "up to date"], ["zeta", "cur00000", "up to date"]]);
  assert.equal(currentBrief(rows), "cur00000");
  assert.equal(currentBrief([]), null);
});
