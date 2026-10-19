// Guards 10-19 01:14Z: release-9c2a7fd deferred the early shell's listen on fd 3, startChatServer then read a null server.address() and threw
// "Expected a loopback TCP address.", and sieun-pi-chat.service exited every 15 s while the server answered every request 421 "Unexpected host.".
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

const holder = `import os, socket, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(128)
os.dup2(s.fileno(), 3); os.set_inheritable(3, True)
os.environ["LISTEN_FDS"] = "1"; os.environ["LISTEN_PID"] = str(os.getpid())
os.execv(sys.argv[1], sys.argv[1:])`;

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false }, res => { let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body })); });
    req.on("error", reject); req.end();
  });
}

test("a service started on systemd's socket through the early shell's process comes up and answers its own loopback host", { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "early-serve-"));
  await writeFile(join(dir, "configuration.json"), JSON.stringify({ capability: "cap", csrfToken: "tok" }));
  const fixture = new URL("./fixtures/early-serve.mjs", import.meta.url).pathname;
  const main = spawn("python3", ["-c", holder, process.execPath, fixture, dir], { stdio: ["ignore", "pipe", "inherit"], detached: true, timeout: 30_000, killSignal: "SIGKILL" });
  t.after(() => { try { process.kill(-main.pid!, "SIGKILL"); } catch { /* gone */ } });
  const line = await new Promise<string>(resolve => {
    createInterface({ input: main.stdout! }).once("line", resolve);
    main.once("exit", code => resolve(`exited ${code}`));
  });
  assert.match(line, /^up http:\/\/127\.0\.0\.1:\d+\/cap\/$/);
  const identity = await get(line.slice(3) + "api/identity");
  assert.equal(identity.status, 200, identity.body);
  assert.equal(JSON.parse(identity.body).service, "sieun-pi-chat");
});
