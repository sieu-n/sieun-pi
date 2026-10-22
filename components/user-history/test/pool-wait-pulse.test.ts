// Guards the 10-22 hand stop: chat-2572 stopped a child it took for a dead stream while the child waited 179th in pi-pool's turn queue, since
// every view showed a queued run as working with no activity.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { PoolStatusReader, treeAccountWaits, type PoolSnapshot } from "../src/chat-pool.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";
import { childDetail } from "../src/client/children.ts";
import { clockText } from "../src/shared/clock.ts";
import { readPulse } from "../src/shared/pulse.ts";
import type { ChildAgent, Pulse, QueuePlace } from "../src/shared/types.ts";

const NOW = Date.parse("2026-10-22T14:05:00.000Z");
const QUIET = "2026-10-22T13:40:00.000Z";

test("a run that waits in the turn queue reads waiting with its place, not stalled or failed", () => {
  const pulse: Pulse = { streaming: true, tools: false, bash: false, children: false, activityAt: QUIET, wait: { kind: "turn", position: 3, total: 135, since: NOW - 60_000 } };
  assert.deepEqual(readPulse(pulse, NOW), { level: "waiting", quietMs: 25 * 60_000, text: "waiting for a turn, place 3 of 135" });
  const retried: Pulse = { ...pulse, summary: "pi-pool: this session waits for its slot, retrying", summaryCurrent: true, wait: { kind: "account", until: NOW + 30 * 60_000 } };
  assert.deepEqual(readPulse(retried, NOW), { level: "waiting", quietMs: 25 * 60_000, text: "waiting for an account until " + clockText(NOW + 30 * 60_000, NOW) });
  assert.equal(readPulse({ ...pulse, wait: { kind: "prime", label: "a turn, place 3 of 7" } }, NOW).text, "waiting for a turn, place 3 of 7");
  assert.equal(readPulse({ ...pulse, failed: true }, NOW).level, "failed", "a failed worker still reads failed");
  const { wait: _, ...plain } = pulse;
  assert.equal(readPulse(plain, NOW).level, "stalled", "with no wait the quiet run still reads stalled");
});

test("a waiting subagent's row leads with its wait", () => {
  const child = { id: "sub-1", label: "job", status: "running", activity: { kind: "waiting" } } as ChildAgent;
  const reading = readPulse({ streaming: true, tools: false, bash: false, children: false, activityAt: QUIET, wait: { kind: "turn", position: 2, total: 9, since: NOW } }, NOW);
  assert.deepEqual(childDetail(child, reading), { lead: "Waiting for a turn, place 2 of 9", text: "", tone: "quiet" });
});

function catalogOf(t: TestContext, box: SessionSummary[]): Catalog {
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
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: [...box] } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  return catalog;
}

const ROOT = "01a162bc-47b4-770b-a9fc-19c3a742e730";
const CHILD = "01a16080-9d5a-760e-b602-e96935211a97";
const ASLEEP = "01a16086-04ab-702a-90d8-40382aa57b6d";
const PRIMED = "01a16409-84a3-7446-96fa-e649d5a10230";
const anthropic = { provider: "anthropic", id: "claude-opus-4-5" } as SessionSummary["model"];
const row = (sessionId: string, more: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId, activeSessionId: sessionId.slice(-12), cwd: "/tmp", sessionName: sessionId.slice(0, 8),
  messageCount: 3, rosterStatus: "running", activity: "working", isStreaming: true, isCompacting: false, lastActivityAt: QUIET, model: anthropic, ...more }) as SessionSummary;

test("the rows carry the queue place, the account wait and Prime's own label on their pulses", async (t: TestContext) => {
  const box = [row(ROOT), row(CHILD, { parentSessionId: ROOT, rlmChildId: "sub-1", runtimeKind: "subagent" }), row(ASLEEP, { isStreaming: false }),
    { ...row(PRIMED), waitingFor: "a turn, place 3 of 7" } as SessionSummary];
  const catalog = catalogOf(t, box);
  const place = (position: number): QueuePlace => ({ position, total: 179, since: NOW - 60_000 });
  catalog.queueSource = async () => new Map([[ROOT, place(179)], [CHILD, place(12)], [PRIMED, place(40)]]);
  const asked: unknown[] = [];
  catalog.accountWaitSource = asks => { asked.push(...asks); return new Map([[ASLEEP, NOW + 3_600_000]]); };
  await catalog.refresh();
  const rows = new Map((await catalog.event()).sessions.map(entry => [entry.id, entry]));
  assert.deepEqual(rows.get(ROOT)?.pulse?.wait, { kind: "turn", ...place(179) });
  assert.deepEqual(rows.get(ROOT)?.pulse?.subagents.map(child => child.wait), [{ kind: "turn", ...place(12) }]);
  assert.deepEqual(rows.get(ASLEEP)?.pulse?.wait, { kind: "account", until: NOW + 3_600_000 });
  assert.deepEqual(rows.get(PRIMED)?.pulse?.wait, { kind: "prime", label: "a turn, place 3 of 7" }, "Prime's label wins over the pool's place");
  assert.deepEqual(asked, [{ session: ASLEEP, tree: ASLEEP, provider: "anthropic" }], "only a run asleep before its model call is asked about");
});

test("treeAccountWaits answers from the shared reader's last reading and asks for the trees in its next tick", async () => {
  const who = (slotAt: number) => ({ code: 0, err: "", out: JSON.stringify({ providers: { anthropic: { account: null, wait: { account: "claude8", slot_at: slotAt } } } }) });
  const ls = { code: 0, out: "{}", err: "" };
  const reads: string[][] = [];
  const reader = new PoolStatusReader(async (threads): Promise<PoolSnapshot> => {
    reads.push(threads.map(thread => thread.session ?? ""));
    return { queue: ls, config: ls, threads: threads.map(thread => ({ ...thread, who: who((NOW + 1_800_000) / 1000), ls: { anthropic: ls, "openai-codex": ls } })) };
  }, 2000, () => NOW, async () => {});
  const asks = [{ session: ASLEEP, tree: ROOT, provider: "anthropic" }, { session: CHILD, tree: ROOT, provider: "openai-codex" }];
  assert.deepEqual(treeAccountWaits(asks, NOW, reader), new Map(), "nothing read yet answers none at once");
  await reader.current([{ session: ROOT, model: null }]);
  assert.deepEqual(reads, [[ROOT]]);
  assert.deepEqual(treeAccountWaits(asks, NOW, reader), new Map([[ASLEEP, NOW + 1_800_000]]), "the wait is for the asleep session's own provider");
  assert.deepEqual(treeAccountWaits(asks, NOW + 1_800_000, reader), new Map(), "a slot that came is no wait");
});
