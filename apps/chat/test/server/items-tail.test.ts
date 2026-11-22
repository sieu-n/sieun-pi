/**
 * A repeat read of a thread's newest page costs one one-entry pi-host read, and after new entries it reads only those, with the same
 * items and older cursor a server with nothing held gives.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/items-tail.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { RequestTiming } from "../../server/request-log.ts";
import type { TimelinePage } from "../../web/src/lib/api/types.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
let fresh: Running;
let host: FixtureHost;
let reads: { thread: string; limit?: number; before?: number; after?: number }[] = [];
before(async () => {
  s = await start();
  host = s.host as FixtureHost;
  const entries = host.entries.bind(host);
  host.entries = async (thread, opts) => {
    reads.push({ thread, limit: opts.limit, before: opts.before, after: opts.after });
    return entries(thread, opts);
  };
  fresh = await start({ host });
});
after(async () => {
  await fresh.close();
  await s.close();
});

type Thread = ReturnType<FixtureHost["addThread"]>;
let at = 1000;
function turn(thread: Thread, steps: number, label: string): void {
  host.append(thread, 1, { kind: "pi.user", model: [{ role: "user", content: `ask ${label}`, timestamp: at++ }] } as never);
  for (let step = 0; step < steps; step++) {
    host.append(thread, 1, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: `c${label}.${step}`, name: "bash", arguments: { command: `echo ${step}` } }], provider: "p", model: "m", timestamp: at++ }] } as never);
    host.append(thread, 1, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: `c${label}.${step}`, toolName: "bash", content: [{ type: "text", text: `${step}` }], timestamp: at++ }] } as never);
  }
  host.append(thread, 1, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: `done ${label}` }], provider: "p", model: "m", timestamp: at++ }] } as never);
}

/** The page `s` serves for `path`, the pi-host reads it took for the thread, and the page a server with nothing held serves. */
async function read(thread: string, path: string): Promise<{ page: TimelinePage; reads: typeof reads; reference: TimelinePage }> {
  reads = [];
  const page = await s.get<TimelinePage>(path);
  const own = reads.filter(r => r.thread === thread);
  const reference = await fresh.get<TimelinePage>(path);
  return { page, reads: own, reference };
}

test("a repeat read of the newest page of a long turn takes one one-entry read and serves the same page", async () => {
  const thread = host.addThread({ name: "long turn", createdAt: 1 });
  turn(thread, 3, "a");
  turn(thread, 260, "b");
  const id = thread.row.id;
  const first = await read(id, `/api/c/${id}/items`);
  assert.ok(first.reads.length > 1, "the first read widens over the long turn");
  const again = await read(id, `/api/c/${id}/items`);
  assert.deepEqual(again.reads, [{ thread: id, limit: 1, before: undefined, after: undefined }]);
  assert.deepEqual(again.page, first.page);
  assert.deepEqual(again.page, again.reference);
  assert.ok(again.page.older);
});

test("after new entries the newest page reads only those, and an older page inside the held entries reads nothing", async () => {
  const thread = host.addThread({ name: "growing", createdAt: 1 });
  turn(thread, 3, "a");
  turn(thread, 120, "b");
  const id = thread.row.id;
  await read(id, `/api/c/${id}/items`);
  turn(thread, 2, "c");
  const grown = await read(id, `/api/c/${id}/items?limit=10`);
  assert.deepEqual(grown.reads.map(r => ({ limit: r.limit, after: r.after !== undefined })), [{ limit: 1, after: false }, { limit: 100, after: true }]);
  assert.deepEqual(grown.page, grown.reference);
  const older = await read(id, `/api/c/${id}/items?before=${grown.page.older}&limit=10`);
  assert.deepEqual(older.reads, []);
  assert.deepEqual(older.page, older.reference);
  assert.equal(older.page.items[0]?.id, "e2", "the older page runs back to the thread's first input");
  assert.equal(older.page.older, undefined);
});

test("a job conversation's newest page is held apart from the thread's", async () => {
  const thread = host.addThread({ name: "jobs", createdAt: 1 });
  turn(thread, 2, "root");
  const job = host.addChild(thread, 1, "job", at++, "idle");
  host.append(thread, job.id, { kind: "pi.user", model: [{ role: "user", content: "task", timestamp: at++ }] } as never);
  host.append(thread, job.id, { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "job done" }], provider: "p", model: "m", timestamp: at++ }] } as never);
  const id = thread.row.id;
  await read(id, `/api/c/${id}/items`);
  await read(id, `/api/c/${id}:${job.id}/items`);
  const root = await read(id, `/api/c/${id}/items`);
  const child = await read(id, `/api/c/${id}:${job.id}/items`);
  assert.deepEqual(root.page, root.reference);
  assert.deepEqual(child.page, child.reference);
  assert.equal(child.reads.length, 1);
});

test("a thread read's request log line counts its pi-host reads", async () => {
  const thread = host.addThread({ name: "logged", createdAt: 1 });
  turn(thread, 3, "a");
  const id = thread.row.id;
  await s.get<TimelinePage>(`/api/c/${id}/items`);
  await s.get<TimelinePage>(`/api/c/${id}/items`);
  const file = join(s.app.config.dataDir, "requests", `${new Date().toISOString().slice(0, 10)}.jsonl`);
  let lines: RequestTiming[] = [];
  for (let k = 0; k < 50 && lines.length < 2; k++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(text => JSON.parse(text) as RequestTiming)
      .filter(timing => timing.src === "server" && timing.p === `/api/c/${id}/items`) : [];
  }
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.split?.newest, 1);
  assert.ok((lines[0]!.split?.calls ?? 0) >= 1);
  assert.deepEqual({ calls: lines[1]!.split?.calls, entries: lines[1]!.split?.entries }, { calls: 1, entries: 1 }, "a repeat read takes one one-entry read");
  assert.equal(typeof lines[1]!.split?.host, "number");
});
