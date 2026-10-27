// Guards two incidents of the owner's sends to Mac chats. On 10-19 owner turns on Mac sessions queued in the Mac's turn queue, because the
// chat service skipped the `pi-pool owner-turn` mark for a session on another box. Its fix marked them over ssh before each send, and the daily
// check "Chat page from the Mac" read each Mac reply 5.2 round trips late at 22:06Z: the ssh took 0.6 to 0.9 s. The mark now rides on the prompt
// and the Mac's relay makes it locally; on 10-20 a relay that held the prompt for that local call still cost each send 89 to 98 ms.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { openDaemonTunnel, type Host } from "../src/hosts.ts";

const RELAY = "../../../../components/prime-relay/relay.mjs";
type Mark = (session: string) => Promise<void>;
const { createRelay } = await import(RELAY) as { createRelay: (config: { listen: string; port: number; daemonSocket: string; roots: string[]; token: string }, log?: (line: string) => void, options?: { markOwnerTurn?: Mark }) => Server };
const MAC_CHAT = "01a15427-145f-751d-ba15-d27b6c30f65f";
const BOX_CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";

async function hub(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "owner-turn-"));
  const files = new Map<string, string>();
  for (const id of [MAC_CHAT, BOX_CHAT]) {
    files.set(id, join(dir, id + ".jsonl"));
    await writeFile(files.get(id)!, JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-19T22:00:00.000Z", cwd: dir }) + "\n");
  }
  const events: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const client = (box: string) => ({ request: async (command: Record<string, unknown>) => { events.push(`${box} ${command.type}`); sent.push(command); return { success: true, data: undefined }; } });
  const catalog = { summary: async (id: string) => ({ sessionId: id, activeSessionId: `worker-${id.slice(0, 4)}`, workerState: "ready", sessionFile: files.get(id), cwd: dir, lifecycle: "live", messageCount: 0 }),
    hostOf: (id: string) => id === MAC_CHAT ? "mac" : null, connect: async () => {}, client: client("box"), hostClient: async () => client("mac") } as unknown as Catalog;
  const threads = new ThreadHub(join(dir, "none.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  threads.markOwnerTurn = async id => { events.push(`box mark ${id}`); };
  t.after(() => threads.close());
  return { threads, events, sent };
}

test("the owner's send to a Mac chat carries its owner-turn mark in the prompt, and a box chat's is marked on the box first", async t => {
  const { threads, events, sent } = await hub(t);
  await threads.prompt(MAC_CHAT, { message: "did you miss?", images: [], mode: "followUp", owner: true });
  await threads.prompt(BOX_CHAT, { message: "and you?", images: [], mode: "steer", owner: true });
  assert.deepEqual(events, ["mac prompt", `box mark ${BOX_CHAT}`, "box prompt"]);
  assert.equal(sent[0]!.ownerTurn, MAC_CHAT);
  assert.equal("ownerTurn" in sent[1]!, false);
});

test("a box chat's send never waits for its local mark", async t => {
  const { threads, events } = await hub(t);
  threads.markOwnerTurn = async id => { events.push(`box mark ${id}`); await new Promise(() => {}); };
  const started = Date.now();
  await threads.prompt(BOX_CHAT, { message: "now", images: [], mode: "steer", owner: true });
  assert.ok(Date.now() - started < 1000, `the send waited ${Date.now() - started} ms for a mark that never ends`);
  assert.deepEqual(events, [`box mark ${BOX_CHAT}`, "box prompt"]);
});

test("a check-in or job notice is no owner turn on either box", async t => {
  const { threads, events, sent } = await hub(t);
  await threads.prompt(MAC_CHAT, { message: "[check-in] status?", images: [], mode: "steer" });
  await threads.prompt(BOX_CHAT, { message: "[job] ended", images: [], mode: "steer" });
  assert.deepEqual(events, ["mac prompt", "box prompt"]);
  assert.equal(sent.some(command => "ownerTurn" in command), false);
});

async function relay(t: { after: (fn: () => unknown) => void }, mark: Mark) {
  const dir = await mkdtemp(join(tmpdir(), "owner-turn-relay-"));
  const daemonSocket = join(dir, "daemon.sock");
  const got: { at: number; line: string }[] = [];
  const daemon = createServer((client: Socket) => {
    let rest = "";
    client.on("data", chunk => {
      rest += chunk.toString("utf8");
      for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n")) { got.push({ at: Date.now(), line: rest.slice(0, end) }); rest = rest.slice(end + 1); }
    });
  });
  daemon.listen(daemonSocket);
  await once(daemon, "listening");
  const token = "t".repeat(40);
  await writeFile(join(dir, "token"), token + "\n");
  const logged: string[] = [];
  const server = createRelay({ listen: "127.0.0.1", port: 0, daemonSocket, roots: [], token }, line => { logged.push(line); }, { markOwnerTurn: mark });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const host: Host = { name: "mac", hostname: "mac", address: "127.0.0.1", relayPort: (server.address() as { port: number }).port, token: `file:${join(dir, "token")}`, daemonSocket, ssh: null, roles: {} };
  const tunnel = await openDaemonTunnel(host);
  t.after(() => { tunnel.destroy(); server.close(); daemon.close(); });
  const until = async (count: number) => { for (let wait = 0; got.length < count && wait < 600; wait++) await new Promise(resolve => setTimeout(resolve, 10)); };
  return { tunnel, got, logged, until };
}

const envelope = (id: string, command: Record<string, unknown>) => JSON.stringify({ type: "command", id, protocol: { name: "prime-daemon", version: 20 }, clientId: "box", command: { ...command, id } }) + "\n";

test("the relay passes the prompt on without the field and without waiting for its mark, which it starts, and keeps every line in order", async t => {
  const marks: string[] = [];
  const { tunnel, got, until } = await relay(t, session => { marks.push(session); return new Promise(() => {}); });
  const prompt = envelope("daemon_7", { type: "prompt", activeSessionId: "worker-01a1", message: "did you miss? \"ownerTurn\" é", source: "interactive", ownerTurn: MAC_CHAT });
  const read = envelope("daemon_8", { type: "get_state", activeSessionId: "worker-01a1" });
  const bytes = Buffer.from(envelope("daemon_6", { type: "list" }) + prompt + read);
  const started = Date.now();
  for (let at = 0; at < bytes.length; at += 7) tunnel.write(bytes.subarray(at, at + 7));
  await until(3);
  assert.ok(Date.now() - started < 1000, `the lines took ${Date.now() - started} ms behind a mark that never ends`);
  assert.deepEqual(got.map(entry => JSON.parse(entry.line).id), ["daemon_6", "daemon_7", "daemon_8"]);
  assert.deepEqual(marks, [MAC_CHAT]);
  const command = JSON.parse(got[1]!.line).command;
  assert.equal("ownerTurn" in command, false);
  assert.equal(command.message, "did you miss? \"ownerTurn\" é");
  assert.equal(got[2]!.line + "\n", read);
});

test("a failed mark is logged, and a line without the field passes byte for byte", async t => {
  const failed = await relay(t, async () => { throw new Error("pi-pool: turns.lock busy"); });
  const plain = envelope("daemon_2", { type: "prompt", activeSessionId: "w", message: "plain" });
  failed.tunnel.write(envelope("daemon_1", { type: "prompt", activeSessionId: "w", message: "hi", ownerTurn: MAC_CHAT }) + plain);
  await failed.until(2);
  for (let wait = 0; !failed.logged.length && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(failed.logged.join("\n"), /owner turn for 01a15427: pi-pool: turns.lock busy/);
  assert.equal(failed.got[1]!.line + "\n", plain);
});
