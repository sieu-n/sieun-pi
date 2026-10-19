// Guards the 10-19 incident where owner turns on Mac sessions queued in the Mac's turn queue, because chat-backend.ts skipped the `pi-pool
// owner-turn` mark for a session on another host: the box's chat service is the only one, and the Mac's last mark was 10-18 13:19 KST.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownerTurnMarker } from "../src/chat-pool.ts";
import type { Host } from "../src/hosts.ts";

const MAC = { name: "mac", ssh: "sieunpark@100.66.173.18" } as Host;
const MAC_CHAT = "01a15427-145f-751d-ba15-d27b6c30f65f";
const BOX_CHAT = "01a11ba8-9d2c-727c-8ded-38f819ca9f29";

function marker(remote: (host: Host, id: string) => Promise<void>, waitMs?: number) {
  const calls: string[] = [], logged: string[] = [];
  const mark = ownerTurnMarker({ hostOf: id => id === MAC_CHAT ? MAC : null, local: async id => { calls.push(`local ${id}`); },
    remote: async (host, id) => { calls.push(`${host.name} ${id}`); await remote(host, id); }, log: line => { logged.push(line); }, ...waitMs === undefined ? {} : { waitMs } });
  return { mark, calls, logged };
}

test("the owner's send to a Mac chat marks the turn on the Mac, and a box chat's on the box", async () => {
  const { mark, calls } = marker(async () => {});
  await mark(MAC_CHAT);
  await mark(BOX_CHAT);
  assert.deepEqual(calls, [`mac ${MAC_CHAT}`, `local ${BOX_CHAT}`]);
});

test("a slow or failed mark on the other box never holds the send past its wait", async () => {
  const slow = marker(() => new Promise(() => {}), 50);
  const started = Date.now();
  await slow.mark(MAC_CHAT);
  assert.ok(Date.now() - started < 1000);
  const failed = marker(async () => { throw new Error("ssh mac: Connection timed out"); });
  await failed.mark(MAC_CHAT);
  assert.match(failed.logged[0]!, /owner turn for 01a15427 on mac: ssh mac: Connection timed out/);
});
