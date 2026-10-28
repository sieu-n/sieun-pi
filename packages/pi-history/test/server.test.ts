import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { historyGet, HistoryError } from "../src/client.ts";
import { type SearchResult, startServer, type Status } from "../src/server.ts";
import type { ReadAnswer } from "../src/core/read.ts";
import { makeDurable, makeIndex } from "./fixture.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-history-server-"));
const T = Date.parse("2026-10-20T00:00:00Z");
const min = (n: number): number => T + n * 60_000;
const id = (n: number): string => `01a1${String(n).padStart(4, "0")}-0000-7000-8000-000000000000`;
const CHAT = id(1), JOB = id(2), OTHER = id(3), MAC_JOB = id(4), MAC_OTHER = id(5);

const hosts = join(dir, "hosts.json");
writeFileSync(hosts, JSON.stringify({ hosts: [
  { name: "us-metal02", hostname: "metal-test", address: "10.0.0.1", relayPort: 7790, token: "metal-token" },
  { name: "mac", hostname: "mac-test", address: "10.0.0.2", relayPort: 7790, token: "mac-token" },
  { name: "down", hostname: "down-test", address: "10.0.0.3", relayPort: 7790, token: "down-token" },
] }));
const chatDir = join(dir, "browser-chat");
mkdirSync(chatDir);
writeFileSync(join(chatDir, "chat-jobs.json"), JSON.stringify({ jobs: { [JOB]: { chat: "frontend bro", chatId: CHAT }, "mac relay job": { chat: "frontend bro" } } }));
process.env.AGENT_CHAT_DATA_DIR = chatDir;

const metalDb = join(dir, "metal.db");
makeIndex(metalDb, [{ session: CHAT, name: "frontend bro" }, { session: JOB, name: "relay timeout job" }, { session: OTHER, name: "crawler VP" }], [
  { session: CHAT, at: min(1), kind: "user", text: "why did the relay time out?" },
  { session: JOB, at: min(3), kind: "tool_result", tool: "bash", text: "relay mac did not answer in 15000 ms", isError: true },
  { session: OTHER, at: min(5), kind: "assistant", text: "relay is unrelated here" },
]).close();
const macDb = join(dir, "mac.db");
makeIndex(macDb, [{ session: MAC_JOB, name: "mac relay job" }, { session: MAC_OTHER, name: "slack green guy" }], [
  { session: MAC_JOB, at: min(2), kind: "assistant", text: "the mac relay answers again" },
  { session: MAC_OTHER, at: min(4), kind: "tool_call", tool: "bash", text: "curl the relay on the mac" },
]).close();
makeDurable(join(dir, "durable.sqlite"), [{ id: "thread-a", name: "durable thread" }], [
  { thread: "thread-a", kind: "pi.user", author: "owner", at: min(6), text: "relay durable note" },
]).close();

const settings = (box: string, extra: object = {}): string => {
  const file = join(dir, `${box}-settings.json`);
  writeFileSync(file, JSON.stringify({ box, peers: hosts, durableIndexes: [], ...extra }));
  return file;
};
const sockets: Record<string, string> = { "10.0.0.1": join(dir, "metal.sock"), "10.0.0.2": join(dir, "mac.sock") };
const tokens: Record<string, string> = { "10.0.0.1": "metal-token", "10.0.0.2": "mac-token" };
const relayCalls: string[] = [];
/** Stands in for each box's prime-relay: checks the token and asks that box's socket, as /v1/history/* does. */
const relay = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  relayCalls.push(url.pathname + url.search);
  const socket = sockets[url.hostname];
  if (!socket) throw new TypeError("fetch failed: connect ECONNREFUSED");
  if ((init?.headers as Record<string, string>).Authorization !== `Bearer ${tokens[url.hostname]}`) return new Response("{}", { status: 401 });
  try {
    const body = await historyGet(`/v1/${url.pathname.replace("/v1/history/", "")}` as "/v1/search", Object.fromEntries(url.searchParams), socket);
    return new Response(JSON.stringify(body));
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: (error as HistoryError).status ?? 500 });
  }
}) as typeof fetch;

const servers: { close(): Promise<void> }[] = [];
before(async () => {
  servers.push(await startServer({ socket: sockets["10.0.0.1"]!, dbPath: metalDb, settingsFile: settings("us-metal02", { agentScope: "family", durableIndexes: [join(dir, "durable.sqlite")] }),
    fetcher: relay }));
  servers.push(await startServer({ socket: sockets["10.0.0.2"]!, dbPath: macDb, settingsFile: settings("mac"), fetcher: relay,
    indexer: { status: () => ({ files: 2, docs: 2, bytesIndexed: 50, bytesTotal: 100, backfillPct: 50, newestAt: min(4), lagP50Ms: 120, lagP99Ms: 900, dbBytes: 4096 }) } }));
});
after(async () => { for (const server of servers) await server.close(); });

const search = (params: Record<string, string>) => historyGet<SearchResult>("/v1/search", params, sockets["10.0.0.1"]);

test("an owner search merges both boxes and the durable index newest first, with the exact total and each box's state", async () => {
  const result = await search({ q: "relay" });
  assert.equal(result.scope, "all");
  assert.deepEqual(result.hits.map(hit => [hit.box, hit.source, hit.at]), [
    ["us-metal02", "durable", min(6)], ["us-metal02", "prime", min(5)], ["mac", "prime", min(4)], ["us-metal02", "prime", min(3)],
    ["mac", "prime", min(2)], ["us-metal02", "prime", min(1)],
  ]);
  assert.equal(result.total, 6);
  assert.equal(result.boxes["us-metal02"]!.ok, true);
  assert.equal(result.boxes.mac!.ok, true);
  assert.deepEqual([result.boxes.mac!.lagP99Ms, result.boxes.mac!.backfillPct, result.boxes.mac!.bytesTotal], [900, 50, 100], "a box reports its indexer's lag, backfill and JSONL bytes");
  assert.equal(result.boxes.down!.ok, false, "a box that does not answer shows as down and the rest still return");
  assert.match(result.hits[2]!.ref, /^mac:/);
});

test("a cursor pages across boxes with no gap and no repeat", async () => {
  const ats: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await search({ q: "relay", limit: "2", ...cursor ? { cursor } : {} });
    assert.equal(page.total, 6);
    ats.push(...page.hits.map(hit => hit.at));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(ats, [6, 5, 4, 3, 2, 1].map(min));
});

test("box: asks only the boxes it names", async () => {
  const mac = await search({ q: "relay box:mac" });
  assert.deepEqual(mac.hits.map(hit => hit.box), ["mac", "mac"]);
  assert.deepEqual(Object.keys(mac.boxes), ["mac"]);
});

test("under agentScope family an agent call sees only its chat family on both boxes, whatever scope it asks for", async () => {
  relayCalls.length = 0;
  const result = await search({ q: "relay", caller: JOB, callerPath: `/x/.prime/agent/sessions/${JOB}.jsonl`, roots: OTHER });
  assert.equal(result.scope, "family");
  assert.deepEqual(result.hits.map(hit => hit.session), [JOB, MAC_JOB, CHAT]);
  assert.equal(result.total, 3);
  const forwarded = new URLSearchParams(relayCalls.find(call => call.startsWith("/v1/history/search"))!.split("?")[1]);
  assert.equal(forwarded.get("roots"), CHAT);
  assert.equal(forwarded.get("caller"), null);
});

test("agentScope all lets an agent search everything", async () => {
  const file = settings("us-metal02", { agentScope: "all", durableIndexes: [join(dir, "durable.sqlite")] });
  writeFileSync(file, JSON.stringify({ box: "us-metal02", peers: hosts, agentScope: "all", durableIndexes: [join(dir, "durable.sqlite")], v: 2 }));
  const result = await search({ q: "relay", caller: JOB });
  assert.equal(result.scope, "all");
  assert.equal(result.total, 6);
  writeFileSync(file, JSON.stringify({ box: "us-metal02", peers: hosts, agentScope: "family", durableIndexes: [join(dir, "durable.sqlite")] }));
});

test("read answers around a hit on this box and fetches a peer's hit through its relay", async () => {
  const result = await search({ q: "relay" });
  const local = await historyGet<ReadAnswer>("/v1/read", { ref: result.hits.find(hit => hit.session === JOB)!.ref }, sockets["10.0.0.1"]);
  assert.equal(local.thread, "relay timeout job");
  const remote = await historyGet<ReadAnswer>("/v1/read", { ref: result.hits.find(hit => hit.box === "mac")!.ref }, sockets["10.0.0.1"]);
  assert.equal(remote.box, "mac");
  assert.equal(remote.messages[0]!.hit, true);
  await assert.rejects(historyGet("/v1/read", { ref: result.hits.find(hit => hit.session === MAC_OTHER)!.ref, caller: JOB }, sockets["10.0.0.1"]), /outside/);
});

test("status reports this box's counts and every peer's state", async () => {
  const status = await historyGet<Status>("/v1/status", {}, sockets["10.0.0.1"]);
  assert.equal(status.box, "us-metal02");
  assert.deepEqual([status.files, status.docs, status.backfillPct], [3, 3, 100]);
  assert.equal(status.newestAt, min(5));
  assert.deepEqual([status.peers.mac!.ok, status.peers.mac!.backfillPct, status.peers.mac!.lagP50Ms, status.peers.mac!.bytesTotal], [true, 50, 120, 100]);
  assert.equal(status.peers.down!.ok, false);
  assert.ok(status.queryP50Ms !== undefined);
});

test("a query that does not parse answers 400 with the reason", async () => {
  await assert.rejects(search({ q: "x kind:nope" }), (error: HistoryError) => error.status === 400 && /Unknown kind/.test(error.message));
  await assert.rejects(historyGet("/v1/search", {}, join(dir, "none.sock")), (error: HistoryError) => error.status === 503);
});

test("a peer that fails is skipped at once as offline, probed in the background, and rejoins when it answers", async () => {
  let up = false;
  const calls: string[] = [];
  const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "10.0.0.3") return relay(input, init);
    calls.push(url.pathname);
    if (!up) throw new TypeError("fetch failed: connect ETIMEDOUT");
    return new Response(JSON.stringify(url.pathname.endsWith("/status") ? { backfillPct: 100 } : { ranked: [], total: 0, box: { ok: true, tookMs: 1, backfillPct: 100 } }));
  }) as typeof fetch;
  const socket = join(dir, "flaky.sock");
  const server = await startServer({ socket, dbPath: metalDb, settingsFile: settings("us-metal02-flaky", { box: "us-metal02" }), fetcher: flaky, probeMs: 30 });
  try {
    const first = await historyGet<SearchResult>("/v1/search", { q: "relay" }, socket);
    assert.equal(first.boxes.down!.ok, false);
    assert.deepEqual(calls.filter(path => path.endsWith("/search")), ["/v1/history/search"]);
    const second = await historyGet<SearchResult>("/v1/search", { q: "relay" }, socket);
    assert.match(second.boxes.down!.error!, /^offline since \d{4}-\d{2}-\d{2}T.*ETIMEDOUT/);
    assert.equal(second.boxes.down!.tookMs, 0);
    assert.deepEqual(calls.filter(path => path.endsWith("/search")), ["/v1/history/search"], "a search does not ask a peer that is down");
    assert.equal(second.total, 5, "the other boxes still answer");
    up = true;
    const deadline = Date.now() + 10_000;
    let third = await historyGet<SearchResult>("/v1/search", { q: "relay" }, socket);
    while (!third.boxes.down!.ok && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      third = await historyGet<SearchResult>("/v1/search", { q: "relay" }, socket);
    }
    assert.equal(third.boxes.down!.ok, true, "the probe's answer brings the peer back");
  } finally {
    await server.close();
  }
});
