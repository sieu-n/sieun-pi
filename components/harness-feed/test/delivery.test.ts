import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Context, Sample } from "../otlp.ts";
import { busyRows, findRow, messageKind, read, readOutbox, readSends, rowAt } from "../readers/delivery.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/delivery/home", import.meta.url));
const NOW = 1792430000000;
const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const context = (home: string, chatHost = true): Context => ({ home, host: "us-metal02", platform: "linux", now: NOW, chatHost, state: new Map() });
const pick = (samples: Sample[], name: string, labels: Record<string, string> = {}) =>
  samples.filter(s => s.name === name && Object.entries(labels).every(([key, value]) => s.labels?.[key] === value));
/** A copy of the fixture home, for tests that change files. */
const scratch = (): string => { const home = mkdtempSync(join(tmpdir(), "delivery-")); cpSync(FIXTURE, home, { recursive: true }); return home; };

test("messageKind names a message by the opener its sender writes", () => {
  assert.equal(messageKind("[wake] Run 1 finished: success."), "wake");
  assert.equal(messageKind("[cross-host message from x (y) on mac; answer]\n\nhi"), "cross-host");
  assert.equal(messageKind("[message from your job a (b), held in the chat service's outbox while this session's queue was full; answer]\n\nhi"), "held send");
  assert.equal(messageKind("[task from parent]\n\nbuild it"), "brief");
  assert.equal(messageKind("[3 messages the chat service's outbox held for this session go together in this one send, oldest first]"), "bundle");
  assert.equal(messageKind("[alert-bridge-down] x"), "alert");
  assert.equal(messageKind("plain text"), "other");
});

test("rowAt and findRow cut one row out of a copy, past nested ids and escaped quotes", () => {
  const bytes = readFileSync(join(FIXTURE, ".prime/agent/browser-chat/session-copy.json"));
  const copies = [{ host: "us-metal02", busy: [], bytes: () => bytes }];
  assert.equal(findRow(copies, "01a154b4-bd46-70e9-bca0-14ec068d3c4a")?.sessionName, "image serving");
  assert.equal(findRow(copies, CHAT)?.sessionName, "Crawler  VP");
  assert.equal(findRow(copies, "01a0aaaa-0000-7000-8000-000000000000")?.lifecycle, "archived");
  assert.equal(findRow(copies, "01a19999-0000-7000-8000-000000000000"), null);
  assert.equal(rowAt(bytes, 0), null);
});

test("busyRows keeps the live rows with queued input or unfinished actions only", () => {
  const bytes = readFileSync(join(FIXTURE, ".prime/agent/browser-chat/session-copy.json"));
  assert.deepEqual(busyRows(bytes).map(row => row.sessionName).sort(), ["Crawler  VP", "image serving"]);
});

test("readOutbox reads a done entry once, rereads waiting ones and forgets deleted files", async () => {
  const home = scratch();
  try {
    const dir = join(home, ".prime/agent/browser-chat/agent-outbox");
    const cache = new Map();
    assert.equal((await readOutbox(dir, "agent", cache)).length, 8);
    const done = JSON.parse(readFileSync(join(dir, "m-5.json"), "utf8"));
    writeFileSync(join(dir, "m-5.json"), JSON.stringify({ ...done, state: "failed" }));
    const waiting = JSON.parse(readFileSync(join(dir, "m-1.json"), "utf8"));
    writeFileSync(join(dir, "m-1.json"), JSON.stringify({ ...waiting, state: "delivered", doneAt: NOW }));
    rmSync(join(dir, "m-8.json"));
    const again = await readOutbox(dir, "agent", cache);
    assert.equal(again.length, 7);
    assert.equal(cache.get("m-5.json").state, "delivered");
    assert.equal(cache.get("m-1.json").doneAt, NOW);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("read gives the headline numbers with chat names and no session id label", async () => {
  const samples = await read(context(FIXTURE));
  assert.equal(pick(samples, "harness.delivery.waiting_all")[0]?.value, 5);
  assert.equal(pick(samples, "harness.delivery.waiting", { outbox: "agent", kind: "held send", target: "chat", chat: "Crawler VP" })[0]?.value, 2);
  assert.equal(pick(samples, "harness.delivery.waiting", { outbox: "agent", kind: "cross-host", target: "job", chat: "mac-management" })[0]?.value, 1);
  assert.equal(pick(samples, "harness.delivery.waiting", { outbox: "owner", kind: "owner send", chat: "Crawler VP" })[0]?.value, 1);
  assert.equal(pick(samples, "harness.delivery.oldest_wait", { outbox: "agent", chat: "mac-management" })[0]?.value, 1800);
  assert.equal(pick(samples, "harness.delivery.oldest_wait", { outbox: "agent", chat: "Crawler VP" })[0]?.value, 1200);
  assert.deepEqual(pick(samples, "harness.delivery.top_wait").map(s => [s.labels!.rank, s.value]), [["1", 1800], ["2", 1200], ["3", 600], ["4", 90], ["5", 60]]);
  assert.equal(pick(samples, "harness.delivery.retrying", { chat: "Crawler VP" })[0]?.value, 1);
  assert.equal(pick(samples, "harness.delivery.ended_30m", { outbox: "agent", state: "delivered", chat: "Crawler VP" })[0]?.value, 2);
  assert.equal(pick(samples, "harness.delivery.ended_30m", { state: "obsolete" }).length, 0);
  assert.equal(pick(samples, "harness.delivery.failed_24h", { chat: "unknown chat" })[0]?.value, 1);
  assert.equal(pick(samples, "harness.delivery.delay", { outbox: "agent", chat: "Crawler VP", stat: "max" })[0]?.value, 60);
  assert.equal(pick(samples, "harness.delivery.delay", { outbox: "agent", chat: "Crawler VP", stat: "p50" })[0]?.value, 60);
  assert.equal(pick(samples, "harness.delivery.daemon_queued", { host: "us-metal02", chat: "Crawler VP" })[0]?.value, 2);
  assert.equal(pick(samples, "harness.delivery.daemon_unfinished", { host: "us-metal02", chat: "Crawler VP" })[0]?.value, 20);
  assert.equal(pick(samples, "harness.delivery.daemon_unfinished", { host: "mac", chat: "mac-management" })[0]?.value, 1);
  assert.equal(pick(samples, "harness.delivery.daemon_full", { chat: "Crawler VP" })[0]?.value, 1);
  assert.equal(pick(samples, "harness.delivery.outside_sends_24h", { decision: "refused", layer: "kernel", chat: "Crawler VP" })[0]?.value, 1);
  assert.equal(pick(samples, "harness.delivery.outside_sends_24h", { decision: "ran" }).length, 0);
  assert.equal(pick(samples, "harness.delivery.outside_sends_30m", { decision: "allowed" }).length, 0);
  for (const sample of samples) for (const value of Object.values(sample.labels ?? {})) assert.doesNotMatch(value, UUID, `${sample.name} ${value}`);
});

test("read on a box that does not run the chat returns nothing", async () => {
  assert.deepEqual(await read(context(FIXTURE, false)), []);
});

test("readSends reads only appended lines and starts over after a truncation", async () => {
  const home = scratch();
  try {
    const file = join(home, ".prime/agent/browser-chat/sends.jsonl");
    const kept = { offset: 0, sends: [] as { at: number; decision: string; layer: string; chat: string | null }[] };
    assert.equal((await readSends(file, kept, NOW)).length, 2);
    appendFileSync(file, JSON.stringify({ decision: "refused", layer: "tool_call", chat: CHAT, at: new Date(NOW - 1000).toISOString() }) + "\n{\"partial\":");
    assert.equal((await readSends(file, kept, NOW)).length, 3);
    writeFileSync(file, JSON.stringify({ decision: "allowed", layer: "kernel", chat: null, at: new Date(NOW).toISOString() }) + "\n");
    assert.deepEqual((await readSends(file, kept, NOW)).map(send => send.decision), ["allowed"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
