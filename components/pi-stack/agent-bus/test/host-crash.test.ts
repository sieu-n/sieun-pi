import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { HostClient } from "../../host/src/client.ts";
import type { SessionSummary } from "../../host/src/protocol.ts";
import { body, MODES } from "./load.ts";
import { startHost } from "./host-rig.ts";
import { landed, until } from "./rig.ts";

const SENDERS = Number(process.env.BUS_LOAD_SENDERS ?? 30);
const PER_SENDER = Number(process.env.BUS_LOAD_PER_SENDER ?? 20);

test(`pi-host is killed with SIGKILL during a ${SENDERS} x ${PER_SENDER} burst, and after a restart every accepted message lands once`, { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(process.env.BUS_LOAD_ROOT ?? tmpdir(), "agent-bus-crash-"));
  let host = await startHost(root, "h");
  const client = await HostClient.connect(host.socket);
  const receiver = await client.call<SessionSummary>({ type: "create", name: "receiver", lifecycle: "resident" } as never);
  const id = receiver.activeSessionId;
  await client.call({ type: "prompt", activeSessionId: id, message: "busy 8000" } as never);
  let file: string | undefined;
  for (let i = 0; i < 100 && !file; i += 1) {
    const st = await client.call<SessionSummary>({ type: "get_state", activeSessionId: id } as never);
    if (st.isStreaming && st.sessionFile && existsSync(st.sessionFile)) file = st.sessionFile;
    else await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(file, "the receiver is busy and has a session file");
  const clients = await Promise.all(Array.from({ length: SENDERS }, () => HostClient.connect(host.socket)));
  const accepted = new Map<string, string>();
  const rejected: string[] = [];
  const killAfterMs = Number(process.env.BUS_CRASH_AFTER_MS ?? 700);
  const t0 = Date.now();
  const killer = new Promise<void>(resolve => setTimeout(async () => { await host.stop("SIGKILL"); resolve(); }, killAfterMs));
  await Promise.all(
    clients.map(async (c, s) => {
      for (let n = 0; n < PER_SENDER; n += 1) {
        await new Promise(resolve => setTimeout(resolve, Math.random() * 80));
        try {
          const r = await c.call<{ id: string }>({ type: "send_message", targetActiveSessionId: id, message: body(s, n), deliveryMode: MODES[s % MODES.length] } as never, 3000);
          accepted.set(r.id, body(s, n));
        } catch (error) {
          rejected.push(`${body(s, n)}: ${(error as Error).message}`);
        }
      }
    }),
  );
  await killer;
  for (const c of clients) c.close();
  client.close();
  const beforeRestart = landed(file).filter(m => m.message.startsWith("load ")).length;
  const queuedOnDisk = existsSync(join(root, "h", "agent", "agent-bus", "inbox", `${id}.jsonl`));

  host = await startHost(root, "h");
  const t1 = Date.now();
  await until(() => [...accepted.keys()].every(m => landed(file).some(x => x.id === m)), 60_000, "every accepted message after the restart");
  const after = await HostClient.connect(host.socket);
  for (let st = await after.call<SessionSummary>({ type: "get_state", activeSessionId: id } as never); st.isStreaming; st = await after.call<SessionSummary>({ type: "get_state", activeSessionId: id } as never)) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const replayMs = Date.now() - t1;
  await new Promise(resolve => setTimeout(resolve, 300));
  const got = landed(file).filter(m => m.message.startsWith("load "));
  const counts = new Map<string, number>();
  for (const m of got) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
  const result = {
    sent: SENDERS * PER_SENDER,
    accepted: accepted.size,
    rejectedAfterKill: rejected.length,
    landedBeforeRestart: beforeRestart,
    inboxOnDiskAfterKill: queuedOnDisk,
    landed: got.length,
    unique: counts.size,
    duplicates: [...counts.values()].reduce((a, c) => a + c - 1, 0),
    acceptedMissing: [...accepted.keys()].filter(m => !counts.has(m)).length,
    landedWithoutReceipt: [...counts.keys()].filter(m => !accepted.has(m)).length,
    killAfterMs,
    burstMs: t1 - t0,
    replayMs,
    recovered: host.log().split("\n").filter(l => /queued agent messages/.test(l)),
    inboxLeft: existsSync(join(root, "h", "agent", "agent-bus", "inbox", `${id}.jsonl`)),
    receiverFile: file,
  };
  console.log(JSON.stringify(result));
  if (process.env.BUS_LOAD_OUT) {
    mkdirSync(dirname(process.env.BUS_LOAD_OUT), { recursive: true });
    writeFileSync(`${process.env.BUS_LOAD_OUT}-host-crash.json`, `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(`${process.env.BUS_LOAD_OUT}-host-crash.log`, host.log());
  }
  after.close();
  await host.stop();
  if (!process.env.BUS_LOAD_KEEP) rmSync(root, { recursive: true, force: true });
  assert.ok(accepted.size > 0 && rejected.length > 0, "the kill fell inside the burst");
  assert.equal(beforeRestart, 0, "nothing had landed before the kill, so every accepted message was only queued");
  assert.ok(queuedOnDisk);
  assert.equal(result.acceptedMissing, 0);
  assert.equal(result.duplicates, 0);
  assert.equal(result.inboxLeft, false);
  assert.equal(result.recovered.length, 1, "the restarted host restored the receiver on its own");
});
