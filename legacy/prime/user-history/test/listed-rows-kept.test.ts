// Guards a projection's own code: each one asked the disk whether every saved row's file exists, 1,400 rows on the live box, and on a bench
// over a copy of the live rows on 10-19 that was 3.3 of 54 ms of a projection's own code.
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

test("a projection does not ask the disk again for the files of saved rows that did not change", async (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "listed-kept-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const box = ["s1", "s2", "s3"].map(id => {
    const sessionFile = join(dir, `${id}.jsonl`);
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id })}\n`);
    return { sessionId: id, cwd: "/tmp", sessionName: id, messageCount: 3, sessionFile } as SessionSummary;
  });
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: box } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  await catalog.refresh();
  assert.deepEqual((await catalog.rows()).map(row => row.id).sort(), ["s1", "s2", "s3"]);
  const asked: string[] = [];
  const real = fs.existsSync;
  t.mock.method(fs, "existsSync", (path: fs.PathLike) => { if (String(path).startsWith(dir)) asked.push(String(path)); return real(path); });
  syncBuiltinESMExports();
  t.after(() => syncBuiltinESMExports());
  await catalog.event();
  assert.deepEqual((await catalog.rows()).map(row => row.id).sort(), ["s1", "s2", "s3"]);
  assert.deepEqual(asked, [], "the second projection asked the disk for files it had already found");
});
