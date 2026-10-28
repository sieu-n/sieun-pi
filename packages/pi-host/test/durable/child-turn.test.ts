/**
 * A child conversation's turn-queue wait ends on time while its root waits on it: a real pool/turns.py queue in its own
 * PI_POOL_DIR with two working slots, one held by a blocker, so the root's run takes the other and its subagent's first
 * ask queues. Releasing the blocker gives the child the slot, and the child must send its request and answer within
 * seconds. The root's subagent tool call keeps the file's wake active the whole time, so only a timer at the child's
 * sleep wakes its poll and its retry.
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { TurnTicket } from "@sieun-pi/pi-pool/durable";
import { FAUX_CHILD_ANSWER, FAUX_FINAL, INPUT } from "./crash-scenario.ts";
import { HostClient } from "../../src/client.ts";
import type { HostCommand } from "../../src/protocol.ts";
import type { ThreadInfo, TreeNode } from "../../src/durable/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(here, "..", "..", "..");
const POOL_CLI = join(PACKAGES, "pi-pool", "bin", "pi-pool");
const scratch = mkdtempSync(join(tmpdir(), "pi-host-child-turn-"));
let host: ChildProcess | undefined;
after(() => {
  host?.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
});

const poolDir = join(scratch, "pool");
const env = { ...process.env, PI_POOL_DIR: poolDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
const poolRun = (...args: string[]) => execFileSync("/usr/bin/python3", ["-B", POOL_CLI, ...args], { env, encoding: "utf8" });
const pool = (...args: string[]) => JSON.parse(poolRun(...args).trim().split("\n").at(-1)!) as Record<string, unknown>;
const call = <T>(client: HostClient, command: Record<string, unknown>, timeoutMs = 60_000) => client.call<T>(command as unknown as HostCommand, timeoutMs);
type Submitted = { submission: number; ticket: TurnTicket };
type LogLine = { event?: string; session?: string; kind?: string; ts?: string };
const poolLog = () => readFileSync(join(poolDir, "pi-pool.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as LogLine);

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

test("a queued child conversation sends its request and answers within seconds of getting its slot", async t => {
  mkdirSync(poolDir, { recursive: true });
  const bin = join(scratch, "pool-hook");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--cli" ]; then shift; exec /usr/bin/python3 -B '${POOL_CLI}' "$@"; fi\nprintf 'sk-ant-oat01-faux'\n`);
  chmodSync(bin, 0o755);
  poolRun("set", "agent_queue_on", "1");
  poolRun("set", "working_max", "2");
  assert.equal(pool("admit", "blocker", "--pid", String(process.pid), "--tree", "busy").state, "admitted");

  const socket = join(scratch, "host.sock");
  host = spawn(process.execPath, ["--import", "tsx", join(here, "host-worker.ts"), socket, scratch, "faux"], { cwd: PACKAGES, env: { ...env, HOST_WORKER_POOL_BIN: bin }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  host.stderr!.on("data", chunk => (stderr += String(chunk)));
  await new Promise<void>((resolve, reject) => {
    createInterface({ input: host!.stdout! }).on("line", line => (JSON.parse(line) as { event: string }).event === "ready" && resolve());
    host!.once("exit", code => reject(new Error(`pi-host exited ${code}:\n${stderr}`)));
  });
  const client = await HostClient.connect(socket);
  try {
    const { thread } = await call<{ thread: ThreadInfo }>(client, { type: "durable_create", name: "root with a child" });
    const sent = await call<Submitted>(client, { type: "durable_submit", thread: thread.id, text: INPUT });
    const child = await until(() => call<{ conversations: TreeNode[] }>(client, { type: "durable_tree", thread: thread.id }),
      r => r.conversations.some(c => c.parent !== null), "the root never created its child conversation");
    const childId = child.conversations.find(c => c.parent !== null)!.id;
    const queued = await until(() => call<{ ticket: TurnTicket }>(client, { type: "durable_ticket", thread: thread.id, conversation: childId }),
      r => r.ticket.place.state === "queued", "the child's first ask never queued");
    // A few polls of the child pass while it waits, each a sleep under the root's running tool call.
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal(poolLog().filter(line => line.event === "turn_admitted" && line.session === queued.ticket.session).length, 0, "the child started before the blocker let go");

    const released = Date.now();
    pool("release", "blocker");
    const settled = await call<{ settled: { status: string } }>(client, { type: "durable_wait", thread: thread.id, submission: sent.submission }, 20_000)
      .catch(error => assert.fail(`the root never settled after the child got its slot: ${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(poolLog().slice(-6))}\n${stderr.slice(-4000)}`));
    const tookMs = Date.now() - released;
    assert.equal(settled.settled.status, "done", stderr);
    assert.ok(tookMs < 15_000, `the root settled ${tookMs} ms after the child got its slot`);
    t.diagnostic(`the root settled ${tookMs} ms after the blocker let go`);

    const childAdmit = poolLog().find(line => line.event === "turn_admitted" && line.session === queued.ticket.session);
    assert.equal(childAdmit?.kind, "slot", JSON.stringify(poolLog().slice(-10)));
    const { entries: childEntries } = await call<{ entries: { kind: string; model?: { role?: string; content?: unknown }[] }[] }>(client, { type: "durable_entries", thread: thread.id, conversation: childId, limit: 50 });
    const childText = JSON.stringify(childEntries);
    assert.ok(childText.includes(JSON.stringify(FAUX_CHILD_ANSWER).slice(1, 40)), "the child answered");
    const { entries: rootEntries } = await call<{ entries: unknown[] }>(client, { type: "durable_entries", thread: thread.id, limit: 50 });
    const rootText = JSON.stringify(rootEntries);
    assert.ok(rootText.includes(FAUX_FINAL), "the root answered after the child");
    assert.ok(rootText.includes(JSON.stringify(FAUX_CHILD_ANSWER).slice(1, 40)), "the root got the child's answer as the tool result");
    const queue = await until(async () => pool("queue", "--json") as { working: { session: string }[]; queued: { session: string }[] },
      q => q.working.length === 0 && q.queued.length === 0, "a slot was never given back after the input settled");
    assert.deepEqual(queue, { ...queue, working: [], queued: [] });
  } finally {
    client.close();
  }
});
