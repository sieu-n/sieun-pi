// 10-28 at 16:19Z d7 read a dirty minute from Mac daemon calls that timed out at 30 s while the Mac's supervisor had answered each in 1 to
// 6 ms (its calls log): the chat's one link to the Mac carried the 2,869-row full list that began at 16:18:20Z and took 102 s to cross, and the
// replies of get_state and the other commands on that link arrived behind it. The full list now goes through a client of its own.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { DaemonClient, SessionSummary } from "prime-agent";
import { SessionPeer } from "../src/session-peer.ts";

const row = (i: number): SessionSummary => ({ sessionId: `s-${i}`, cwd: "/w", sessionFile: `/s/${i}.jsonl`, messageCount: i, modified: "2026-10-28T16:00:00.000Z" }) as unknown as SessionSummary;

/** One daemon link: replies leave in the order the requests came, so a reply waits for every answer before it on the same link. */
type Reply = { success: true; data: { sessions?: SessionSummary[] } };
type Link = { client: DaemonClient; closed: () => boolean };

function link(fullListHeld: Promise<void>, log: string[], name: string): Link {
  let last: Promise<unknown> = Promise.resolve();
  let closed = false;
  const client = {
    isConnected: true,
    reconnect: async () => {}, waitForHello: async () => ({ appVersion: "0.9.8" }), resetTransportForReconnect: () => {},
    onMessage: () => () => {}, onClose: () => () => {}, close: () => { closed = true; },
    request: (command: { type: string; all?: boolean }): Promise<Reply> => {
      log.push(`${name} ${command.type}${command.all ? " all" : ""}`);
      const answer: Promise<Reply> = command.type === "list" && command.all ? fullListHeld.then(() => ({ success: true, data: { sessions: [row(1), row(2)] } }))
        : Promise.resolve({ success: true, data: command.type === "list" ? { sessions: [] } : {} });
      const reply = last.then(() => answer);
      last = reply;
      return reply;
    },
  };
  return { client: client as unknown as DaemonClient, closed: () => closed };
}

test("a command on the peer's link answers while a full list of the box is still crossing", async (t: TestContext) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const log: string[] = [];
  const shared = link(held, log, "shared");
  const own: Link[] = [];
  const peer = new SessionPeer({ name: "mac", client: shared.client, fullClient: () => { const made = link(held, log, "own"); own.push(made); return made.client; }, file: null,
    deadlines: { socketMs: 1000, helloMs: 1000 }, changeMs: 10_000, reconnectMs: 10_000, log: () => {}, onChange: () => {} });
  t.after(() => { release(); peer.close(); });
  const synced = peer.sync();
  await new Promise(resolve => setTimeout(resolve, 20));
  const state = shared.client.request({ type: "get_state" } as never).then(() => "answered");
  const first = await Promise.race([state, new Promise(resolve => setTimeout(() => resolve("waiting behind the full list"), 200))]);
  assert.equal(first, "answered", log.join(", "));
  release();
  await synced;
  assert.equal(peer.list().length, 2);
  assert.deepEqual(log.filter(line => line.endsWith("list all")), ["own list all"]);
  assert.equal(own.length, 1);
  assert.ok(own[0]!.closed(), "the full list's own client is closed once it answered");
});
