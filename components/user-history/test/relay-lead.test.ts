// Guards the gap 80d21c04 left: the chat service wrote the turn queue's lead list only on us-metal02, so the queued runs of chats that run on the
// Mac waited behind every job run in the Mac's own queue. Each box now gets the chats it runs, the Mac's through its relay's POST /v1/lead.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { leadWriter } from "../src/chat-hosts.ts";
import type { Host } from "../src/hosts.ts";

const TOKEN = "t".repeat(40);
const MAC_CHAT = "01a15427-145f-751d-ba15-d27b6c30f65f";
const BOX_CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";
type Lead = (sessions: string[]) => Promise<void>;

async function relay(t: { after: (fn: () => unknown) => void }, lead: Lead): Promise<{ host: Host; base: string }> {
  const dir = await mkdtemp(join(tmpdir(), "relay-lead-"));
  await writeFile(join(dir, "token"), TOKEN + "\n");
  const relayModule = "../../prime-relay/relay.mjs";
  const { createRelay } = await import(relayModule) as { createRelay: (config: object, log?: unknown, options?: { lead?: Lead }) => Server };
  const server = createRelay({ listen: "127.0.0.1", port: 0, daemonSocket: join(dir, "none.sock"), roots: [], token: TOKEN }, () => {}, { lead });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, host: { name: "mac", hostname: "mac", address: "127.0.0.1", relayPort: port, token: `file:${join(dir, "token")}`, daemonSocket: "/tmp/none.sock", ssh: null, roles: {} } };
}

test("the relay's POST /v1/lead hands the session ids to this box's pi-pool lead, and refuses a line that is no session id", async t => {
  const calls: string[][] = [];
  const { base } = await relay(t, async sessions => { calls.push(sessions); });
  const headers = { authorization: `Bearer ${TOKEN}` };
  const set = await fetch(`${base}/v1/lead`, { method: "POST", body: `${MAC_CHAT}\n${BOX_CHAT}\n`, headers });
  assert.equal(set.status, 200);
  assert.deepEqual(await set.json(), { lead: [MAC_CHAT, BOX_CHAT] });
  const clear = await fetch(`${base}/v1/lead`, { method: "POST", body: "", headers });
  assert.equal(clear.status, 200);
  const bad = await fetch(`${base}/v1/lead`, { method: "POST", body: "a b; rm -rf /\n", headers });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/v1/lead`, { method: "POST", body: MAC_CHAT })).status, 401);
  assert.deepEqual(calls, [[MAC_CHAT, BOX_CHAT], []]);
});

test("the lead lists send a Mac chat's id to the Mac's relay and keep it out of this box's list, and a move writes both again", async t => {
  const mac: string[][] = [];
  let macDown = false;
  const { host } = await relay(t, async sessions => { if (macDown) throw new Error("pi-pool: remote pool refused the request"); mac.push(sessions); });
  const local: string[][] = [];
  const logged: string[] = [];
  const where = new Map([[MAC_CHAT, "mac"]]);
  const write = leadWriter({ hostOf: id => where.get(id) ?? null, remotes: () => [host], local: async ids => { local.push([...ids]); }, log: line => logged.push(line) });
  await write([MAC_CHAT, BOX_CHAT]);
  assert.deepEqual(local, [[BOX_CHAT]]);
  assert.deepEqual(mac, [[MAC_CHAT]]);
  await write([BOX_CHAT, MAC_CHAT]);
  assert.equal(local.length + mac.length, 2, "the same split writes nothing");
  where.delete(MAC_CHAT);
  await write([MAC_CHAT, BOX_CHAT]);
  assert.deepEqual(local.at(-1), [BOX_CHAT, MAC_CHAT].sort(), "the chat that moved here joins this box's list");
  assert.deepEqual(mac.at(-1), [], "and leaves the Mac's");
  where.set(MAC_CHAT, "mac");
  macDown = true;
  await write([MAC_CHAT, BOX_CHAT]);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /lead list on mac: relay mac answered 500/);
  macDown = false;
  await write([MAC_CHAT, BOX_CHAT]);
  assert.equal(logged.length, 1, "a row change neither retries nor logs again");
  assert.deepEqual(mac.at(-1), []);
  await write([MAC_CHAT, BOX_CHAT], true);
  assert.deepEqual(mac.at(-1), [MAC_CHAT], "a box that did not answer gets its list at the next chat list change");
  assert.deepEqual(local.at(-1), [BOX_CHAT], "which writes every box");
});
