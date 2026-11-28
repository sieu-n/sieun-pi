/**
 * `durable_submit` with `whenBusy: "reject"` puts nothing in a busy conversation's queue: it fails with "Conversation 1 is busy" and writes no
 * entry, and the same input to the idle conversation starts a run. apps/chat's stuck-step notice (server/step-owners.ts) is sent this way, so
 * its text is built at the moment its turn starts. On 11-28 two such notices sent as follow-ups waited 127 min and 51 min in devops guy's
 * queue and named its p150, which it had closed 2 min before they were placed.
 * Run: cd packages && node --import tsx --test --test-force-exit --test-isolation=none pi-host/test/durable/busy-reject.test.ts
 */
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { PLAIN_INPUT } from "./crash-scenario.ts";
import { HostClient } from "../../src/client.ts";
import type { HostCommand } from "../../src/protocol.ts";
import type { ThreadInfo } from "../../src/durable/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(here, "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "pi-host-busy-reject-"));
let host: ChildProcess | undefined;
after(() => {
  host?.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
});

const env = { ...process.env, FAKE_POOL_DIR: join(scratch, "pool"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
const call = <T>(client: HostClient, command: Record<string, unknown>, timeoutMs = 60_000) => client.call<T>(command as unknown as HostCommand, timeoutMs);
type Entry = { kind: string; data?: { via?: string } };
const NOTICE = { kind: "agent.message", data: { from: "board", via: "owners" } };

test("a whenBusy reject input is refused while the conversation runs and starts a run once it is idle", async () => {
  // The first run waits 3 s for its account slot, as vent's run did for 3 h 47 min on 11-07, so the conversation is busy when the notice comes.
  mkdirSync(join(scratch, "pool"));
  writeFileSync(join(scratch, "pool", "state.json"), JSON.stringify({ accounts: ["a1"], current: 0, waitSec: 3 }));
  const socket = join(scratch, "host.sock");
  host = spawn(process.execPath, ["--import", "tsx", join(here, "host-worker.ts"), socket, scratch, "faux"], { cwd: PACKAGES, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  host.stderr!.on("data", chunk => (stderr += String(chunk)));
  await new Promise<void>((resolve, reject) => {
    createInterface({ input: host!.stdout! }).on("line", line => (JSON.parse(line) as { event: string }).event === "ready" && resolve());
    host!.once("exit", code => reject(new Error(`pi-host exited ${code}:\n${stderr}`)));
  });
  const client = await HostClient.connect(socket);
  try {
    const { thread } = await call<{ thread: ThreadInfo }>(client, { type: "durable_create", name: "busy chat" });
    const notices = async () => (await call<{ entries: Entry[] }>(client, { type: "durable_entries", thread: thread.id, limit: 200 })).entries.filter(entry => entry.data?.via === "owners");
    const turn = await call<{ submission: number }>(client, { type: "durable_submit", thread: thread.id, text: PLAIN_INPUT });
    await assert.rejects(call(client, { type: "durable_submit", thread: thread.id, text: "[board] Nobody owns these: p150", whenBusy: "reject", requestId: "owners:busy:1", entry: NOTICE }),
      /Conversation 1 is busy/);
    assert.equal((await notices()).length, 0, "the refused notice wrote no entry");
    assert.equal((await call<{ settled: { status: string } }>(client, { type: "durable_wait", thread: thread.id, submission: turn.submission })).settled.status, "done", stderr);
    assert.equal((await notices()).length, 0, "and none was placed after the turn it was refused in");

    const told = await call<{ submission: number; status: string }>(client, { type: "durable_submit", thread: thread.id, text: PLAIN_INPUT, whenBusy: "reject", requestId: "owners:busy:2", entry: NOTICE });
    assert.equal(told.status, "placed", "the idle conversation takes it at once");
    assert.equal((await call<{ settled: { status: string } }>(client, { type: "durable_wait", thread: thread.id, submission: told.submission })).settled.status, "done", stderr);
    assert.equal((await notices()).length, 1);
  } finally {
    client.close();
  }
});
