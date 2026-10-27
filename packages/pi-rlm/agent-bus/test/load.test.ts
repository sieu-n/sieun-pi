import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { kernelHandler } from "@sieun-pi/pi-family/kernel-bridge";
import { body, runLoad } from "./load.ts";
import { openAgent, until, type Opened } from "./rig.ts";

const SENDERS = Number(process.env.BUS_LOAD_SENDERS ?? 30);
const PER_SENDER = Number(process.env.BUS_LOAD_PER_SENDER ?? 20);

async function check(label: string, busyFirst: boolean, jitterMs: number) {
  const root = mkdtempSync(join(process.env.BUS_LOAD_ROOT ?? tmpdir(), "agent-bus-load-"));
  const receiver = await openAgent(root, "receiver");
  const senders: Opened[] = [];
  for (let i = 0; i < SENDERS; i += 1) senders.push(await openAgent(root, `sender-${i}`));
  const run = busyFirst ? receiver.runtime.session.prompt("busy 3000") : Promise.resolve();
  if (busyFirst) await until(() => receiver.runtime.session.isStreaming);
  const result = await runLoad({
    senders: SENDERS,
    perSender: PER_SENDER,
    sendOne: (s, n, mode) => Promise.resolve(kernelHandler(senders[s].id, "agent_message.send")!({ message: body(s, n), receiver_role: "sibling", receiver_name: "receiver", mode })) as never,
    receiverFile: receiver.file,
    receiverIdle: () => !receiver.runtime.session.isStreaming,
    jitterMs,
  });
  await run;
  if (process.env.BUS_LOAD_OUT) {
    mkdirSync(join(process.env.BUS_LOAD_OUT, ".."), { recursive: true });
    writeFileSync(`${process.env.BUS_LOAD_OUT}-${label}.json`, `${JSON.stringify({ path: "in-process", label, busyFirst, jitterMs, receiverFile: receiver.file(), ...result }, null, 2)}\n`);
  }
  console.log(JSON.stringify(result));
  for (const s of [receiver, ...senders]) await s.runtime.dispose();
  if (!process.env.BUS_LOAD_KEEP) rmSync(root, { recursive: true, force: true });
  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted, SENDERS * PER_SENDER);
  assert.equal(result.missing, 0);
  assert.equal(result.duplicates, 0);
  assert.equal(result.unexpected, 0);
  assert.equal(result.unique, SENDERS * PER_SENDER);
  assert.equal(result.outOfOrderSenders, 0);
  assert.ok(result.receipts.queued > 0, "the receiver was busy for at least part of the burst");
  return result;
}

test(`${SENDERS} senders send ${PER_SENDER} messages each to one busy receiver in-process, with no loss and no duplicate in its transcript`, { timeout: 300_000 }, async () => {
  await check("busy", true, 0);
});

test("the same load with sends spread over time reaches an idle receiver while it starts, runs and settles", { timeout: 300_000 }, async () => {
  const result = await check("idle-jitter", false, 60);
  assert.ok(result.receipts.delivered > 0, "some sends found the receiver idle");
});
