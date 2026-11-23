/**
 * pi-ai's provider modules load before pi-host listens. On each start of 11-23 they loaded after it, and openai-responses alone held the loop
 * 142 to 198 ms while callers could already connect (host.log "provider modules loaded").
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = process.env.PI_HOST_MAIN ?? join(here, "../src/main.ts");

test("the provider modules line comes before the listening line", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-host-providers-"));
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  const socket = join(root, "host.sock");
  const child = spawn(process.execPath, ["--import", "tsx", MAIN, "--socket", socket, "--agent-dir", join(root, "agent"), "--session-dir", join(root, "sessions"),
    "--data-dir", join(root, "data"), "--cwd", ws, "--no-default-extensions", "--no-durable", "--extension", join(here, "fixtures/echo.ts")], {
    env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" }, stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr.on("data", chunk => { log += chunk; });
  try {
    for (let i = 0; i < 600 && !(existsSync(socket) && log.includes("listening on")); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(log.includes("listening on"), `pi-host did not listen:\n${log}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const providers = log.indexOf("provider modules loaded");
    assert.ok(providers >= 0, `no provider modules line:\n${log}`);
    assert.ok(providers < log.indexOf("listening on"), `the provider modules loaded after pi-host listened:\n${log}`);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
