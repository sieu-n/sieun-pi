/**
 * An owner's durable_submit skips pi-pool's turn queue: a real pool/turns.py queue in its own PI_POOL_DIR, one working
 * slot held and two runs queued, then an agent input that queues third and an owner input with `ownerTurn: true` that
 * answers while the queue still waits. Both answers carry the run's ticket, and durable_ticket reads it again.
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
import { PLAIN_INPUT } from "./crash-scenario.ts";
import { HostClient } from "../../src/client.ts";
import type { HostCommand } from "../../src/protocol.ts";
import type { ThreadInfo } from "../../src/durable/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(here, "..", "..", "..");
const POOL_CLI = join(PACKAGES, "pi-pool", "bin", "pi-pool");
const scratch = mkdtempSync(join(tmpdir(), "pi-host-owner-turn-"));
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
type Submitted = { submission: number; requestId: string; status: string; ticket: TurnTicket; owner?: { state: string; ahead?: boolean } };

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

test("an owner durable_submit behind queued work is admitted first and returns its pool ticket", async () => {
  mkdirSync(poolDir, { recursive: true });
  // The token hook: turn-queue commands go to the real pi-pool CLI (exec keeps the caller's pid as the admit's pid), and a
  // token request gets a fixed faux token, which the faux model ignores.
  const bin = join(scratch, "pool-hook");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--cli" ]; then shift; exec /usr/bin/python3 -B '${POOL_CLI}' "$@"; fi\nprintf 'sk-ant-oat01-faux'\n`);
  chmodSync(bin, 0o755);
  poolRun("set", "agent_queue_on", "1");
  poolRun("set", "working_max", "1");
  const me = String(process.pid);
  assert.equal(pool("admit", "blocker", "--pid", me, "--tree", "busy").state, "admitted");
  assert.equal(pool("admit", "queued-1", "--pid", me, "--tree", "q1").state, "queued");
  assert.equal(pool("admit", "queued-2", "--pid", me, "--tree", "q2").state, "queued");

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
    const { thread: agent } = await call<{ thread: ThreadInfo }>(client, { type: "durable_create", name: "agent run" });
    const agentSent = await call<Submitted>(client, { type: "durable_submit", thread: agent.id, text: PLAIN_INPUT });
    assert.equal(agentSent.ticket.tree, `pi-durable:${agent.id}`);
    assert.equal(agentSent.owner, undefined);
    const agentQueued = await until(() => call<{ ticket: TurnTicket }>(client, { type: "durable_ticket", thread: agent.id }), r => r.ticket.place.state === "queued", "the agent run never queued");
    assert.deepEqual(agentQueued.ticket, { session: agentSent.ticket.session, tree: `pi-durable:${agent.id}`, place: { state: "queued", position: 3, total: 3 } });

    const { thread: mine } = await call<{ thread: ThreadInfo }>(client, { type: "durable_create", name: "owner run" });
    const ownerSent = await call<Submitted>(client, { type: "durable_submit", thread: mine.id, text: PLAIN_INPUT, ownerTurn: true });
    assert.deepEqual(ownerSent.owner, { state: "marked" });
    assert.equal(ownerSent.ticket.tree, `pi-durable:${mine.id}`);
    assert.ok(["marked", "working"].includes(ownerSent.ticket.place.state), JSON.stringify(ownerSent.ticket));
    const settled = await call<{ settled: { status: string } }>(client, { type: "durable_wait", thread: mine.id, submission: ownerSent.submission }, 30_000);
    assert.equal(settled.settled.status, "done", stderr);

    const log = readFileSync(join(poolDir, "pi-pool.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { event?: string; session?: string; kind?: string; waited_s?: number });
    const ownerAdmit = log.find(line => line.event === "turn_admitted" && line.session === ownerSent.ticket.session);
    assert.equal(ownerAdmit?.kind, "owner", JSON.stringify(log.slice(-8)));
    assert.ok(ownerAdmit!.waited_s! < 1, JSON.stringify(ownerAdmit));
    // The slot goes back right after the settle commit, so the release can trail durable_wait a little.
    const queue = await until(async () => pool("queue", "--json") as { working: { session: string }[]; queued: { session: string }[] },
      q => q.working.length === 1, "the owner's slot never went back after its input settled");
    assert.deepEqual(queue.working.map(w => w.session), ["blocker"]);
    assert.deepEqual(queue.queued.map(q => q.session), ["queued-1", "queued-2", agentSent.ticket.session], "the owner went first, and the line kept its order");

    const { usage } = await call<{ usage: Record<string, unknown>[] }>(client, { type: "durable_usage", threads: [mine.id] });
    assert.equal(usage.length, 1, JSON.stringify(usage));
    for (const key of ["cost", "costInput", "costOutput", "costCacheRead", "costCacheWrite"]) assert.equal(typeof usage[0]![key], "number", `${key} in ${JSON.stringify(usage[0])}`);

    pool("release", "queued-1");
    pool("release", "queued-2");
    pool("release", "blocker");
    const agentDone = await call<{ settled: { status: string } }>(client, { type: "durable_wait", thread: agent.id, submission: agentSent.submission }, 30_000);
    assert.equal(agentDone.settled.status, "done", stderr);
    const agentAdmit = readFileSync(join(poolDir, "pi-pool.log"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { event?: string; session?: string; kind?: string })
      .find(line => line.event === "turn_admitted" && line.session === agentSent.ticket.session);
    assert.equal(agentAdmit?.kind, "slot");
  } finally {
    client.close();
  }
});
