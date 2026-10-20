// Stray chat 01a157fb on 10-20: a clean-room setup archived it at 06:25:25Z (owner_stop) through the archive route, which took it for a plain
// thread because the chat index never held it, and the scan re-adopted and resumed it at 06:25:28Z from its chat_mode entry. A second archive at
// 06:26:34Z held, but the route answered 502 because the cancel of its scheduled jobs waited in the retry queue.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatBackend } from "../src/chat-backend.ts";
import { loadRecord } from "../src/chat-brief.ts";
import { startChatServer } from "../src/chat-server.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { ScheduledJobsLeft } from "../src/saved-archive.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const NOW = Date.parse("2026-10-20T06:25:27Z");
const jsonl = (entries: object[]) => entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
const marked = [{ type: "session", id: "s", timestamp: "2026-10-20T06:24:46.427Z" }, { type: "custom", customType: "chat_mode", data: { v: 1 } },
  { type: "session_state", id: "a1", timestamp: "2026-10-20T06:25:08.327Z", state: { status: "active" } }];
const ownerStop = { type: "session_state", id: "a2", timestamp: "2026-10-20T06:25:25.184Z", state: { status: "archived", reason: "owner_stop" } };

async function fixture(files: Record<string, object[]>) {
  const dir = await mkdtemp(join(tmpdir(), "stray-archive-"));
  const paths: Record<string, string> = {};
  for (const [id, entries] of Object.entries(files)) { paths[id] = join(dir, `${id}.jsonl`); await writeFile(paths[id]!, jsonl(entries)); }
  const index = new IdIndex(join(dir, "chats.json"), "Chat index");
  const archived = new IdIndex(join(dir, "archived-chats.json"), "Archived chat index");
  const calls: string[] = [];
  const threads = fakeThreads(calls);
  const rows = () => Object.keys(files).map(id => row(id, new Date(NOW - 2_000).toISOString(), { messageCount: 0 }));
  const lines: string[] = [];
  const chats = new Chats(index, threads, async id => paths[id] ? { lifecycle: "live" as const, sessionFile: paths[id]! } : undefined, "b1",
    loadRecord(join(dir, "extension-loads.json")), { ...source(dir, {}, () => NOW, rows), archived }, line => lines.push(line));
  return { dir, paths, index, archived, calls, threads, chats, lines, close: async () => { chats.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("the scan never resumes a chat whose file records the owner's stop after its last active state; a later active state or a daemon eviction still comes back", async () => {
  const f = await fixture({
    stray: [...marked, ownerStop],
    reopened: [...marked, ownerStop, { type: "session_state", id: "a3", state: { status: "active" } }],
    evicted: [...marked, { type: "session_state", id: "a4", state: { status: "archived", reason: "idle_unload" } }],
  });
  try {
    assert.deepEqual((await f.chats.rescan()).sort(), ["evicted", "reopened"]);
    assert.equal(f.calls.some(call => call.endsWith(" stray") || call.includes(" stray ")), false, `stray is not pinned, steered or opened: ${f.calls.join(", ")}`);
    assert.deepEqual(await f.archived.ids(), ["stray"], "the stop files it as archived, so the next scan does not read it again");
    assert.match(f.lines.join("\n"), /chat stray: not re-adopted: its session file records the owner's stop \(owner_stop at 2026-10-20T06:25:25.184Z\)/);
    assert.equal(await f.chats.restore("stray"), true, "the owner's unarchive still takes it back");
  } finally { await f.close(); }
});

async function serve(backend: ChatBackend) {
  const asset = { body: Buffer.from(""), etag: '"test"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "test" }, port: 0, capability: "cap", csrfToken: "test-token", stopToken: "test-stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-stray.sock" }, onStop: async () => {} });
  const archive = (id: string) => fetch(server.url + `api/threads/${id}/archive`, {
    method: "POST", headers: { "content-type": "application/json", origin: new URL(server.url).origin, "x-chat-token": "test-token" }, body: "{}" });
  return { archive, close: () => server.close() };
}

test("the archive route archives a marked session the chat index never held as a chat, so the scan cannot take it back", async () => {
  const f = await fixture({ stray: marked, plain: [{ type: "session", id: "p" }] });
  f.threads.archive = async (id: string) => { f.calls.push(`archive ${id}`); await writeFile(f.paths[id]!, jsonl([...(id === "stray" ? marked : [{ type: "session", id: "p" }]), ownerStop])); };
  let notified = 0;
  const server = await serve({ chats: f.chats, threads: f.threads, catalog: { notify: async () => { notified++; } }, close: async () => {} } as unknown as ChatBackend);
  try {
    assert.equal((await server.archive("stray")).status, 200);
    assert.equal((await server.archive("plain")).status, 200);
    assert.deepEqual(await f.archived.ids(), ["stray"], "only the marked session is filed as an archived chat");
    assert.equal(notified, 1);
    assert.deepEqual(await f.chats.rescan(), [], "archived-chats.json keeps the scan off it");
    assert.equal(f.calls.includes("pin stray"), false, f.calls.join(", "));
  } finally { await server.close(); await f.close(); }
});

test("an archive whose only open part is a recorded retry of the scheduled-job cancel answers 200 with the notice; an unrecorded one still answers 502", async () => {
  const f = await fixture({ stray: marked });
  let retrying = true;
  f.threads.archive = async () => { throw new ScheduledJobsLeft(retrying ? "The thread is archived. The chat service retries the cancel." : "The thread is archived, but its scheduled jobs may still run.", retrying); };
  const server = await serve({ chats: f.chats, threads: f.threads, catalog: { notify: async () => {} }, close: async () => {} } as unknown as ChatBackend);
  try {
    const held = await server.archive("stray");
    assert.equal(held.status, 200, await held.clone().text());
    assert.deepEqual(await held.json(), { ok: true, notice: "The thread is archived. The chat service retries the cancel." });
    assert.deepEqual(await f.archived.ids(), ["stray"], "the archive holds");
    retrying = false;
    const open = await server.archive("stray");
    assert.equal(open.status, 502);
    assert.match((await open.json() as { error: string }).error, /may still run/);
  } finally { await server.close(); await f.close(); }
});
