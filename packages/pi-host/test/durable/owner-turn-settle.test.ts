/**
 * An owner input sent right after the conversation's last input settled still skips pi-pool's turn queue. The settle
 * gives the run's working slot back with `pi-pool release`, which trails the settle commit; the hook here makes that
 * release slow, so the next owner input always lands while turns.json still shows the old run working. On 10-28 the
 * live thread 118923a8 admitted an owner input 40 ms after a settle, set no mark, and the run queued 150 s.
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
const scratch = mkdtempSync(join(tmpdir(), "pi-host-owner-settle-"));
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
type Submitted = { submission: number; ticket: TurnTicket; owner?: { state: string; ahead?: boolean } };
type LogLine = { event?: string; session?: string; kind?: string; waited_s?: number };

test("an owner durable_submit right after the last input settled is admitted as kind owner", async () => {
  mkdirSync(poolDir, { recursive: true });
  // Turn-queue commands go to the real pi-pool CLI, and each release first sleeps 1 s, so the settle's release lands
  // after the next submit. A token request gets a fixed faux token.
  const bin = join(scratch, "pool-hook");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--cli" ]; then shift; if [ "$1" = "release" ]; then sleep 1; fi; exec /usr/bin/python3 -B '${POOL_CLI}' "$@"; fi\nprintf 'sk-ant-oat01-faux'\n`);
  chmodSync(bin, 0o755);
  poolRun("set", "agent_queue_on", "1");
  poolRun("set", "working_max", "1");
  const me = String(process.pid);
  assert.equal(pool("admit", "blocker", "--pid", me, "--tree", "busy").state, "admitted");
  assert.equal(pool("admit", "queued-1", "--pid", me, "--tree", "q1").state, "queued");

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
    const { thread } = await call<{ thread: ThreadInfo }>(client, { type: "durable_create", name: "owner run" });
    const first = await call<Submitted>(client, { type: "durable_submit", thread: thread.id, text: PLAIN_INPUT, ownerTurn: true });
    assert.deepEqual(first.owner, { state: "marked" });
    assert.equal((await call<{ settled: { status: string } }>(client, { type: "durable_wait", thread: thread.id, submission: first.submission })).settled.status, "done", stderr);

    const second = await call<Submitted>(client, { type: "durable_submit", thread: thread.id, text: PLAIN_INPUT, ownerTurn: true });
    assert.deepEqual(second.owner, { state: "marked" }, `the owner input after a settle got no mark: ${JSON.stringify(second)}`);
    const settled = await call<{ settled: { status: string } }>(client, { type: "durable_wait", thread: thread.id, submission: second.submission }, 20_000);
    assert.equal(settled.settled.status, "done", stderr);

    const session = first.ticket.session;
    const log = () => readFileSync(join(poolDir, "pi-pool.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as LogLine);
    const admits = log().filter(line => line.event === "turn_admitted" && line.session === session);
    assert.deepEqual(admits.map(line => line.kind), ["owner", "owner"], JSON.stringify(log().slice(-12)));
    assert.ok(admits.every(line => line.waited_s! < 1), JSON.stringify(admits));
    // Both slots go back, the line keeps its order, and no owner mark is left for a later agent run to take.
    const end = Date.now() + 10_000;
    let turns = JSON.parse(readFileSync(join(poolDir, "turns.json"), "utf8")) as { working: Record<string, unknown>; queued: Record<string, unknown>; owner: Record<string, unknown> };
    while (Object.keys(turns.working).length > 1 && Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 200));
      turns = JSON.parse(readFileSync(join(poolDir, "turns.json"), "utf8"));
    }
    assert.deepEqual(Object.keys(turns.working), ["blocker"]);
    assert.deepEqual(Object.keys(turns.queued), ["queued-1"]);
    assert.deepEqual(turns.owner, {});
    const released = log().filter(line => line.event === "turn_released" && line.session === session);
    assert.equal(released.length, 2, JSON.stringify(log().slice(-12)));
  } finally {
    client.close();
  }
});
