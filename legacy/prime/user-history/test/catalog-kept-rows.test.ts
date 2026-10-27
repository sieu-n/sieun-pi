// Guards the 10-18 owner ask for a "clean, snappy" chat from the Mac: the live chat's main thread was 81% busy, and a scratch serve on this box's 562 rows and the Mac's 3,123 spent 33.8 s of a 131 s profile in project(), building all 3,700 rows again for each roster update that changed two.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { DaemonClient, SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import type { SessionRow } from "../src/shared/types.ts";

test("a projection reuses each row whose daemon row, read marker and box did not change, and builds the changed ones again", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "kept-rows-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const row = (n: number, name = `thread ${n}`): SessionSummary => ({ sessionId: `s${n}`, cwd: "/tmp", sessionFile: join(dir, `s${n}.jsonl`), sessionName: name, messageCount: 3,
    lastActivityAt: new Date(Date.parse("2026-10-18T08:00:00Z") - n * 1000).toISOString() }) as SessionSummary;
  for (let n = 0; n < 300; n++) await writeFile(join(dir, `s${n}.jsonl`), "");
  const saved = Array.from({ length: 300 }, (_, n) => row(n));
  const live = (name: string): SessionSummary => ({ ...row(5, name), activeSessionId: "a-s5" }) as SessionSummary;
  saved[5] = live("thread 5");
  const reads = new ChatReadState("unused");
  const marks: Record<string, { timestamp: number }> = {};
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: { ...marks } }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  const client = catalog.client as unknown as Record<string, unknown>;
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string; all?: boolean }) => command.type !== "list" ? { success: true, data: { jobs: [] } }
    : { success: true, data: { sessions: command.all ? [...saved] : saved.filter(entry => entry.activeSessionId !== undefined) } });
  Object.defineProperty(client, "isConnected", { get: () => connected });

  await catalog.refresh();
  const byId = (rows: SessionRow[]) => new Map(rows.map(entry => [entry.id, entry]));
  const first = byId((await catalog.event()).sessions);
  assert.equal(first.size, 300);
  const second = byId((await catalog.event()).sessions);
  assert.equal([...second].filter(([id, entry]) => first.get(id) === entry).length, 300, "a projection with no change builds no row");

  saved[5] = live("renamed");
  await catalog.refresh();
  marks.s7 = { timestamp: Date.parse("2026-10-18T09:00:00Z") };
  const third = byId((await catalog.event()).sessions);
  assert.equal(third.get("s5")?.name, "renamed", "a changed daemon row is built again");
  assert.equal(second.get("s7")?.unread, true);
  assert.equal(third.get("s7")?.unread, false, "a new read marker builds its row again");
  assert.deepEqual([...third].filter(([id, entry]) => second.get(id) !== entry).map(([id]) => id).sort(), ["s5", "s7"], "only the two changed rows are new objects");
});
