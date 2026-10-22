// Guards the daemon list read the duty and check-in scripts share: a late hello costs a second read, and no script reads the list another way.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { daemonList, daemonSend, listRows } from "../src/daemon-list.ts";

const HANDSHAKE = "Timed out after 3000ms waiting for the Prime Agent daemon handshake. Socket: /tmp/prime-agent-1001/daemon.sock.";

test("a daemon read that fails once is read again with the same options, and two failures name both errors", async () => {
  const seen: unknown[] = [];
  const flaky = async (options: unknown) => { seen.push(options); if (seen.length === 1) throw new Error(HANDSHAKE); return { sessions: [{ sessionId: "s1" }] }; };
  assert.deepEqual(listRows<{ sessionId: string }>(await daemonList({ all: true }, flaky)).map(row => row.sessionId), ["s1"]);
  assert.deepEqual(seen, [{ all: true }, { all: true }]);
  let calls = 0;
  await assert.rejects(daemonList({}, async () => { calls++; throw new Error(HANDSHAKE); }), /failed twice: .*handshake.*; .*handshake/);
  assert.equal(calls, 2);
  assert.deepEqual(listRows([{ sessionId: "s2" }]), [{ sessionId: "s2" }]);
});

/** Every script file under scripts/, walked. */
async function scripts(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? scripts(join(dir, entry.name)) : [/\.(ts|mts|mjs|js)$/.test(entry.name) ? join(dir, entry.name) : ""]));
  return nested.flat().filter(Boolean);
}

test("no script reads the daemon's list through the CLI or its own DaemonClient, which wait only 3 s for the hello", async () => {
  const root = join(import.meta.dirname, "..", "scripts");
  const direct = /new DaemonClient\(|["'][^"']*prime-agent["']\s*,\s*\[\s*["'](list|sessions)["']|\.bin["'],\s*["']prime-agent["']/;
  const offenders: string[] = [];
  for (const file of await scripts(root)) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, index) => { if (direct.test(line)) offenders.push(`${file.slice(root.length + 1)}:${index + 1}`); });
  }
  assert.deepEqual(offenders, [], "read the list with daemonList from src/daemon-list.ts");
});

test("a send opens the daemon a second time after a missed hello, and never sends twice", async () => {
  const sent: unknown[] = [];
  const client = { async request(command: unknown) { sent.push(command); return { success: true, data: { deliveryStatus: "delivered" } }; }, close() {} };
  let opens = 0;
  const open = async () => { if (opens++ === 0) throw new Error(HANDSHAKE); return client as never; };
  assert.deepEqual(await daemonSend("s1", "continue", open), { deliveryStatus: "delivered" });
  assert.equal(opens, 2);
  assert.deepEqual(sent, [{ type: "send_message", targetActiveSessionId: "s1", message: "continue" }]);
  const failing = { async request(command: unknown) { sent.push(command); throw new Error("Timed out after 30000ms waiting for the Prime Agent daemon response"); }, close() {} };
  await assert.rejects(daemonSend("s2", "continue", async () => failing as never), /response/);
  assert.equal(sent.length, 2);
});
