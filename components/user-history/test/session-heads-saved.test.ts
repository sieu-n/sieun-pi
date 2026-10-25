// Guards the 06:17Z dirty minute of 10-25: after each chat service start the first projection read the head of every listed session file (3.1 s of
// fileDecides and 1.4 s of firstTask on the main thread in the profile of the 03:31Z start), and an api/threads/<id>/agents read in that window
// took 2.2 s. A stop now saves what the heads said (HEADS_FILE), and the next start takes it instead of reading the files again.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { AGENTS_FILE, Catalog } from "../src/chat-catalog.ts";

/** chat-catalog.ts `HEADS_FILE`, named here so the test reads the same file a release writes. */
const HEADS_FILE = "chat-heads.json";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

/** A catalog that saves to `dir` at its stop, on a fake daemon that lists `box`. */
function catalogOver(t: TestContext, dir: string, box: SessionSummary[]): Catalog {
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }), null, null, join(dir, AGENTS_FILE));
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: box } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  return catalog;
}

const live = (id: string, sessionFile: string): SessionSummary => ({ sessionId: id, activeSessionId: `a-${id}`, cwd: "/tmp", messageCount: 2, firstMessage: "the daemon's text", sessionFile } as SessionSummary);

test("a stop saves what each listed session file's head said", async t => {
  const dir = mkdtempSync(join(tmpdir(), "heads-save-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "root.jsonl");
  writeFileSync(file, [{ type: "session", id: "s1" }, { type: "session_info", name: "named at create" }, { type: "session_state", state: "active" },
    { type: "message", message: { role: "user", content: "Fix the slow agents read" } }].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const catalog = catalogOver(t, dir, [live("s1", file)]);
  await catalog.refresh();
  const [row] = await catalog.rows();
  assert.equal(row?.origin, "agent");
  assert.equal(row?.name, "Fix the slow agents read");
  await catalog.close();
  const saved = JSON.parse(readFileSync(join(dir, HEADS_FILE), "utf8")) as { origins: Record<string, string>; firsts: Record<string, string>; titles: Record<string, string> };
  assert.equal(saved.origins[file], "agent");
  assert.equal(saved.firsts[file], "Fix the slow agents read");
  assert.equal(saved.titles[file], "Fix the slow agents read");
});

test("the next start takes the saved heads and reads no session file for them", async t => {
  const dir = mkdtempSync(join(tmpdir(), "heads-take-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A file this process never read, which is not on disk: only the saved heads can name its origin and title.
  const file = join(dir, "gone", "root.jsonl");
  writeFileSync(join(dir, HEADS_FILE), JSON.stringify({ savedAt: "2026-10-25T06:17:12Z", origins: { [file]: "agent" }, firsts: { [file]: "Saved task" }, titles: { [file]: "Saved title" } }));
  const catalog = catalogOver(t, dir, [live("s2", file)]);
  assert.equal(existsSync(join(dir, HEADS_FILE)), false, "the start deletes the file it took");
  await catalog.refresh();
  const [row] = await catalog.rows();
  assert.equal(row?.origin, "agent");
  assert.equal(row?.name, "Saved title");
  await catalog.close();
});
