import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { HostClient } from "@sieun-pi/pi-host/client";
import type { SessionSummary } from "@sieun-pi/pi-host/protocol";
import { kernelHandler } from "@sieun-pi/pi-family/kernel-bridge";
import { body, runLoad, type LoadResult } from "./load.ts";
import { startHost, type RunningHost } from "./host-rig.ts";
import { landed, openAgent, type Opened } from "./rig.ts";

/**
 * The step 3 check through pi-host. pi-host runs as its own process with pi-agent-bus and the busy fixture loaded, and this process plays
 * two kinds of sender: plain `pi` sessions with PI_HOST_SOCKET set, whose kernel sends go through pi-agent-bus's socket route, and chat-style
 * socket clients that send `send_message` lines with no sender session.
 */

const SENDERS = Number(process.env.BUS_LOAD_SENDERS ?? 30);
const PER_SENDER = Number(process.env.BUS_LOAD_PER_SENDER ?? 20);

let root: string;
let host: RunningHost;
let client: HostClient;
const opened: Opened[] = [];

const create = (name: string) => client.call<SessionSummary>({ type: "create", name, lifecycle: "resident" } as never);
const state = (id: string) => client.call<SessionSummary>({ type: "get_state", activeSessionId: id } as never);
const streaming = async (id: string) => (await state(id)).isStreaming;

async function waitIdle(id: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await streaming(id)) {
    if (Date.now() > deadline) throw new Error(`session ${id} stayed busy`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function busyReceiver(name: string, ms: number): Promise<SessionSummary> {
  const receiver = await create(name);
  await client.call({ type: "prompt", activeSessionId: receiver.activeSessionId, message: `busy ${ms}` } as never);
  const deadline = Date.now() + 10_000;
  while (!(await streaming(receiver.activeSessionId))) {
    if (Date.now() > deadline) throw new Error("receiver never started");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return state(receiver.activeSessionId);
}

/** Polls the receiver's `isStreaming` over the socket, so `runLoad` can wait for the receiver to finish its run. */
function idleWatch(id: string): { idle: () => boolean; stop: () => void } {
  let idle = false;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      idle = !(await streaming(id));
    } finally {
      busy = false;
    }
  }, 100);
  return { idle: () => idle, stop: () => clearInterval(timer) };
}

function record(label: string, result: LoadResult & Record<string, unknown>): void {
  console.log(JSON.stringify({ label, ...result }));
  if (!process.env.BUS_LOAD_OUT) return;
  mkdirSync(dirname(process.env.BUS_LOAD_OUT), { recursive: true });
  writeFileSync(`${process.env.BUS_LOAD_OUT}-${label}.json`, `${JSON.stringify({ path: "pi-host", label, ...result }, null, 2)}\n`);
}

function assertClean(result: LoadResult): void {
  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted, SENDERS * PER_SENDER);
  assert.equal(result.unique, SENDERS * PER_SENDER);
  assert.equal(result.missing, 0);
  assert.equal(result.duplicates, 0);
  assert.equal(result.unexpected, 0);
  assert.equal(result.outOfOrderSenders, 0);
  assert.ok(result.receipts.queued > 0, "the receiver was busy for part of the burst");
}

before(async () => {
  root = mkdtempSync(join(process.env.BUS_LOAD_ROOT ?? tmpdir(), "agent-bus-host-"));
  host = await startHost(root);
  client = await HostClient.connect(host.socket);
  process.env.PI_HOST_SOCKET = host.socket;
});


after(async () => {
  delete process.env.PI_HOST_SOCKET;
  for (const s of opened) await s.runtime.dispose();
  client?.close();
  await host?.stop();
  if (process.env.BUS_LOAD_OUT) writeFileSync(`${process.env.BUS_LOAD_OUT}-host.log`, host?.log() ?? "");
  if (!process.env.BUS_LOAD_KEEP) rmSync(root, { recursive: true, force: true });
});

test(`${SENDERS} plain pi sessions send ${PER_SENDER} messages each through pi-host to one busy root, with no loss and no duplicate in its transcript`, { timeout: 300_000 }, async () => {
  for (let i = 0; i < SENDERS; i += 1) opened.push(await openAgent(root, `cli-${i}`));
  const receiver = await busyReceiver("receiver", 4000);
  const watch = idleWatch(receiver.activeSessionId);
  const result = await runLoad({
    senders: SENDERS,
    perSender: PER_SENDER,
    sendOne: (s, n, mode) =>
      Promise.resolve(kernelHandler(opened[s].id, "agent_message.send")!({ message: body(s, n), receiver_role: "sibling", receiver_name: "receiver", mode })) as never,
    receiverFile: () => receiver.sessionFile,
    receiverIdle: watch.idle,
  });
  watch.stop();
  const headers = new Set(landed(receiver.sessionFile).filter(m => m.message.startsWith("load ")).map(m => m.header.replace(/cli-\d+/, "cli-N")));
  record("cli-senders", { ...result, receiverFile: receiver.sessionFile, headers: [...headers] } as never);
  assertClean(result);
  assert.deepEqual([...headers], ["[agent-message from sibling:cli-N]"]);
});

test(`${SENDERS} socket clients with no sender session send ${PER_SENDER} messages each to one busy root, with no loss and no duplicate`, { timeout: 300_000 }, async () => {
  const receiver = await busyReceiver("receiver-2", 4000);
  const clients = await Promise.all(Array.from({ length: SENDERS }, () => HostClient.connect(process.env.PI_HOST_SOCKET!)));
  try {
    const watch = idleWatch(receiver.activeSessionId);
    const result = await runLoad({
      senders: SENDERS,
      perSender: PER_SENDER,
      sendOne: (s, n, mode) =>
        clients[s].call({ type: "send_message", targetActiveSessionId: receiver.activeSessionId, message: body(s, n), deliveryMode: mode } as never) as never,
      receiverFile: () => receiver.sessionFile,
      receiverIdle: watch.idle,
    });
    watch.stop();
    record("socket-clients", { ...result, receiverFile: receiver.sessionFile } as never);
    assertClean(result);
  } finally {
    for (const c of clients) c.close();
  }
});

test("a closed root shows as inactive and wakes in its own session when a plain pi session or a client messages it", async () => {
  const sleeper = await create("sleeper");
  await client.call({ type: "prompt", activeSessionId: sleeper.activeSessionId, message: "first task" } as never);
  await waitIdle(sleeper.activeSessionId);
  const file = (await state(sleeper.activeSessionId)).sessionFile!;
  await client.call({ type: "kill", activeSessionId: sleeper.activeSessionId } as never);
  const sender = opened[0] ?? (opened.push(await openAgent(root, "cli-0")), opened[0]);
  const list = await kernelHandler(sender.id, "agent_observe.list")!({}) as { agents: { sessionName: string; status: string; relationship: string }[] };
  const row = list.agents.find(a => a.sessionName === "sleeper");
  assert.deepEqual(row && [row.relationship, row.status], ["sibling", "inactive"]);
  const receipt = (await kernelHandler(sender.id, "agent_message.send")!({ message: "wake from cli", receiver_role: "sibling", receiver_name: "sleeper" })) as { deliveryStatus: string; target: { sessionId: string } };
  assert.equal(receipt.target.sessionId, sleeper.activeSessionId);
  assert.equal(receipt.deliveryStatus, "delivered");
  await waitIdle(sleeper.activeSessionId);
  assert.equal((await state(sleeper.activeSessionId)).sessionFile, file, "the wake reopened the same session file");
  await client.call({ type: "kill", activeSessionId: sleeper.activeSessionId } as never);
  await client.call({ type: "send_message", targetActiveSessionId: sleeper.activeSessionId, message: "wake from chat" } as never);
  await waitIdle(sleeper.activeSessionId);
  const got = landed(file);
  assert.deepEqual(got.map(m => [m.header, m.message]), [["[agent-message from sibling:cli-0]", "wake from cli"], [`[agent-message from ${got[1]?.fromName}]`, "wake from chat"]]);
  record("closed-root", { messages: got } as never);
});
