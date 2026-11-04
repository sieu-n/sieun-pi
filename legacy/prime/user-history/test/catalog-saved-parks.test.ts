// Guards the 11-04 owner ask to cut the chat's main thread ("F*UCKING WATCH THIS"): after the catalog's rows went incremental, the live chat's
// 14 chats still built all 3,065 of their agents on each of 81 projections a minute, and stat'ed the session file of every one not at work
// (about 2,800, mostly saved roots and finished steps) for a slot-park wait that only a session's worker can write.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import type { RosterUpdate } from "../src/session-peer.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const START = Date.parse("2026-11-04T06:00:00Z");
const ROOTS = 40;

/** A chat s0 whose rlm.create_session roots are s1 to s40, saved, and s41, which has a worker; the daemon lists them and s42 to s59. */
async function chatWithRoots(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "catalog-saved-parks-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const row = (n: number, fields: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: `s${n}`, cwd: "/tmp", sessionFile: join(dir, `s${n}.jsonl`),
    sessionName: `thread ${n}`, messageCount: 3, lastActivityAt: new Date(START - n * 1000).toISOString(), ...fields }) as SessionSummary;
  const rows = new Map<string, SessionSummary>();
  for (let n = 0; n < 60; n++) {
    await writeFile(join(dir, `s${n}.jsonl`), `${JSON.stringify({ type: "message", timestamp: new Date(START).toISOString(), message: { role: "user", content: "task" } })}\n`);
    rows.set(`s${n}`, row(n, n === 0 || n === ROOTS + 1 ? { activeSessionId: `a-s${n}` } : {}));
  }
  const reads = new ChatReadState("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  const labels = new ChatLabels("unused");
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const roots = Array.from({ length: ROOTS + 1 }, (_, at) => `s${at + 1}`);
  const empty = { children: [], board: null, roots: [], messages: [] };
  const chats = { ids: async () => new Set(["s0"]), checkIns: async () => new Map(), archivedIds: async () => new Set<string>(),
    links: async (id: string) => id === "s0" ? { ...empty, roots } : empty };
  const catalog = new Catalog("unused", reads, labels, chats, new ThreadOrigins({ ids: async () => [] }));
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string; all?: boolean }) => command.type !== "list" ? { success: true, data: { jobs: [] } }
    : { success: true, data: { sessions: [...rows.values()].filter(entry => command.all || entry.activeSessionId !== undefined) } });
  Object.defineProperty(catalog.client as unknown as Record<string, unknown>, "isConnected", { get: () => connected });
  const internals = catalog as unknown as { peer: { onRoster(update: RosterUpdate): void }; apply(): Promise<void> };
  const roster = async (summary: SessionSummary) => {
    rows.set(summary.sessionId, summary);
    internals.peer.onRoster({ changed: [{ agentId: summary.sessionId, status: summary.activeSessionId ? "idle" : "saved", summary }] } as RosterUpdate);
    await internals.apply();
  };
  // The session files each projection stats, by file name.
  const stats = t.mock.method(fs, "statSync");
  syncBuiltinESMExports();
  t.after(() => { stats.mock.restore(); syncBuiltinESMExports(); });
  const statted = async (): Promise<string[]> => {
    const before = stats.mock.callCount();
    const event = await catalog.event();
    assert.equal(event.sessions.find(entry => entry.id === "s0")?.agents?.length, ROOTS + 1);
    return stats.mock.calls.slice(before).map(call => String(call.arguments[0])).filter(path => path.startsWith(dir)).map(path => path.slice(dir.length + 1));
  };
  return { catalog, row, roster, statted };
}

test("a projection stats no saved agent's session file it read before, only the files of agents with a worker", async (t: TestContext) => {
  const { catalog, row, roster, statted } = await chatWithRoots(t);
  await catalog.refresh();
  const first = await statted();
  assert.ok(first.filter(name => name !== `s${ROOTS + 1}.jsonl`).length >= ROOTS, `the first projection read the saved roots' files (${first.length} stats)`);
  await roster(row(50, { sessionName: "renamed" }));
  const second = await statted();
  assert.deepEqual(second.filter(name => name !== `s${ROOTS + 1}.jsonl`), [], `a projection after an unrelated change stat'ed ${second.length} files: ${second.join(" ")}`);
  assert.ok(second.includes(`s${ROOTS + 1}.jsonl`), "the agent with a worker is read on each projection, since its worker may write a wait");
  // A saved root the daemon sends again is a new row object, so its file is read again once.
  await roster(row(7, { sessionName: "renamed root" }));
  assert.ok((await statted()).includes("s7.jsonl"));
  assert.deepEqual((await statted()).filter(name => name !== `s${ROOTS + 1}.jsonl`), []);
});

test("a chat's agents that did not change come out as the last projection's objects", async (t: TestContext) => {
  const { catalog, row, roster } = await chatWithRoots(t);
  await catalog.refresh();
  const agentsOf = async () => (await catalog.event()).sessions.find(entry => entry.id === "s0")!.agents!;
  const before = await agentsOf();
  await roster(row(9, { sessionName: "renamed root" }));
  const after = await agentsOf();
  const changed = after.filter(agent => !before.includes(agent)).map(agent => agent.sessionId);
  assert.deepEqual(changed, ["s9"]);
  assert.equal(after.find(agent => agent.sessionId === "s9")?.name, "renamed root");
});
