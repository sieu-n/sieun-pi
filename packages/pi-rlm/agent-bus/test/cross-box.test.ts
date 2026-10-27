import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { HostClient } from "../../../pi-host/src/client.ts";
import type { SessionSummary } from "../../../pi-host/src/protocol.ts";
import { kernelHandler } from "@sieun-pi/pi-family/kernel-bridge";
import { BOXES_ENV } from "../src/host-socket.ts";
import { body, runLoad } from "./load.ts";
import { startHost, startRelay, type RunningHost, type RunningRelay } from "./host-rig.ts";
import { landed, openAgent, until, type Opened } from "./rig.ts";

/**
 * Cross-box sends: two pi-host processes play box a and box b, each behind its own scratch prime-relay (relay.mjs unchanged), and this test
 * process plays box c with plain pi sessions. pi-agent-bus on each box lists the other boxes' roots through their relays and sends to them
 * with send_message through the relay tunnel.
 */

const SENDERS = Number(process.env.BUS_LOAD_SENDERS ?? 30);
const PER_SENDER = Number(process.env.BUS_LOAD_PER_SENDER ?? 20);

let root: string;
let hostA: RunningHost, hostB: RunningHost;
let relayA: RunningRelay, relayB: RunningRelay;
let a: HostClient, b: HostClient;
const opened: Opened[] = [];

const state = (c: HostClient, id: string) => c.call<SessionSummary>({ type: "get_state", activeSessionId: id } as never);
async function idle(c: HostClient, id: string): Promise<void> {
  for (let i = 0; i < 1200; i += 1) {
    if (!(await state(c, id)).isStreaming) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${id} stayed busy`);
}
async function rootOn(c: HostClient, name: string): Promise<SessionSummary> {
  const s = await c.call<SessionSummary>({ type: "create", name, lifecycle: "resident" } as never);
  await c.call({ type: "prompt", activeSessionId: s.activeSessionId, message: "hi" } as never);
  await idle(c, s.activeSessionId);
  return state(c, s.activeSessionId);
}
async function say(c: HostClient, id: string, text: string): Promise<void> {
  await c.call({ type: "prompt", activeSessionId: id, message: text } as never);
  await idle(c, id);
}

function boxesFile(self: string): string {
  const file = join(root, `boxes-${self}.json`);
  writeFileSync(file, JSON.stringify({ self, boxes: [{ name: "a", url: relayA.url, tokenFile: relayA.tokenFile }, { name: "b", url: relayB.url, tokenFile: relayB.tokenFile }] }));
  return file;
}

before(async () => {
  root = mkdtempSync(join(process.env.BUS_LOAD_ROOT ?? tmpdir(), "agent-bus-boxes-"));
  for (const box of ["a", "b"]) mkdirSync(join(root, box, "sessions"), { recursive: true });
  relayA = await startRelay(root, "a", join(root, "a", "host.sock"));
  relayB = await startRelay(root, "b", join(root, "b", "host.sock"));
  hostA = await startHost(root, "a", { [BOXES_ENV]: boxesFile("a") });
  hostB = await startHost(root, "b", { [BOXES_ENV]: boxesFile("b") });
  a = await HostClient.connect(hostA.socket);
  b = await HostClient.connect(hostB.socket);
  process.env[BOXES_ENV] = boxesFile("c");
});

after(async () => {
  delete process.env[BOXES_ENV];
  for (const s of opened) await s.runtime.dispose();
  a?.close();
  b?.close();
  for (const p of [hostA, hostB, relayA, relayB]) await p?.stop();
  if (process.env.BUS_LOAD_OUT) {
    writeFileSync(`${process.env.BUS_LOAD_OUT}-boxes-host-a.log`, hostA.log());
    writeFileSync(`${process.env.BUS_LOAD_OUT}-boxes-host-b.log`, hostB.log());
    writeFileSync(`${process.env.BUS_LOAD_OUT}-boxes-relays.log`, relayA.log() + relayB.log());
  }
  if (!process.env.BUS_LOAD_KEEP) rmSync(root, { recursive: true, force: true });
});

test("a root on box a and a root on box b message each other through the relays, and a closed root on box b wakes", async () => {
  const alice = await rootOn(a, "alice");
  const bob = await rootOn(b, "bob");
  await say(a, alice.activeSessionId, "send bob hello bob, from box a");
  await until(() => landed(bob.sessionFile).some(m => m.message === "hello bob, from box a"), 30_000, "bob got alice's message");
  const toBob = landed(bob.sessionFile).find(m => m.message === "hello bob, from box a")!;
  assert.equal(toBob.header, "[agent-message from sibling:alice]");
  const aliceTool = readFileSync(alice.sessionFile!, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).find(e => e.message?.role === "toolResult" && e.message?.toolName === "bus_send");
  assert.equal(aliceTool.message.details.host, "b");
  assert.equal(aliceTool.message.details.crossHost, true);
  await idle(b, bob.activeSessionId);
  await say(b, bob.activeSessionId, "send alice hi alice, from box b");
  await until(() => landed(alice.sessionFile).some(m => m.message === "hi alice, from box b" && m.header === "[agent-message from sibling:bob]"), 30_000, "alice got bob's reply");
  await idle(a, alice.activeSessionId);

  await b.call({ type: "kill", activeSessionId: bob.activeSessionId } as never);
  await say(a, alice.activeSessionId, "send bob wake up on box b");
  await until(() => landed(bob.sessionFile).some(m => m.message === "wake up on box b"), 30_000, "closed bob woke");
  await idle(b, bob.activeSessionId);

  const c0 = await openAgent(root, "cli-c");
  opened.push(c0);
  const list = (await kernelHandler(c0.id, "agent_observe.list")!({})) as { agents: { sessionName: string; host?: string; relationship: string; crossHost?: boolean }[] };
  const rows = Object.fromEntries(list.agents.map(r => [r.sessionName, `${r.relationship}@${r.host}`]));
  assert.equal(rows.alice, "sibling@a");
  assert.equal(rows.bob, "sibling@b");
  const counts = (file: string | undefined) => landed(file).map(m => m.message);
  record("boxes-exchange", { bob: landed(bob.sessionFile), alice: landed(alice.sessionFile), roster: list.agents });
  assert.equal(counts(bob.sessionFile).filter(m => m === "hello bob, from box a").length, 1);
});

function record(label: string, data: unknown): void {
  console.log(JSON.stringify({ label, data }).slice(0, 2000));
  if (!process.env.BUS_LOAD_OUT) return;
  mkdirSync(dirname(process.env.BUS_LOAD_OUT), { recursive: true });
  writeFileSync(`${process.env.BUS_LOAD_OUT}-${label}.json`, `${JSON.stringify(data, null, 2)}\n`);
}

test(`${SENDERS} plain pi sessions on box c send ${PER_SENDER} messages each through box b's relay to one busy root, with no loss and no duplicate`, { timeout: 600_000 }, async () => {
  for (let i = opened.length; i < SENDERS; i += 1) opened.push(await openAgent(root, `cli-c-${i}`));
  const carol = await rootOn(b, "carol");
  await b.call({ type: "prompt", activeSessionId: carol.activeSessionId, message: "busy 4000" } as never);
  for (let i = 0; i < 100 && !(await state(b, carol.activeSessionId)).isStreaming; i += 1) await new Promise(resolve => setTimeout(resolve, 20));
  let carolIdle = false;
  const poll = setInterval(async () => { carolIdle = !(await state(b, carol.activeSessionId).catch(() => ({ isStreaming: true }))).isStreaming; }, 150);
  const result = await runLoad({
    senders: SENDERS,
    perSender: PER_SENDER,
    sendOne: (s, n, mode) =>
      Promise.resolve(kernelHandler(opened[s].id, "agent_message.send")!({ message: body(s, n), receiver_role: "sibling", receiver_name: "carol", mode })) as never,
    receiverFile: () => carol.sessionFile,
    receiverIdle: () => carolIdle,
    drainTimeoutMs: 300_000,
  });
  clearInterval(poll);
  record("boxes-load", { ...result, receiverFile: carol.sessionFile });
  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted, SENDERS * PER_SENDER);
  assert.equal(result.unique, SENDERS * PER_SENDER);
  assert.equal(result.duplicates, 0);
  assert.equal(result.missing, 0);
  assert.equal(result.unexpected, 0);
  assert.equal(result.outOfOrderSenders, 0);
});
