// The agent relay's sleep hold: piHostWorking against a real pi-host child with a faux model reads a turn as running and then idle, and
// holdAwake starts one `caffeinate -i -s -w <relay pid>` for it, keeps it 2 min past the last work, then stops it. A fake spawn stands in for
// caffeinate, so the test runs on Linux too.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, mock, test } from "node:test";
import { holdAwakeForPiHost, piHostWorking } from "../agents/awake.ts";
import { PiHostSocket } from "../agents/pi-host-socket.ts";
import { holdAwake } from "../relay.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "agent-awake-"));
const socket = join(dir, "host.sock");
let worker;

before(async () => {
  worker = spawn(process.execPath, ["--import", "tsx", join(here, "pi-host-worker.ts"), socket, dir], { cwd: join(here, "../../../packages"), env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  worker.stderr.on("data", chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    createInterface({ input: worker.stdout }).on("line", line => { if (JSON.parse(line).event === "ready") resolve(); });
    worker.once("exit", code => reject(new Error(`pi-host exited ${code}:\n${stderr}`)));
  });
});

after(() => {
  worker?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

/** A spawn that records each call and returns a child whose kill() emits exit, as caffeinate does. */
function fakeSpawn() {
  const calls = [];
  const fn = (command, args) => {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit("exit", null, "SIGTERM"); return true; };
    calls.push({ command, args, child });
    return child;
  };
  return { fn, calls };
}

test("piHostWorking reads a turn as running while it streams and idle after it settles, and null with no pi-host", async () => {
  assert.equal(await piHostWorking(join(dir, "missing.sock")), null);
  assert.equal(await piHostWorking(socket), false);
  const direct = await PiHostSocket.open(socket);
  const thread = (await direct.call("durable_create", { name: "awake test" })).data.thread.id;
  const submitted = await direct.call("durable_submit", { thread, text: "SLOW hello", requestId: "d:p1:ag_awake" });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(await piHostWorking(socket), true);

  const spawned = fakeSpawn();
  const hold = holdAwakeForPiHost(socket, () => {}, { platform: "darwin", spawn: spawned.fn });
  await hold.check();
  assert.equal(spawned.calls.length, 1);
  assert.deepEqual(spawned.calls[0].args, ["-i", "-s", "-w", String(process.pid)]);
  assert.equal(spawned.calls[0].command, "caffeinate");

  assert.equal((await direct.call("durable_wait", { thread, submission: submitted.data.submission })).ok, true);
  for (let tries = 0; (await piHostWorking(socket)) !== false; tries++) {
    assert.ok(tries < 100, "the thread never read idle after its turn settled");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await hold.check();
  assert.equal(spawned.calls[0].child.killed, false, "the hold stays for 2 min after the last work");
  hold.stop();
  assert.equal(spawned.calls[0].child.killed, true);
  direct.close();
});

test("holdAwake starts one caffeinate, keeps it 2 min past the last work, starts again on new work, and does nothing off macOS", async () => {
  assert.deepEqual(Object.keys(holdAwake("/nowhere", () => {}, { platform: "linux", working: async () => { throw new Error("read on linux"); } })), ["check", "stop"]);
  mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  try {
    let busy = true;
    const spawned = fakeSpawn();
    const hold = holdAwake("/nowhere", () => {}, { platform: "darwin", working: async () => busy, spawn: spawned.fn });
    await hold.check();
    await hold.check();
    assert.equal(spawned.calls.length, 1);
    busy = false;
    mock.timers.tick(119_000);
    await hold.check();
    assert.equal(spawned.calls[0].child.killed, false);
    mock.timers.tick(1_000);
    await hold.check();
    assert.equal(spawned.calls[0].child.killed, true);
    busy = null;
    await hold.check();
    assert.equal(spawned.calls.length, 1, "no answer from pi-host starts no hold");
    busy = true;
    await hold.check();
    assert.equal(spawned.calls.length, 2);
    spawned.calls[1].child.emit("exit", 0, null);
    await hold.check();
    assert.equal(spawned.calls.length, 3, "a caffeinate that exits on its own is started again while work runs");
    hold.stop();
    assert.equal(spawned.calls[2].child.killed, true);
  } finally {
    mock.timers.reset();
  }
});
