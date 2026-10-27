import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { HostClient } from "../src/client.ts";
import type { SessionSummary } from "../src/protocol.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("the CLI host survives an extension timer throw in one session, keeps the other answering, and exits clean on SIGTERM", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-host-cli-"));
  mkdirSync(join(root, "ws"), { recursive: true });
  const socket = join(root, "host.sock");
  const child = spawn(process.execPath, ["--import", "tsx", join(here, "../src/main.ts"), "--socket", socket, "--agent-dir", join(root, "agent"),
    "--session-dir", join(root, "sessions"), "--cwd", join(root, "ws"), "--extension", join(here, "fixtures/echo.ts"), "--model", "echo/m"], {
    env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stderr.on("data", chunk => { log += chunk; });
  const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
  try {
    for (let i = 0; i < 100 && !existsSync(socket); i++) await new Promise(resolve => setTimeout(resolve, 100));
    const client = await HostClient.connect(socket);
    const a = await client.call<SessionSummary>({ type: "create", config: {} } as never);
    const b = await client.call<SessionSummary>({ type: "create", config: {} } as never);
    for (const id of [a.activeSessionId, b.activeSessionId]) await client.call({ type: "attach", activeSessionId: id, capabilities: ["attach_snapshot", "event_sequence", "slim_attach"] });
    await client.call({ type: "prompt", activeSessionId: a.activeSessionId, message: "boom" });
    await client.waitForAgentEnd(a.activeSessionId);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.match(log, /uncaughtException kept the host up: extension timer boom/);
    await client.call({ type: "prompt", activeSessionId: b.activeSessionId, message: "still here" });
    await client.waitForAgentEnd(b.activeSessionId);
    const text = await client.call<{ text: string }>({ type: "get_last_assistant_text", activeSessionId: b.activeSessionId });
    assert.equal(text.text, "echo: still here");
    const closing = client.waitFor(line => line.type === "daemon_closing");
    child.kill("SIGTERM");
    await closing;
    assert.equal(await exited, 0);
    assert.equal(existsSync(socket), false);
    const locks = readdirSync(join(root, "sessions"), { recursive: true }).filter(name => String(name).endsWith(".lock"));
    assert.deepEqual(locks, []);
    client.close();
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
