// The search panel's routes on the chat server (packages/pi-history API.md, "user-history routes"): GET api/search and api/search/read answer
// from this box's pi-history socket in owner scope.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startChatServer } from "../src/chat-server.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import { startServer } from "../../../../packages/pi-history/src/server.ts";
import { makeIndex } from "../../../../packages/pi-history/test/fixture.ts";
import { takeLatency } from "../src/chat-latency.ts";

const dir = mkdtempSync(join(tmpdir(), "chat-search-"));
const CHAT = "01a10001-0000-7000-8000-000000000000";
const JOB = "01a10002-0000-7000-8000-000000000000";
const at = Date.parse("2026-10-23T13:20:00Z");
makeIndex(join(dir, "history.db"), [{ session: CHAT, name: "frontend bro" }, { session: JOB, name: "relay timeout job" }], [
  { session: CHAT, at, kind: "user", text: "why did the relay time out?" },
  { session: JOB, at: at + 1000, kind: "tool_result", tool: "bash", toolCallId: "call-1", text: "relay mac did not answer in 15000 ms <b>", isError: true },
  { session: JOB, at: at + 2000, kind: "assistant", text: "the Mac copy was stale" },
]).close();
writeFileSync(join(dir, "settings.json"), JSON.stringify({ box: "us-metal02", peers: join(dir, "hosts.json"), durableIndexes: [] }));
writeFileSync(join(dir, "chat-jobs.json"), JSON.stringify({ jobs: {} }));
process.env.AGENT_CHAT_DATA_DIR = dir;
process.env.PI_HISTORY_SOCKET = join(dir, "history.sock");

async function servers(t: { after(fn: () => Promise<void>): void }, history_: Partial<Parameters<typeof startServer>[0]> = {}): Promise<string> {
  const history = await startServer({ dbPath: join(dir, "history.db"), socket: join(dir, "history.sock"), settingsFile: join(dir, "settings.json"), ...history_ });
  const chat = await startChatServer({ backend: { close: async () => {} } as unknown as ChatBackend, bundle: new Promise(() => {}), port: 0,
    capability: "cap", csrfToken: "token", stopToken: "stop", identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-search.sock" }, onStop: async () => {} });
  t.after(async () => { await chat.close(); await history.close(); });
  return new URL("/cap/", chat.url).href;
}

test("GET api/search answers hits, the exact total and each box's state from pi-history", async t => {
  const base = await servers(t);
  const response = await fetch(`${base}api/search?q=relay&limit=1`);
  assert.equal(response.status, 200);
  const body = await response.json() as { hits: { ref: string; thread: string; kind: string; snippet: string; toolCallId?: string }[]; total: number; nextCursor?: string; scope: string; boxes: Record<string, { ok: boolean }> };
  assert.equal(body.total, 2);
  assert.equal(body.scope, "all");
  assert.equal(body.boxes["us-metal02"]?.ok, true);
  assert.equal(body.hits.length, 1);
  assert.equal(body.hits[0]!.thread, "relay timeout job");
  assert.equal(body.hits[0]!.toolCallId, "call-1");
  assert.match(body.hits[0]!.snippet, /<mark>relay<\/mark> mac did not answer in 15000 ms &#60;b&#62;/);
  const next = await (await fetch(`${base}api/search?q=relay&limit=1&cursor=${body.nextCursor}`)).json() as typeof body;
  assert.equal(next.hits[0]!.thread, "frontend bro");

  const read = await (await fetch(`${base}api/search/read?ref=${encodeURIComponent(body.hits[0]!.ref)}&before=1&after=1`)).json() as { thread: string; messages: { text: string; hit?: boolean }[] };
  assert.equal(read.thread, "relay timeout job");
  assert.deepEqual(read.messages.map(message => message.hit ?? false), [true, false]);
});

test("api/search keeps owner scope: a caller field in the URL does not narrow it", async t => {
  const base = await servers(t);
  const body = await (await fetch(`${base}api/search?q=relay&caller=${CHAT}&roots=${CHAT}&local=1`)).json() as { total: number; scope: string };
  assert.deepEqual([body.total, body.scope], [2, "all"]);
});

test("api/search answers a bad query with 400 and the reason", async t => {
  const base = await servers(t);
  const response = await fetch(`${base}api/search?q=${encodeURIComponent("x kind:nope")}`);
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /Unknown kind/);
});

// d7 counted us-metal02's 03:45Z minute on 10-28 dirty from an api/search of 2,005 ms, which was pi-history waiting out its 2 s peer timeout
// on the Mac: that wait is the Mac's time, as a relay read's is, and this box's own part still counts.
test("a merged api/search counts its wait on a slow peer as remote and only its own part as this box's read", async t => {
  writeFileSync(join(dir, "peer-hosts.json"), JSON.stringify({ hosts: [{ name: "mac", hostname: "mac-test", address: "10.0.0.2", relayPort: 7790, token: "mac-token" }] }));
  writeFileSync(join(dir, "peer-settings.json"), JSON.stringify({ box: "us-metal02", peers: join(dir, "peer-hosts.json"), durableIndexes: [] }));
  const mac = (async () => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    return new Response(JSON.stringify({ ranked: [], total: 0, box: { ok: true, tookMs: 5, backfillPct: 100 } }));
  }) as typeof fetch;
  const base = await servers(t, { settingsFile: join(dir, "peer-settings.json"), fetcher: mac });
  takeLatency();
  const body = await (await fetch(`${base}api/search?q=relay`)).json() as { total: number; boxes: Record<string, { ok: boolean }> };
  assert.deepEqual([body.total, body.boxes.mac?.ok], [2, true]);
  await new Promise(resolve => setTimeout(resolve, 20));
  const line = takeLatency();
  assert.ok(line);
  assert.equal(line.remote, "api/search");
  assert.ok((line.remoteMs ?? 0) >= 1200, `the whole read took ${line.remoteMs} ms`);
  assert.ok(line.readMs < 1000, `this box's part read ${line.readMs} ms`);
});
