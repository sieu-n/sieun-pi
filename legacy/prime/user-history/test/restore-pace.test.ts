// Replays the load.3.3 update restart on us-metal02 on 10-28 (10:21:50Z to 10:22:48Z), where the Prime SDK's restore loop of each attached
// thread listed and attached every 0.2 s: about 1,400 lists while the supervisor drained and restarted, then 418 attaches refused with
// "Session worker is starting", 46 to 67 for each of 7 sessions. The tests run the SDK's own loop on a fake connection and supervisor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DaemonAgentConnection } from "prime-agent";
import { paceRestores, restorePause } from "../src/restore-pace.ts";

const STARTING = "Session worker is starting";
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

/**
 * A supervisor that lists the session from `listedMs` and whose worker runs from `readyMs`, both after it was made. Its get_state to a
 * starting worker answers once the worker runs, as the real one did for 15,987 ms at 10:22:46Z.
 */
function supervisor(readyMs: number, listedMs = 0) {
  const born = Date.now();
  const calls = { list: 0, attach: 0, get_state: 0 };
  const since = () => Date.now() - born;
  const ready = () => since() >= readyMs;
  const client = {
    reconnect: async () => {},
    request: async (command: { type: string }) => {
      if (command.type === "list") {
        calls.list++;
        return { success: true, data: { sessions: since() >= listedMs ? [{ sessionId: "s1", sessionFile: "/s1.jsonl", activeSessionId: "a1" }] : [] } };
      }
      if (command.type === "get_state") { calls.get_state++; await sleep(Math.max(0, readyMs - since())); return { success: true, data: {} }; }
      throw new Error(`unexpected ${command.type}`);
    },
  };
  return { calls, client, ready, since };
}

type Daemon = ReturnType<typeof supervisor>;

/** The fields and methods the SDK's restore loop reads on `this`, with its loop taken from the real prototype. */
class FakeConnection {
  disposed = false;
  terminalCloseEmitted = false;
  updateRestartPending = true;
  sessionRevision = 0;
  attachedSessionId = "s1";
  attachedSessionFile = "/s1.jsonl";
  activeSessionId = "old";
  lastEventSequence: number | undefined;
  lastEventCursor: unknown;
  retiredEventGenerations = new Set<string>();
  attachedAt: number | undefined;
  constructor(readonly client: Daemon["client"], private readonly daemon: Daemon) {}
  async attach(): Promise<void> {
    this.daemon.calls.attach++;
    if (!this.daemon.ready()) throw Object.assign(new Error(STARTING), { name: "DaemonSessionUnavailableError" });
    this.attachedAt = this.daemon.since();
  }
  async getInitialSnapshot() { return { messages: [] }; }
  async emit(): Promise<void> {}
}
Reflect.set(FakeConnection.prototype, "restoreConnectionAfterDaemonRestart", Reflect.get(DaemonAgentConnection.prototype, "restoreConnectionAfterDaemonRestart"));

async function restore(daemon: Daemon): Promise<FakeConnection> {
  const connection = new FakeConnection(daemon.client, daemon);
  const run = Reflect.get(connection, "restoreConnectionAfterDaemonRestart") as (options: object) => Promise<boolean>;
  assert.equal(await run.call(connection, { timeoutMs: 120_000, retryMs: 100, updateRestart: true }), true);
  assert.equal(connection.activeSessionId, "a1");
  return connection;
}

test("a worker that starts for 1.5 s costs one refused attach and one get_state, and the attach lands as it runs", async t => {
  const undo = paceRestores(FakeConnection.prototype);
  t.after(() => undo?.());
  const daemon = supervisor(1_500);
  const connection = await restore(daemon);
  // The SDK's own loop attached and listed 16 times each here, one round every 100 ms.
  assert.deepEqual(daemon.calls, { list: 1, attach: 2, get_state: 1 });
  assert.ok(connection.attachedAt! - 1_500 < 200, `attached ${connection.attachedAt! - 1_500} ms after the worker ran`);
});

test("a session the draining supervisor does not list yet is listed at 250 ms, 500 ms, 1 s and then 2 s apart", async t => {
  const undo = paceRestores(FakeConnection.prototype);
  t.after(() => undo?.());
  const daemon = supervisor(1_200, 1_200);
  const connection = await restore(daemon);
  // Lists at 0, 0.25, 0.75 and 1.75 s; the SDK's own loop listed 13 times.
  assert.equal(daemon.calls.list, 4);
  assert.equal(daemon.calls.attach, 1);
  assert.ok(connection.attachedAt! < 1_200 + restorePause(3), `attached at ${connection.attachedAt} ms`);
});

test("an attach outside a restore is left alone: its refusal comes back at once, with no get_state", async t => {
  const undo = paceRestores(FakeConnection.prototype);
  t.after(() => undo?.());
  const daemon = supervisor(60_000);
  await assert.rejects(new FakeConnection(daemon.client, daemon).attach(), new RegExp(STARTING));
  assert.deepEqual(daemon.calls, { list: 0, attach: 1, get_state: 0 });
});

test("the Prime SDK still has the two methods, and a prototype without them is reported", () => {
  const undo = paceRestores();
  assert.ok(undo, "DaemonAgentConnection lost restoreConnectionAfterDaemonRestart or attach: restarts go back to 5 attaches a second per session");
  undo();
  assert.equal(paceRestores({}), null);
  assert.deepEqual([0, 1, 2, 3, 9].map(restorePause), [250, 500, 1_000, 2_000, 2_000]);
});
